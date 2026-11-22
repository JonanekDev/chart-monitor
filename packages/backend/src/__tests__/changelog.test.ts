import { describe, expect, it, vi } from 'vitest';
import {
  buildChangelog,
  memoryChangelogCache,
  OCI_LOAD_LIMIT,
  parseChanges,
  pickVersionsToLoad,
  releasesUrl,
} from '../helm/changelog.js';
import { versionsBetween } from '../helm/versionCompare.js';

const changes = (...items: string[]) =>
  items.map((d) => `- kind: changed\n  description: ${d}`).join('\n');

describe('parseChanges', () => {
  it('reads the object and the plain-string format, ignores anything else', () => {
    expect(
      parseChanges(`
- kind: security
  description: Fix CVE-1
  links:
    - name: GHSA
      url: https://github.com/advisories/GHSA-1
    - not a link
- Plain old entry
`),
    ).toEqual([
      {
        kind: 'security',
        description: 'Fix CVE-1',
        links: [{ name: 'GHSA', url: 'https://github.com/advisories/GHSA-1' }],
      },
      { kind: 'changed', description: 'Plain old entry', links: [] },
    ]);
    expect(parseChanges(undefined)).toEqual([]);
    expect(parseChanges('key: value')).toEqual([]);
    expect(parseChanges('- [unclosed')).toEqual([]);
  });
});

describe('releasesUrl', () => {
  it('uses the first GitHub repo in sources, then home', () => {
    expect(
      releasesUrl(
        { sources: ['https://gitlab.com/x/y', 'https://github.com/org/charts.git'] },
        '1.2.3',
      ),
    ).toBe('https://github.com/org/charts/releases?q=1.2.3&expanded=true');
    expect(releasesUrl({ home: 'https://github.com/org/app/tree/main/chart' }, 'v2')).toBe(
      'https://github.com/org/app/releases?q=v2&expanded=true',
    );
    expect(releasesUrl({ home: 'https://example.com' }, '1')).toBeNull();
  });
});

describe('versionsBetween', () => {
  it('lists versions after the current one up to the latest, newest first, no pre-releases', () => {
    expect(
      versionsBetween(
        ['93.1.0', '93.2.0', '93.4.1', '93.3.0-rc.1', '94.0.0', 'x'],
        '93.1.0',
        '93.4.1',
      ),
    ).toEqual(['93.4.1', '93.2.0']);
  });
});

describe('pickVersionsToLoad', () => {
  it('takes the first version of each new major, then the newest', () => {
    const versions = ['4.2.0', '4.1.0', '4.0.0', '3.2.0', '3.1.0', '3.0.0', '2.9.0', '2.8.0'];
    expect(pickVersionsToLoad(versions, '2.7.0', 4)).toEqual(['4.0.0', '3.0.0', '4.2.0', '4.1.0']);
  });
});

describe('buildChangelog', () => {
  const base = {
    cacheKey: (version: string) => `repo|chart|${version}`,
    currentVersion: '1.0.0',
    latestVersion: '1.3.0',
    latestMetadata: {
      sources: ['https://github.com/org/charts'],
      annotations: { 'artifacthub.io/changes': changes('latest') },
    },
  };

  it('reads a classic repo from index.yaml and caches every version', async () => {
    const cache = memoryChangelogCache();
    const loadMetadata = vi.fn();
    const result = await buildChangelog({
      ...base,
      cache,
      versions: ['1.3.0', '1.2.0', '1.1.0'],
      indexChanges: new Map([
        ['1.2.0', changes('two')],
        ['1.1.0', undefined],
      ]),
      loadMetadata,
    });
    expect(result).toEqual({
      versions: [
        { version: '1.3.0', changes: [expect.objectContaining({ description: 'latest' })] },
        { version: '1.2.0', changes: [expect.objectContaining({ description: 'two' })] },
        { version: '1.1.0', changes: [] },
      ],
      notLoaded: 0,
      releasesUrl: 'https://github.com/org/charts/releases?q=1.3.0&expanded=true',
    });
    expect(loadMetadata).not.toHaveBeenCalled();
    expect([...(await cache.get(['repo|chart|1.1.0', 'repo|chart|1.2.0'])).keys()]).toHaveLength(2);
  });

  it('skips older OCI versions when the latest has no changes', async () => {
    const cache = memoryChangelogCache();
    const loadMetadata = vi.fn();
    const result = await buildChangelog({
      ...base,
      cache,
      latestMetadata: { annotations: {} },
      versions: ['1.3.0', '1.2.0', '1.1.0'],
      indexChanges: null,
      loadMetadata,
    });
    expect(loadMetadata).not.toHaveBeenCalled();
    expect(result.notLoaded).toBe(0);
    expect(result.versions.map((v) => v.changes)).toEqual([[], [], []]);
    // Only the latest was actually read; the others are a guess, so not cached
    expect([...(await cache.get(['repo|chart|1.3.0', 'repo|chart|1.2.0'])).keys()]).toEqual([
      'repo|chart|1.3.0',
    ]);
  });

  it('loads OCI versions within the limit, uses the cache, and leaves failures uncached', async () => {
    const cache = memoryChangelogCache();
    await cache.set(new Map([['repo|chart|1.2.0', []]]));
    // Newest first: 1.3.0, 1.2.0, then 1.1.12 … 1.1.0
    const older = Array.from(
      { length: OCI_LOAD_LIMIT + 3 },
      (_, i) => `1.1.${OCI_LOAD_LIMIT + 2 - i}`,
    );
    const versions = ['1.3.0', '1.2.0', ...older];
    const failing = older[0]!;
    const loadMetadata = vi.fn(async (version: string) => {
      if (version === failing) throw new Error('unreachable');
      return { annotations: { 'artifacthub.io/changes': changes(version) } };
    });

    const result = await buildChangelog({
      ...base,
      cache,
      versions,
      indexChanges: null,
      loadMetadata,
    });

    // 1.3.0 from the pulled Chart.yaml, 1.2.0 from the cache, the limit for the rest
    expect(loadMetadata).toHaveBeenCalledTimes(OCI_LOAD_LIMIT);
    expect(loadMetadata).not.toHaveBeenCalledWith('1.3.0');
    expect(result.versions.map((v) => v.version).slice(0, 2)).toEqual(['1.3.0', '1.2.0']);
    // Loaded: the limit minus the one that failed; the rest of `older` stays out
    expect(result.versions).toHaveLength(2 + OCI_LOAD_LIMIT - 1);
    expect(result.notLoaded).toBe(older.length - (OCI_LOAD_LIMIT - 1));
    expect((await cache.get([`repo|chart|${failing}`])).size).toBe(0);
  });
});
