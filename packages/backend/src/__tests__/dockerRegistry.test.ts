import { describe, expect, it, vi } from 'vitest';

const getTags = vi.fn();
vi.mock('@snyk/docker-registry-v2-client', () => ({ getTags }));
const { listTags } = await import('../registry/dockerRegistry.js');

describe('listTags', () => {
  it('lists a repo once for concurrent and later callers', async () => {
    getTags.mockResolvedValue(['1.0', '1.1']);
    const lists = await Promise.all([listTags('ghcr.io', 'o/big'), listTags('ghcr.io', 'o/big')]);
    expect(await listTags('ghcr.io', 'o/big')).toEqual(['1.0', '1.1']);
    expect(lists).toEqual([
      ['1.0', '1.1'],
      ['1.0', '1.1'],
    ]);
    expect(getTags).toHaveBeenCalledTimes(1);
  });

  it('asks again after a failure instead of caching it', async () => {
    getTags.mockReset();
    getTags.mockRejectedValueOnce(Object.assign(new Error('timeout'), { statusCode: 503 }));
    getTags.mockResolvedValueOnce(['2.0']);
    expect(await listTags('quay.io', 'o/flaky')).toEqual([]);
    expect(await listTags('quay.io', 'o/flaky')).toEqual(['2.0']);
    expect(getTags).toHaveBeenCalledTimes(2);
  });
});
