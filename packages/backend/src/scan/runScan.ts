import {
  ScanPhase,
  VersionStatus,
  type ChartFinding,
  type ChartUpgrade,
  type CveFinding,
  type ImageFinding,
  type LatestTagCheck,
  type ScanPhaseValue,
  type VulnerabilityChange,
} from '@chart-monitor/shared';
import { resolveApplicationSets } from '../argocd/findApplicationSets.js';
import { withWarningPrefix, type ApplicationSource, type ScanContext } from '../argocd/types.js';
import {
  fetchChartVersions,
  normalizeChartRepoUrl,
  type PublishedVersion,
  type RepoIndexCache,
} from '../helm/chartVersions.js';
import {
  compareVersions,
  findLatestImageTag,
  findLatestVersion,
  isSureUpgrade,
  versionsBetween,
} from '../helm/versionCompare.js';
import { findImages, HelmSession, pullChart, renderChart, showChart } from '../helm/renderChart.js';
import { buildChangelog, memoryChangelogCache, type ChangelogCache } from '../helm/changelog.js';
import { diffManifests, diffVulnerabilities, removedValueKeys } from '../helm/upgradeCheck.js';
import { collectValuesDocuments } from '../argocd/valueFiles.js';
import { expandUmbrellaChart, type ChartToScan } from '../argocd/umbrellaChart.js';
import { createRepoOpener } from '../git/repoSnapshot.js';
import { fetchImageTags, parseImageRef } from '../registry/imageRef.js';
import { scanImageForVulnerabilities, type ImageVulnerability } from '../trivy/scanImage.js';
import { mapWithConcurrency } from '../utils/concurrency.js';
import { redactSecrets } from '../config/auth.js';
import { env } from '../config/env.js';
import { RegistryAuthError } from '../errors.js';

// Chart version lookups and `helm template` runs are mostly network-bound
const CHART_CONCURRENCY = 8;

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

/** A missing version/tag list stays quiet (non-semver tags, registries without a tag list), a
 * refused login is worth a warning */
const warnOnAuthError =
  (warn: (message: string) => void) =>
  (error: unknown): never[] => {
    if (error instanceof RegistryAuthError) warn(error.message);
    return [];
  };

/** The finding, and every published version (the changelog reads them later) */
async function resolveChartFinding(
  job: ChartJob,
): Promise<{ finding: ChartFinding; published: PublishedVersion[] }> {
  const { applicationName, applicationSetName, source } = job;
  const published = await fetchChartVersions(source.repoURL, source.chart, job.repoIndexes).catch(
    warnOnAuthError(job.ctx.warn),
  );
  const latestVersion = findLatestVersion(
    published.map((p) => p.version),
    env.INCLUDE_PRERELEASES,
  );

  const finding: ChartFinding = {
    applicationName,
    applicationSetName,
    chartName: source.chart,
    repoUrl: source.repoURL,
    currentVersion: source.targetRevision,
    latestVersion,
    status: compareVersions(source.targetRevision, latestVersion),
    note: latestVersion ? null : 'Could not determine published chart versions',
  };
  return { finding, published };
}

async function resolveImageFindings(job: ChartJob, images: string[]): Promise<ImageFinding[]> {
  const { applicationName } = job;
  return Promise.all(
    images.map(async (image): Promise<ImageFinding> => {
      const [repository, currentTag = 'latest'] = splitImageTag(image);
      const tags = await fetchImageTags(image).catch(warnOnAuthError(job.ctx.warn));
      const latestTag = findLatestImageTag(tags, currentTag, env.INCLUDE_PRERELEASES);

      return {
        applicationName,
        image: repository,
        currentTag,
        latestTag,
        status: latestTag ? compareVersions(currentTag, latestTag) : VersionStatus.UNKNOWN,
        note: latestTag ? null : 'Tag is not semver, or the registry does not expose a tag list',
        vulnerabilitiesScanned: false,
        tagSource: null,
        latestTagCheck: null,
      };
    }),
  );
}

/** Images the chart renders without the app's values (null when it can't: required values) */
async function chartDefaultImages(job: ChartJob, images: string[]): Promise<string[] | null> {
  const parameters = job.source.helm?.parameters ?? [];
  if (job.valuesDocuments.length === 0 && parameters.length === 0) return images;
  const withoutValues = { ...job.source, helm: { ...job.source.helm, parameters: [] } };
  return renderChart(job.helm, withoutValues).then(findImages, () => null);
}

