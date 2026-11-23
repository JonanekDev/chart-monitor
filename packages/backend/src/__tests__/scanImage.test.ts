import { describe, expect, it, vi } from 'vitest';

const execFile = vi.fn();
vi.mock('node:child_process', () => ({ execFile }));
const { scanImageForVulnerabilities } = await import('../trivy/scanImage.js');

const failWith = (stderr: string) =>
  execFile.mockImplementationOnce((_file, _args, _options, callback) =>
    callback(Object.assign(new Error('Command failed'), { stderr })),
  );

describe('scanImageForVulnerabilities', () => {
  it('passes the timeout, and skips an image that timed out instead of waiting again', async () => {
    failWith('FATAL scan failed: failed to analyze file: context deadline exceeded');
    await expect(scanImageForVulnerabilities('ghcr.io/o/huge:1')).rejects.toThrow('scan failed');
    expect(execFile.mock.calls[0]![1]).toEqual(expect.arrayContaining(['--timeout', '5m']));

    await expect(scanImageForVulnerabilities('ghcr.io/o/huge:1')).rejects.toThrow(
      /skipped: it took over 5m/,
    );
    expect(execFile).toHaveBeenCalledTimes(1);
  });

  it('tries again after other failures (a registry hiccup)', async () => {
    execFile.mockReset();
    failWith('FATAL unable to fetch manifest: 503');
    await expect(scanImageForVulnerabilities('ghcr.io/o/app:1')).rejects.toThrow('scan failed');
    failWith('FATAL unable to fetch manifest: 503');
    await expect(scanImageForVulnerabilities('ghcr.io/o/app:1')).rejects.toThrow('scan failed');
    expect(execFile).toHaveBeenCalledTimes(2);
  });
});
