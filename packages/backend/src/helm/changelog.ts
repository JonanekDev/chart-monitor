import semver from 'semver';
import { parse } from 'yaml';
import type { ChangelogEntry, ChartChangelog } from '@chart-monitor/shared';
import type { ChartMetadata } from './renderChart.js';

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** `artifacthub.io/changes`: a YAML list of `{kind, description, links}`, or of plain strings in
 * the older format. Anything else reads as no changes. */
export function parseChanges(annotation: string | undefined): ChangelogEntry[] {
  let parsed: unknown;
  try {
    parsed = parse(annotation ?? '');
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.flatMap((item): ChangelogEntry[] => {
    if (typeof item === 'string') return [{ kind: 'changed', description: item, links: [] }];
    if (!isObject(item) || typeof item.description !== 'string') return [];
    const links = Array.isArray(item.links) ? item.links : [];
    return [
      {
        kind: typeof item.kind === 'string' ? item.kind : 'changed',
        description: item.description,
        links: links
          .filter(
            (l): l is { url: string; name?: unknown } => isObject(l) && typeof l.url === 'string',
          )
          .map((l) => ({ name: typeof l.name === 'string' ? l.name : l.url, url: l.url })),
      },
    ];
  });
}

/** The GitHub releases of the first github.com repo in `sources` (or `home`), filtered to the
 * version: tags differ per project (`v1.2.3`, `chart-1.2.3`, `chart-v1.2.3`), a search finds any */
export function releasesUrl(metadata: ChartMetadata, version: string): string | null {
  for (const url of [...(metadata.sources ?? []), metadata.home ?? '']) {
    const repo = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?(?:[/?#]|$)/.exec(url);
    if (repo) {
      return `https://github.com/${repo[1]}/${repo[2]}/releases?q=${encodeURIComponent(version)}&expanded=true`;
    }
  }
  return null;
}

/** Changelogs by `repo|chart|version`; versions are immutable, so entries never expire */
export interface ChangelogCache {
  get(keys: string[]): Promise<Map<string, ChangelogEntry[]>>;
  set(entries: Map<string, ChangelogEntry[]>): Promise<void>;
}

export function memoryChangelogCache(): ChangelogCache {
  const store = new Map<string, ChangelogEntry[]>();
  return {
    get: async (keys) => new Map(keys.flatMap((k) => (store.has(k) ? [[k, store.get(k)!]] : []))),
    set: async (entries) => entries.forEach((changes, key) => store.set(key, changes)),
  };
}

/** Which versions to download within `limit`: the first version of each new major (where
 * breaking changes land), then the newest of the rest. `versions` are newest first. */
export function pickVersionsToLoad(versions: string[], current: string, limit: number): string[] {
  const currentMajor = semver.coerce(current)?.major ?? 0;
  const firstOfMajor = new Map<number, string>();
  for (const version of versions) {
    const major = semver.coerce(version)?.major ?? 0;
    // Newest first, so the last one seen per major is its first release
    if (major > currentMajor) firstOfMajor.set(major, version);
  }
  return [...new Set([...firstOfMajor.values(), ...versions])].slice(0, limit);
}

// Each OCI version needs a `helm show chart`; classic repos list them all in index.yaml
export const OCI_LOAD_LIMIT = 10;

/**
 * The changelog of `versions` (after the current one up to `latestVersion`, newest first). Cached
 * versions are free, so are the latest (its Chart.yaml is already pulled) and classic repos (whose
 * index.yaml carries the annotation); other OCI versions load within OCI_LOAD_LIMIT, and only when
 * the latest one has changes: projects use the annotation in every version or in none.
 */
export async function buildChangelog(options: {
  cacheKey: (version: string) => string;
  cache: ChangelogCache;
  versions: string[];
  currentVersion: string;
  latestVersion: string;
  latestMetadata: ChartMetadata;
  /** Annotations from index.yaml, by version; null for OCI */
  indexChanges: Map<string, string | undefined> | null;
  loadMetadata: (version: string) => Promise<ChartMetadata>;
}): Promise<ChartChangelog> {
  const { cacheKey, cache, versions, latestVersion, latestMetadata, indexChanges } = options;
  const cached = await cache.get(versions.map(cacheKey));
  const known = (version: string) => cached.get(cacheKey(version));
  const fetched = new Map<string, ChangelogEntry[]>();
  const add = (version: string, annotations: Record<string, string> | undefined) =>
    fetched.set(version, parseChanges(annotations?.['artifacthub.io/changes']));

  if (!known(latestVersion)) add(latestVersion, latestMetadata.annotations);
  const missing = versions.filter((v) => !known(v) && !fetched.has(v));
  if (indexChanges) {
    for (const version of missing) {
      const changes = indexChanges.get(version);
      add(version, changes === undefined ? undefined : { 'artifacthub.io/changes': changes });
    }
  } else if ((known(latestVersion) ?? fetched.get(latestVersion))?.length) {
    const toLoad = pickVersionsToLoad(missing, options.currentVersion, OCI_LOAD_LIMIT);
    await Promise.all(
      toLoad.map(async (version) => {
        // A version that fails to load counts as not loaded, and isn't cached
        const metadata = await options.loadMetadata(version).catch(() => null);
        if (metadata) add(version, metadata.annotations);
      }),
    );
  }
  await cache.set(new Map([...fetched].map(([version, changes]) => [cacheKey(version), changes])));

  // Not downloaded because the latest has no changes: presumed empty, but not cached as such
  const presumedEmpty =
    !indexChanges && !(known(latestVersion) ?? fetched.get(latestVersion))?.length;
  const loaded = versions.flatMap((version) => {
    const changes = known(version) ?? fetched.get(version) ?? (presumedEmpty ? [] : undefined);
    return changes ? [{ version, changes }] : [];
  });
  return {
    versions: loaded,
    notLoaded: versions.length - loaded.length,
    releasesUrl: releasesUrl(latestMetadata, latestVersion),
  };
}
