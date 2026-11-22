import {
  ScanPhase,
  VersionStatus,
  type ChartFinding,
  type ChartUpgrade,
  type CveFinding,
  type ImageFinding,
  type ScanPhaseValue,
  type VulnerabilityChange,
} from '@chart-monitor/shared';
import { resolveApplicationSets } from '../argocd/findApplicationSets.js';
import { withWarningPrefix, type ApplicationSource, type ScanContext } from '../argocd/types.js';
import { fetchChartVersions, normalizeChartRepoUrl } from '../helm/chartVersions.js';
import { compareVersions, findLatestVersion } from '../helm/versionCompare.js';
import { findImages, renderChart, showChartValues } from '../helm/renderChart.js';
import { diffManifests, diffVulnerabilities, removedValueKeys } from '../helm/upgradeCheck.js';
import { collectValuesDocuments } from '../argocd/valueFiles.js';
import { expandUmbrellaChart, type ChartToScan } from '../argocd/umbrellaChart.js';
import { createRepoOpener } from '../git/repoSnapshot.js';
import { fetchImageTags } from '../registry/imageRef.js';
import { scanImageForVulnerabilities, type ImageVulnerability } from '../trivy/scanImage.js';
import { mapWithConcurrency } from '../utils/concurrency.js';
import { env } from '../config/env.js';

// Each trivy scan pulls image layers and runs full vuln-DB matching — cap how many run at once
const CVE_SCAN_CONCURRENCY = 4;
// Chart version lookups and `helm template` runs are mostly network-bound
const CHART_CONCURRENCY = 4;

/** Error message plus the most telling line of a failed CLI's stderr (helm/trivy wrap the
 * child-process error as `cause`). */
function describeError(error: unknown): string {
  const message = (error as Error).message;
  const stderr = ((error as { cause?: { stderr?: string } }).cause?.stderr ?? '').trim();
  const detail = (stderr.split('\n').find((line) => /error/i.test(line)) ?? stderr.split('\n')[0])
    // Drop log timestamps so the same failure dedupes into one warning
    ?.replace(/^\d{4}-\d\d-\d\dT\S+\s+/, '');
  return detail ? `${message}: ${detail.slice(0, 300)}` : message;
}

async function resolveChartFinding(
  applicationName: string,
  applicationSetName: string,
  source: ApplicationSource & { chart: string; targetRevision: string },
): Promise<ChartFinding> {
  const versions = await fetchChartVersions(source.repoURL, source.chart).catch(() => []);
  const latestVersion = findLatestVersion(versions, env.INCLUDE_PRERELEASES);

  return {
    applicationName,
    applicationSetName,
    chartName: source.chart,
    repoUrl: source.repoURL,
    currentVersion: source.targetRevision,
    latestVersion,
    status: compareVersions(source.targetRevision, latestVersion),
    note: latestVersion ? null : 'Could not determine published chart versions',
  };
}

async function resolveImageFindings(
  applicationName: string,
  images: string[],
): Promise<ImageFinding[]> {
  return Promise.all(
    images.map(async (image): Promise<ImageFinding> => {
      const [repository, currentTag = 'latest'] = splitImageTag(image);
      const tags = await fetchImageTags(image).catch(() => []);
      const latestTag = findLatestVersion(tags, env.INCLUDE_PRERELEASES);

      return {
        applicationName,
        image: repository,
        currentTag,
        latestTag,
        status: latestTag ? compareVersions(currentTag, latestTag) : VersionStatus.UNKNOWN,
        note: latestTag ? null : 'Tag is not semver, or the registry does not expose a tag list',
        vulnerabilitiesScanned: false,
      };
    }),
  );
}

function splitImageTag(image: string): [string, string?] {
  const withoutDigest = image.split('@')[0] as string;
  const lastSlash = withoutDigest.lastIndexOf('/');
  const lastColon = withoutDigest.lastIndexOf(':');
  if (lastColon > lastSlash) {
    return [withoutDigest.slice(0, lastColon), withoutDigest.slice(lastColon + 1)];
  }
  return [withoutDigest];
}

