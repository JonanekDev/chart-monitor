import { parse } from 'yaml';
import { listTags } from '../registry/dockerRegistry.js';

interface HelmRepoIndex {
  entries?: Record<string, { version: string }[]>;
}

async function fetchClassicRepoVersions(repoUrl: string, chartName: string): Promise<string[]> {
  const indexUrl = `${repoUrl.replace(/\/$/, '')}/index.yaml`;
  const response = await fetch(indexUrl);
  if (!response.ok) return [];

  const index = parse(await response.text()) as HelmRepoIndex;
  return (index.entries?.[chartName] ?? []).map((entry) => entry.version);
}

function parseOciRef(repoUrl: string): { registryHost: string; repoPath: string } {
  const withoutScheme = repoUrl.replace(/^oci:\/\//, '');
  const [registryHost, ...rest] = withoutScheme.split('/');
  return { registryHost: registryHost as string, repoPath: rest.join('/') };
}

/** Fetches all published versions for a chart, whether it lives in a classic Helm repo (index.yaml) or an OCI registry. */
export async function fetchChartVersions(repoUrl: string, chartName: string): Promise<string[]> {
  if (repoUrl.startsWith('oci://')) {
    const { registryHost, repoPath } = parseOciRef(repoUrl);
    return listTags(registryHost, `${repoPath}/${chartName}`);
  }
  return fetchClassicRepoVersions(repoUrl, chartName);
}
