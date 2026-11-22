import { getTags } from '@snyk/docker-registry-v2-client';
import { registryCredentials } from '../config/auth.js';
import { RegistryAuthError } from '../errors.js';

/** Lists every tag for a repo on a Docker Registry v2 / OCI Distribution Spec registry.
 * Anonymous public pulls, the WWW-Authenticate bearer-token challenge, and Link-header
 * pagination are all handled by the underlying client.
 *
 * Deliberately uses `getTags` (Link-header pagination), not the library's own `getTagsPaginated`
 * ("last marker", pitched as more robust): quay.io silently caps its page size below what we
 * request, which breaks getTagsPaginated's "short page = last page" heuristic — verified against
 * quay.io/ceph/ceph, which has 413 tags but getTagsPaginated stopped at 100. */
export async function listTags(registryHost: string, repoPath: string): Promise<string[]> {
  const login = registryCredentials(registryHost);
  try {
    return await getTags(registryHost, repoPath, login?.username, login?.password);
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