/** Repository path + tag without the registry, so a mirror or global.imageRegistry doesn't count
 * as a different image */
function repoAndTag(image: string): { repo: string; tag: string } | null {
  const parsed = parseImageRef(image);
  return parsed && { repo: parsed.repoPath, tag: parsed.tag };
}

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function tagSourceOf(
  image: string,
  defaults: string[],
  valuesDocuments: string[],
): ImageFinding['tagSource'] {
  const own = repoAndTag(image);
  if (!own) return null;
  const sameRepo = defaults.map(repoAndTag).filter((d) => d?.repo === own.repo);
  if (sameRepo.length) return sameRepo.some((d) => d!.tag === own.tag) ? 'chart' : 'values';
  // Not rendered without values at all (a component the values turn on, a repository they
  // change): the tag is yours if it's written in them, as a whole word
  const tag = new RegExp(`(^|[^\\w.-])${escapeRegExp(own.tag)}($|[^\\w.-])`);
  return valuesDocuments.some((doc) => tag.test(doc)) ? 'values' : 'chart';
}

interface LatestTagScan {
  finding: ImageFinding;
  /** As rendered, and the latest tag of the same repository */
  ref: string;
  latestRef: string;
}

/** Fills in tagSource of outdated images, and picks the ones whose latest tag is worth scanning:
 * not when a chart upgrade brings the newer tag (the upgrade comparison covers it), and only when
 * the latest tag is surely the same image variant */