/** Everything but the vulnerabilities, which need the latest version's images scanned first */
async function checkUpgrade(
  job: ChartJob,
  manifests: unknown[],
  latestVersion: string,
): Promise<{ upgrade: ChartUpgrade; latestImages: string[] | null }> {
  const latest = { ...job.source, targetRevision: latestVersion };
  const [oldDefaults, newDefaults] = await Promise.all([
    showChartValues(job.source),
    showChartValues(latest),
  ]);
  const removedValues = removedValueKeys(job.valuesDocuments, oldDefaults, newDefaults);
  try {
    const latestManifests = await renderChart(latest, job.valuesDocuments);
    return {
      upgrade: {
        removedValues,
        manifestChanges: diffManifests(manifests, latestManifests),
        renderError: null,
        vulnerabilities: null,
      },
      latestImages: findImages(latestManifests),
    };
  } catch (error) {
    return {
      upgrade: {
        removedValues,
        manifestChanges: [],
        renderError: describeError(error),
        vulnerabilities: null,
      },
      latestImages: null,
    };
  }
}

/** The app's CVEs, or null if any of its images couldn't be scanned */
function vulnerabilitiesOf(
  images: string[],
  scanned: Map<string, ImageVulnerability[] | null>,
): VulnerabilityChange[] | null {
  const perImage = images.map((image) => ({ image, found: scanned.get(image) }));
  if (perImage.some(({ found }) => !found)) return null;
  return perImage.flatMap(({ image, found }) =>
    found!.map(({ vulnerabilityId, pkgName, severity, title }) => ({
      vulnerabilityId,
      pkgName,
      severity,
      title,
      image: splitImageTag(image)[0],
    })),
  );
}

/** Every chart an application deploys: `chart:` sources directly, plus the remote dependencies of
 * umbrella charts referenced by git `path:` sources. */
async function collectChartsToScan(
  sources: ApplicationSource[],
  ctx: ScanContext,
): Promise<ChartToScan[]> {
  const perSource = await Promise.all(
    sources.map(async (source): Promise<ChartToScan[]> => {
      if (!source.chart) {
        return expandUmbrellaChart(source, sources, ctx).catch((error) => {
          ctx.warn(`source ${source.repoURL} could not be read: ${(error as Error).message}`);
          return [];
        });
      }
      return [{ source, valuesDocuments: await collectValuesDocuments(source, sources, ctx) }];
    }),
  );
  return perSource.flat().map(({ source, valuesDocuments }) => ({
    source: { ...source, repoURL: normalizeChartRepoUrl(source.repoURL) },
    valuesDocuments,
  }));
}

/** Receives progress and findings while a scan runs, so results show up as soon as they exist
 * instead of all at the end. */
export interface ScanReporter {
  /** Starts a step; `total` is its number of items (0 if not countable) */
  phase(phase: ScanPhaseValue, total?: number): Promise<unknown>;
  /** One item of the current step finished */
  step(detail: string): Promise<unknown>;
  chartFinding(finding: ChartFinding): Promise<unknown>;
  chartUpgrade(
    chart: { applicationName: string; chartName: string },
    upgrade: ChartUpgrade,
  ): Promise<unknown>;
  imageFindings(findings: ImageFinding[]): Promise<unknown>;
  /** The vulnerability scan of one image finished (`cves` may be empty) */
  imageScanned(image: { repository: string; tag: string }, cves: CveFinding[]): Promise<unknown>;
  /** All warnings so far (deduplicated, in discovery order) */
  warnings(warnings: string[]): Promise<unknown>;
}

interface ChartJob {
  applicationName: string;
  applicationSetName: string;
  ctx: ScanContext;
  source: ApplicationSource & { chart: string; targetRevision: string };
  valuesDocuments: string[];
}

