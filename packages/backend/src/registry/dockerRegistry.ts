import { getTags } from '@snyk/docker-registry-v2-client';

/** Lists every tag for a repo on a Docker Registry v2 / OCI Distribution Spec registry.
 * Anonymous public pulls, the WWW-Authenticate bearer-token challenge, and Link-header
 * pagination are all handled by the underlying client.
 *
 * Deliberately uses `getTags` (Link-header pagination), not the library's own `getTagsPaginated`
 * ("last marker", pitched as more robust): quay.io silently caps its page size below what we
 * request, which breaks getTagsPaginated's "short page = last page" heuristic — verified against
 * quay.io/ceph/ceph, which has 413 tags but getTagsPaginated stopped at 100. */
export async function listTags(registryHost: string, repoPath: string): Promise<string[]> {
  try {
    return await getTags(registryHost, repoPath);
  } catch {
    return [];
  }
}
