import type { Octokit } from '@octokit/rest';
import {
  VersionStatus,
  type ChartFinding,
  type CveFinding,
  type ImageFinding,
} from '@chart-monitor/shared';
import { getInstallationOctokit, parseGithubRepoUrl } from '../github/appAuth.js';
import { fetchYamlFiles, getDefaultBranch } from '../github/repoClient.js';
import { resolveApplicationSets } from '../argocd/findApplicationSets.js';
import type { ApplicationSource } from '../argocd/types.js';
import { fetchChartVersions } from '../helm/chartVersions.js';
import { compareVersions, findLatestVersion } from '../helm/versionCompare.js';
import { renderChartImages } from '../helm/renderChart.js';
import { fetchImageTags } from '../registry/imageRef.js';
import { scanImageForVulnerabilities } from '../trivy/scanImage.js';
import { mapWithConcurrency } from '../utils/concurrency.js';

// Each trivy scan pulls image layers and runs full vuln-DB matching — cap how many run at once
const CVE_SCAN_CONCURRENCY = 4;

function createOctokitResolver() {
  const cache = new Map<string, Promise<Octokit>>();
  return (owner: string, repo: string): Promise<Octokit> => {
    const key = `${owner}/${repo}`;
    if (!cache.has(key)) cache.set(key, getInstallationOctokit(owner, repo));
    return cache.get(key) as Promise<Octokit>;
  };
}

async function resolveChartFinding(
  applicationName: string,
  applicationSetName: string,
  source: ApplicationSource,
): Promise<ChartFinding | null> {
  if (!source.chart || !source.targetRevision) return null;

  const versions = await fetchChartVersions(source.repoURL, source.chart).catch(() => []);
  const latestVersion = findLatestVersion(versions);

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
      const latestTag = findLatestVersion(tags);

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

async function resolveCveFindings(applicationName: string, images: string[]): Promise<CveFinding[]> {
  const perImage = await mapWithConcurrency(images, CVE_SCAN_CONCURRENCY, async (image) => {
    const vulnerabilities = await scanImageForVulnerabilities(image).catch(() => []);
    const [repository] = splitImageTag(image);
    return vulnerabilities.map((v): CveFinding => ({ applicationName, image: repository, ...v }));
  });
  return perImage.flat();
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

export interface ScanResult {
  chartFindings: ChartFinding[];
  imageFindings: ImageFinding[];
  cveFindings: CveFinding[];
}

export async function executeScan(
  repoUrl: string,
  searchPath: string | undefined,
  ref: string | undefined,
): Promise<ScanResult> {
  const { owner, repo } = parseGithubRepoUrl(repoUrl);
  const resolveOctokit = createOctokitResolver();
  const octokit = await resolveOctokit(owner, repo);
  const resolvedRef = ref ?? (await getDefaultBranch(octokit, owner, repo));

  const files = await fetchYamlFiles(octokit, owner, repo, resolvedRef, searchPath);
  const applications = await resolveApplicationSets(files, resolveOctokit);

  const chartFindings: ChartFinding[] = [];
  const imageFindings: ImageFinding[] = [];
  const cveFindings: CveFinding[] = [];

  for (const app of applications) {
    for (const source of app.sources) {
      const chartFinding = await resolveChartFinding(
        app.applicationName,
        app.applicationSetName,
        source,
      );
      if (!chartFinding) continue;
      chartFindings.push(chartFinding);

      const images = await renderChartImages(source).catch(() => [] as string[]);
      imageFindings.push(...(await resolveImageFindings(app.applicationName, images)));
      cveFindings.push(...(await resolveCveFindings(app.applicationName, images)));
    }
  }

  return { chartFindings, imageFindings, cveFindings };
}
