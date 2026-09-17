import { listTags } from './dockerRegistry.js';

export interface ParsedImageRef {
  registryHost: string;
  repoPath: string;
  tag: string;
}

/** Parses a container image reference (`nginx`, `bitnami/redis:7.2`, `ghcr.io/org/app:1.0`,
 * `ghcr.io/org/app:1.0@sha256:...`) the same way the Docker CLI does. A trailing `@sha256:...`
 * digest is dropped — it pins the exact build but doesn't change what tag we compare against. */
export function parseImageRef(image: string): ParsedImageRef | null {
  const withoutDigest = image.split('@')[0];
  if (!withoutDigest) return null;

  const lastSlashIndex = withoutDigest.lastIndexOf('/');
  const lastColonIndex = withoutDigest.lastIndexOf(':');

  const hasExplicitTag = lastColonIndex > lastSlashIndex;
  const tag = hasExplicitTag ? withoutDigest.slice(lastColonIndex + 1) : 'latest';
  const withoutTag = hasExplicitTag ? withoutDigest.slice(0, lastColonIndex) : withoutDigest;

  const parts = withoutTag.split('/');
  const firstSegment = parts[0] as string;
  const isRegistryHost =
    firstSegment.includes('.') || firstSegment.includes(':') || firstSegment === 'localhost';

  const registryHost = isRegistryHost
    ? firstSegment.replace(/^docker\.io$/, 'registry-1.docker.io')
    : 'registry-1.docker.io';
  let repoParts = isRegistryHost ? parts.slice(1) : parts;
  if (repoParts.length === 1) repoParts = ['library', ...repoParts];

  return { registryHost, repoPath: repoParts.join('/'), tag };
}

export async function fetchImageTags(image: string): Promise<string[]> {
  const parsed = parseImageRef(image);
  if (!parsed) return [];
  return listTags(parsed.registryHost, parsed.repoPath);
}