export async function classifyOutdatedImages(
  job: ChartJob,
  chartOutdated: boolean,
  images: string[],
  findings: ImageFinding[],
): Promise<LatestTagScan[]> {
  if (!findings.some((f) => f.status === VersionStatus.OUTDATED)) return [];
  const defaults = await chartDefaultImages(job, images);
  const scans: LatestTagScan[] = [];
  findings.forEach((finding, i) => {
    if (finding.status !== VersionStatus.OUTDATED || !finding.latestTag) return;
    const ref = images[i]!;
    finding.tagSource = defaults && tagSourceOf(ref, defaults, job.valuesDocuments);
    if (finding.tagSource === 'chart' && chartOutdated) return;
    if (isSureUpgrade(finding.currentTag, finding.latestTag)) {
      scans.push({ finding, ref, latestRef: `${finding.image}:${finding.latestTag}` });
    } else {
      finding.latestTagCheck = { result: 'variant_unclear' };
    }
  });
  return scans;
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
  published: PublishedVersion[],
): Promise<{ upgrade: ChartUpgrade; latestImages: string[] | null }> {
  const latest = { ...job.source, targetRevision: latestVersion };
  const [current, upgraded] = await Promise.all([
    pullChart(job.helm, job.source),
    pullChart(job.helm, latest),
  ]);
  const removedValues = removedValueKeys(
    job.valuesDocuments,
    (job.source.helm?.parameters ?? []).map((p) => p.name),
    current.defaults,
    upgraded.defaults,
  );
  const { source } = job;
  const changelog = await buildChangelog({
    cacheKey: (version) => `${source.repoURL}|${source.chart}|${version}`,
    cache: job.changelogCache,
    versions: versionsBetween(
      published.map((p) => p.version),
      source.targetRevision,
      latestVersion,
      env.INCLUDE_PRERELEASES,
    ),
    currentVersion: source.targetRevision,
    latestVersion,
    latestMetadata: upgraded.metadata,
    indexChanges: source.repoURL.startsWith('oci://')
      ? null
      : new Map(published.map((p) => [p.version, p.changes])),
    loadMetadata: (version) => showChart(job.helm, { ...source, targetRevision: version }),
  }).catch((error) => {
    job.ctx.warn(`changelog up to ${latestVersion} could not be read: ${describeError(error)}`);
    return null;
  });
  try {
    const latestManifests = await renderChart(job.helm, latest, job.valuesDocuments);
    return {
      upgrade: {
        removedValues,
        manifestChanges: diffManifests(manifests, latestManifests),
        renderError: null,
        vulnerabilities: null,
        changelog,
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
        changelog,
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
  /** The latest tag of an outdated image was compared with its current one */
  latestTagChecked(
    image: { applicationName: string; repository: string; tag: string },
    check: LatestTagCheck,
  ): Promise<unknown>;
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
  helm: HelmSession;
  changelogCache: ChangelogCache;
  repoIndexes: RepoIndexCache;
}

export async function executeScan(
  input: { repoUrl: string; searchPath?: string; ref?: string },
  reporter: ScanReporter,
  changelogCache: ChangelogCache = memoryChangelogCache(),
): Promise<void> {
  const warnings = new Set<string>();
  const { openRepo, cleanup } = createRepoOpener({
    githubToken: env.GITHUB_TOKEN,
    credentials: env.GIT_CREDENTIALS,
  });
  const helm = await HelmSession.create();
  const repoIndexes: RepoIndexCache = new Map();
  // Warnings are stored and shown: no credential a CLI echoed may end up in them
  const ctx: ScanContext = { openRepo, warn: (message) => warnings.add(redactSecrets(message)) };
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
          helm,
          changelogCache,
          repoIndexes,
        });
      }
    }
    await flushWarnings();

    // Cheap step first, so chart versions are visible long before the slow image scans finish
    await reporter.phase(ScanPhase.CHART_VERSIONS, jobs.length);
    const chartResults = await mapWithConcurrency(jobs, CHART_CONCURRENCY, async (job) => {
      const result = await resolveChartFinding(job);
      await reporter.chartFinding(result.finding);
      await reporter.step(`${job.applicationName} (${job.source.chart})`);
      return result;
    });
    const chartFindings = chartResults.map((r) => r.finding);

    await reporter.phase(ScanPhase.IMAGES, jobs.length);
    const imageJobs = jobs.map((job, i) => ({
      job,
      chartOutdated: chartFindings[i]!.status === VersionStatus.OUTDATED,
    }));
    const appImages = await mapWithConcurrency(
      imageJobs,
      CHART_CONCURRENCY,
      async ({ job, chartOutdated }) => {
        const manifests = await renderChart(job.helm, job.source, job.valuesDocuments).catch(
          (error) => {
            job.ctx.warn(`images could not be determined: ${describeError(error)}`);
            return null;
          },
        );
        const images = findImages(manifests ?? []);
        const findings = await resolveImageFindings(job, images);
        const latestTagScans = await classifyOutdatedImages(job, chartOutdated, images, findings);
        await reporter.imageFindings(findings);
        await reporter.step(`${job.applicationName} (${job.source.chart})`);
        return { applicationName: job.applicationName, images, manifests, latestTagScans };
      },
    );
    await flushWarnings();

    const upgrades = jobs.flatMap((job, i) => {
      const { status, latestVersion } = chartFindings[i] as ChartFinding;
      const { manifests, images } = appImages[i]!;
      const { published } = chartResults[i]!;
      return status === VersionStatus.OUTDATED && latestVersion && manifests
        ? [{ job, manifests, images, latestVersion, published }]
        : [];
    });
    await reporter.phase(ScanPhase.UPGRADES, upgrades.length);
    const checked = await mapWithConcurrency(
      upgrades,
      CHART_CONCURRENCY,
      async ({ job, manifests, images, latestVersion, published }) => {
        const chart = { applicationName: job.applicationName, chartName: job.source.chart };
        const result = await checkUpgrade(job, manifests, latestVersion, published).catch(
          (error) => {
            job.ctx.warn(
              `upgrade to ${latestVersion} could not be checked: ${describeError(error)}`,
            );
            return null;
          },
        );
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
      ...new Set([
        ...currentImages,
        ...checked.flatMap((c) => c?.latestImages ?? []),
        ...appImages.flatMap((a) => a.latestTagScans.map((t) => t.latestRef)),
      ]),
    ];
    const scanned = new Map<string, ImageVulnerability[] | null>();
    await reporter.phase(ScanPhase.VULNERABILITIES, uniqueImages.length);
    await mapWithConcurrency(uniqueImages, env.SCAN_CONCURRENCY, async (image) => {
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

    for (const { applicationName, latestTagScans } of appImages) {
      for (const { finding, ref, latestRef } of latestTagScans) {
        const current = vulnerabilitiesOf([ref], scanned);
        const latest = vulnerabilitiesOf([latestRef], scanned);
        await reporter.latestTagChecked(
          { applicationName, repository: finding.image, tag: finding.currentTag },
          current && latest
            ? { result: 'scanned', ...diffVulnerabilities(current, latest) }
            : { result: 'scan_failed' },
        );
      }
    }
  } finally {
    // Also on failure: partial results stay, so should the warnings that explain gaps in them
    await flushWarnings();
    await cleanup();
    await helm.cleanup();
  }
}
