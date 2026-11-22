import { parse } from 'yaml';
import { helmRepoCredentials } from '../config/auth.js';
import { basicAuth } from '../config/credentials.js';
import { RegistryAuthError } from '../errors.js';
import { listTags } from '../registry/dockerRegistry.js';

interface HelmRepoIndex {
  entries?: Record<string, { version: string }[]>;
}

async function fetchClassicRepoVersions(repoUrl: string, chartName: string): Promise<string[]> {
  const indexUrl = `${repoUrl.replace(/\/$/, '')}/index.yaml`;
  const login = helmRepoCredentials(repoUrl);
  // fetch drops the header if the repo redirects to another host
  const response = await fetch(
    indexUrl,
    login ? { headers: { Authorization: basicAuth(login) } } : {},
  );
  if (response.status === 401 || response.status === 403) {
    throw new RegistryAuthError(
      `${response.status} from ${new URL(indexUrl).host}: ` +
        (login
          ? 'check its login in HELM_REPO_CREDENTIALS'
          : 'add a login to HELM_REPO_CREDENTIALS'),
    );
  }
  if (response.status === 404 && login) {
    throw new RegistryAuthError(
      `404 from ${new URL(indexUrl).host}: not found, or its login in HELM_REPO_CREDENTIALS ` +
        'lacks permission for it',
    );
  }
  if (!response.ok) return [];

  const index = parse(await response.text()) as HelmRepoIndex;
  return (index.entries?.[chartName] ?? []).map((entry) => entry.version);
}

function parseOciRef(repoUrl: string): { registryHost: string; repoPath: string } {
  const withoutScheme = repoUrl.replace(/^oci:\/\//, '');
  const [registryHost, ...rest] = withoutScheme.split('/');
  return { registryHost: registryHost as string, repoPath: rest.join('/') };
}

/** ArgoCD treats a chart repoURL without a scheme (`quay.io/org/charts`) as an OCI registry. */
export function normalizeChartRepoUrl(repoUrl: string): string {
  return repoUrl.includes('://') ? repoUrl : `oci://${repoUrl}`;
}

/** Fetches all published versions for a chart, whether it lives in a classic Helm repo
 * (index.yaml) or an OCI registry. */
export async function fetchChartVersions(repoUrl: string, chartName: string): Promise<string[]> {
  if (repoUrl.startsWith('oci://')) {
    const { registryHost, repoPath } = parseOciRef(repoUrl);
    return listTags(registryHost, `${repoPath}/${chartName}`);
  }
  return fetchClassicRepoVersions(repoUrl, chartName);
}