export async function executeScan(
  input: { repoUrl: string; searchPath?: string; ref?: string },
  reporter: ScanReporter,
): Promise<void> {
  const warnings = new Set<string>();
  const { openRepo, cleanup } = createRepoOpener({
    githubToken: env.GITHUB_TOKEN,
    credentials: env.GIT_CREDENTIALS,
  });
  const ctx: ScanContext = { openRepo, warn: (message) => warnings.add(message) };
  const flushWarnings = () => reporter.warnings([...warnings]);

  try {
    await reporter.phase(ScanPhase.CLONING);
    const repo = await openRepo(input.repoUrl, input.ref);

    await reporter.phase(ScanPhase.RESOLVING);
    const prefix = input.searchPath?.replace(/^\/+/, '');
    const yamlPaths = repo.files.filter(
      (path) => /\.ya?ml$/i.test(path) && (!prefix || path.startsWith(prefix)),
    );
    const files = await Promise.all(
      yamlPaths.map(async (path) => ({ path, content: await repo.read(path) })),
    );
    const applications = await resolveApplicationSets(files, ctx);

    const jobs: ChartJob[] = [];
    for (const app of applications) {
      const appCtx = withWarningPrefix(ctx, `Application "${app.applicationName}"`);
      for (const { source, valuesDocuments } of await collectChartsToScan(app.sources, appCtx)) {
        if (!source.chart || !source.targetRevision) {
          appCtx.warn(`chart "${source.chart}" has no targetRevision, skipped`);
          continue;
        }
        jobs.push({
          applicationName: app.applicationName,
          applicationSetName: app.applicationSetName,
          ctx: appCtx,
          source: source as ChartJob['source'],
          valuesDocuments,
        });
      }
    }
    await flushWarnings();

    // Cheap step first, so chart versions are visible long before the slow image scans finish
    await reporter.phase(ScanPhase.CHART_VERSIONS, jobs.length);
    const chartFindings = await mapWithConcurrency(jobs, CHART_CONCURRENCY, async (job) => {
      const finding = await resolveChartFinding(
        job.applicationName,
        job.applicationSetName,
        job.source,
      );
      await reporter.chartFinding(finding);
      await reporter.step(`${job.applicationName} (${job.source.chart})`);
      return finding;
    });

    await reporter.phase(ScanPhase.IMAGES, jobs.length);
    const appImages = await mapWithConcurrency(jobs, CHART_CONCURRENCY, async (job) => {
      const manifests = await renderChart(job.source, job.valuesDocuments).catch((error) => {
        job.ctx.warn(`images could not be determined: ${describeError(error)}`);
        return null;
      });
      const images = findImages(manifests ?? []);
      await reporter.imageFindings(await resolveImageFindings(job.applicationName, images));
      await reporter.step(`${job.applicationName} (${job.source.chart})`);
      return { applicationName: job.applicationName, images, manifests };
    });
    await flushWarnings();

    const upgrades = jobs.flatMap((job, i) => {
      const { status, latestVersion } = chartFindings[i] as ChartFinding;
      const { manifests, images } = appImages[i]!;
      return status === VersionStatus.OUTDATED && latestVersion && manifests
        ? [{ job, manifests, images, latestVersion }]
        : [];
    });
    await reporter.phase(ScanPhase.UPGRADES, upgrades.length);
    const checked = await mapWithConcurrency(
      upgrades,
      CHART_CONCURRENCY,
      async ({ job, manifests, images, latestVersion }) => {
        const chart = { applicationName: job.applicationName, chartName: job.source.chart };
        const result = await checkUpgrade(job, manifests, latestVersion).catch((error) => {
          job.ctx.warn(`upgrade to ${latestVersion} could not be checked: ${describeError(error)}`);
          return null;
        });
        if (result) await reporter.chartUpgrade(chart, result.upgrade);
        await reporter.step(`${job.applicationName} (${job.source.chart} ${latestVersion})`);
        return result && { ...result, chart, images };
      },
    );
    await flushWarnings();

    // Each distinct image is scanned once, even when several applications (or a current and an
    // upgraded chart) use it
    const currentImages = new Set(appImages.flatMap((a) => a.images));
    const uniqueImages = [
      ...new Set([...currentImages, ...checked.flatMap((c) => c?.latestImages ?? [])]),
    ];
    const scanned = new Map<string, ImageVulnerability[] | null>();
    await reporter.phase(ScanPhase.VULNERABILITIES, uniqueImages.length);
    await mapWithConcurrency(uniqueImages, CVE_SCAN_CONCURRENCY, async (image) => {
      const vulnerabilities = await scanImageForVulnerabilities(image).catch((error) => {
        ctx.warn(`vulnerability scan of ${image} failed: ${describeError(error)}`);
        return null;
      });
      scanned.set(image, vulnerabilities);
      if (currentImages.has(image)) {
        const [repository, tag = 'latest'] = splitImageTag(image);
        const cves = appImages
          .filter((a) => a.images.includes(image))
          .flatMap(({ applicationName }) =>
            (vulnerabilities ?? []).map((v): CveFinding => ({
              applicationName,
              image: repository,
              ...v,
            })),
          );
        await reporter.imageScanned({ repository, tag }, cves);
      }
      await reporter.step(image);
    });

    for (const result of checked) {
      if (!result?.latestImages) continue;
      const current = vulnerabilitiesOf(result.images, scanned);
      const latest = vulnerabilitiesOf(result.latestImages, scanned);
      if (!current || !latest) continue;
      await reporter.chartUpgrade(result.chart, {
        ...result.upgrade,
        vulnerabilities: diffVulnerabilities(current, latest),
      });
    }
  } finally {
    // Also on failure: partial results stay, so should the warnings that explain gaps in them
    await flushWarnings();
    await cleanup();
  }
}
