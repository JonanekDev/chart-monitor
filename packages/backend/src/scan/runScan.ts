import {
  VersionStatus,
  type ChartFinding,
  type CveFinding,
  type ImageFinding,
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
import { scanImageForVulnerabilities, type ImageVulnerability } from '../trivy/scanImage.js';
import { mapWithConcurrency } from '../utils/concurrency.js';
import { env } from '../config/env.js';

// Each trivy scan pulls image layers and runs full vuln-DB matching — cap how many run at once
const CVE_SCAN_CONCURRENCY = 4;

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
  source: ApplicationSource,
): Promise<ChartFinding | null> {
  if (!source.chart || !source.targetRevision) return null;

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
      };
    }),
  );
}

/** Scans every distinct image once (images shared by several applications are common), with a cap on
 * concurrent trivy runs. A failed scan is reported once and yields no vulnerabilities. */
async function scanImagesOnce(
  images: string[],
  ctx: ScanContext,
): Promise<Map<string, ImageVulnerability[]>> {
  const unique = [...new Set(images)];
  const results = await mapWithConcurrency(unique, CVE_SCAN_CONCURRENCY, (image) =>
    scanImageForVulnerabilities(image).catch((error) => {
      ctx.warn(`vulnerability scan of ${image} failed: ${describeError(error)}`);
      return [];
    }),
  );
  return new Map(unique.map((image, i) => [image, results[i]!]));
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

export interface ScanResult {
  chartFindings: ChartFinding[];
  imageFindings: ImageFinding[];
  cveFindings: CveFinding[];
  /** Everything that was skipped or failed along the way, deduplicated, in discovery order */
  warnings: string[];
}

export async function executeScan(
  repoUrl: string,
  searchPath: string | undefined,
  ref: string | undefined,
): Promise<ScanResult> {
  const warnings = new Set<string>();
  const { openRepo, cleanup } = createRepoOpener({
    githubToken: env.GITHUB_TOKEN,
    credentials: env.GIT_CREDENTIALS,
  });
  const ctx: ScanContext = { openRepo, warn: (message) => warnings.add(message) };

  try {
    const repo = await openRepo(repoUrl, ref);
    const prefix = searchPath?.replace(/^\/+/, '');
    const yamlPaths = repo.files.filter(
      (path) => /\.ya?ml$/i.test(path) && (!prefix || path.startsWith(prefix)),
    );
    const files = await Promise.all(
      yamlPaths.map(async (path) => ({ path, content: await repo.read(path) })),
    );
    const applications = await resolveApplicationSets(files, ctx);

    const chartFindings: ChartFinding[] = [];
    const imageFindings: ImageFinding[] = [];
    // CVE scans run after all charts are rendered, so each distinct image is scanned only once
    const appImages: { applicationName: string; images: string[] }[] = [];

    for (const app of applications) {
      const appCtx = withWarningPrefix(ctx, `Application "${app.applicationName}"`);
      for (const { source, valuesDocuments } of await collectChartsToScan(app.sources, appCtx)) {
        const chartFinding = await resolveChartFinding(
          app.applicationName,
          app.applicationSetName,
          source,
        );
        if (!chartFinding) {
          appCtx.warn(`chart "${source.chart}" has no targetRevision, skipped`);
          continue;
        }
        chartFindings.push(chartFinding);

        const images = await renderChartImages(source, valuesDocuments).catch((error) => {
          appCtx.warn(`images could not be determined: ${describeError(error)}`);
          return [] as string[];
        });
        imageFindings.push(...(await resolveImageFindings(app.applicationName, images)));
        appImages.push({ applicationName: app.applicationName, images });
      }
    }

    const vulnerabilitiesByImage = await scanImagesOnce(
      appImages.flatMap((a) => a.images),
      ctx,
    );
    const cveFindings = appImages.flatMap(({ applicationName, images }) =>
      images.flatMap((image) =>
        (vulnerabilitiesByImage.get(image) ?? []).map((v): CveFinding => ({
          applicationName,
          image: splitImageTag(image)[0],
          ...v,
        })),
      ),
    );

    return { chartFindings, imageFindings, cveFindings, warnings: [...warnings] };
  } finally {
    await cleanup();
  }
}
