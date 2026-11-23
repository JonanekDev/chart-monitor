import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchChartVersions, type RepoIndexCache } from '../helm/chartVersions.js';

afterEach(() => vi.restoreAllMocks());

describe('fetchChartVersions', () => {
  it('fetches a classic repo index once per scan, however many charts come from it', async () => {
    const index = `entries:
  app-a: [{ version: 1.0.0 }, { version: 1.1.0 }]
  app-b: [{ version: 2.0.0, annotations: { artifacthub.io/changes: "- fixed x" } }]
`;
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(index));
    const indexes: RepoIndexCache = new Map();
    const repo = 'https://charts.example.com';

    const [a, b] = await Promise.all([
      fetchChartVersions(repo, 'app-a', indexes),
      fetchChartVersions(repo, 'app-b', indexes),
    ]);
    expect(a.map((v) => v.version)).toEqual(['1.0.0', '1.1.0']);
    expect(b).toEqual([{ version: '2.0.0', changes: '- fixed x' }]);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
