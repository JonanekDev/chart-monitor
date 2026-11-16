import {
  ScanPhase,
  VersionStatus,
  type ChartFinding,
  type CveFinding,
  type ImageFinding,
  type ScanPhaseValue,
} from '@chart-monitor/shared';
import { resolveApplicationSets } from '../argocd/findApplicationSets.js';
import { withWarningPrefix, type ApplicationSource, type ScanContext } from '../argocd/types.js';
import { fetchChartVersions, normalizeChartRepoUrl } from '../helm/chartVersions.js';
import { compareVersions, findLatestVersion } from '../helm/versionCompare.js';
import { renderChartImages } from '../helm/renderChart.js';
import { collectValuesDocuments } from '../argocd/valueFiles.js';
import { expandUmbrellaChart, type ChartToScan } from '../argocd/umbrellaChart.js';
import { createRepoOpener } from '../git/repoSnapshot.js';
import { fetchImageTags } from '../registry/imageRef.js';
import { scanImageForVulnerabilities } from '../trivy/scanImage.js';
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
    await mapWithConcurrency(jobs, CHART_CONCURRENCY, async (job) => {
      await reporter.chartFinding(
        await resolveChartFinding(job.applicationName, job.applicationSetName, job.source),
      );
      await reporter.step(`${job.applicationName} (${job.source.chart})`);
    });

    await reporter.phase(ScanPhase.IMAGES, jobs.length);
    const appImages = await mapWithConcurrency(jobs, CHART_CONCURRENCY, async (job) => {
      const images = await renderChartImages(job.source, job.valuesDocuments).catch((error) => {
        job.ctx.warn(`images could not be determined: ${describeError(error)}`);
        return [] as string[];
      });
      await reporter.imageFindings(await resolveImageFindings(job.applicationName, images));
      await reporter.step(`${job.applicationName} (${job.source.chart})`);
      return { applicationName: job.applicationName, images };
    });
    await flushWarnings();

    // Each distinct image is scanned once, even when several applications use it
    const uniqueImages = [...new Set(appImages.flatMap((a) => a.images))];
    await reporter.phase(ScanPhase.VULNERABILITIES, uniqueImages.length);
    await mapWithConcurrency(uniqueImages, CVE_SCAN_CONCURRENCY, async (image) => {
      const vulnerabilities = await scanImageForVulnerabilities(image).catch((error) => {
        ctx.warn(`vulnerability scan of ${image} failed: ${describeError(error)}`);
        return [];
      });
      const [repository, tag = 'latest'] = splitImageTag(image);
      const cves = appImages
        .filter((a) => a.images.includes(image))
        .flatMap(({ applicationName }) =>
          vulnerabilities.map((v): CveFinding => ({ applicationName, image: repository, ...v })),
        );
      await reporter.imageScanned({ repository, tag }, cves);
      await reporter.step(image);
    });
  } finally {
    // Also on failure: partial results stay, so should the warnings that explain gaps in them
    await flushWarnings();
    await cleanup();
  }
}
