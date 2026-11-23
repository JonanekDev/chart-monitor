import { getTags } from '@snyk/docker-registry-v2-client';
import { registryCredentials } from '../config/auth.js';
import { RegistryAuthError } from '../errors.js';

// Registries cap a page at ~100 tags whatever is asked, so a repo with tens of thousands
// (grafana/loki, external-secrets) takes 20–45 s to list. Tags change slowly: a list is reused by
// the scans of the next hours, and fetched once when several charts need it at the same time. Only
// successful lists are kept, so an unreachable registry is asked again next time.
// ponytail: per-process memory, gone after a restart; a DB table if restarts get frequent
const TAG_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const tagCache = new Map<string, { at: number; tags: Promise<string[]> }>();

function cachedTags(registryHost: string, repoPath: string): Promise<string[]> {
  const key = `${registryHost}/${repoPath}`;
  const hit = tagCache.get(key);
  if (hit && Date.now() - hit.at < TAG_CACHE_TTL_MS) return hit.tags;
  const login = registryCredentials(registryHost);
  const tags = getTags(registryHost, repoPath, login?.username, login?.password);
  tagCache.set(key, { at: Date.now(), tags });
  tags.catch(() => tagCache.delete(key));
  return tags;
}

/** Lists every tag for a repo on a Docker Registry v2 / OCI Distribution Spec registry.
 * Anonymous public pulls, the WWW-Authenticate bearer-token challenge, and Link-header
 * pagination are all handled by the underlying client.
 *
 * Deliberately uses `getTags` (Link-header pagination), not the library's own `getTagsPaginated`
 * ("last marker", pitched as more robust): quay.io silently caps its page size below what we
 * request, which breaks getTagsPaginated's "short page = last page" heuristic — verified against
 * quay.io/ceph/ceph, which has 413 tags but getTagsPaginated stopped at 100.
 * Cached, see cachedTags; [] when the registry has no usable tag list. */
export async function listTags(registryHost: string, repoPath: string): Promise<string[]> {
  const login = registryCredentials(registryHost);
  try {
    return await cachedTags(registryHost, repoPath);
  } catch (error) {
    const status = (error as { statusCode?: number }).statusCode;
    if (status === 401 || status === 403) {
      throw new RegistryAuthError(
        `${status} from ${registryHost} for ${repoPath}: ` +
          (login
            ? 'check its login in the Docker config.json (DOCKER_CONFIG)'
            : 'private? add a login to a Docker config.json (DOCKER_CONFIG)'),
      );
    }
    if (status === 404 && login) {
      throw new RegistryAuthError(
        `404 from ${registryHost} for ${repoPath}: not found, or its login in the Docker ` +
          'config.json lacks permission for it',
      );
    }
    return [];
  }
}
