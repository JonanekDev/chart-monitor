import { describe, expect, it, vi } from 'vitest';
import { memoryRepo } from './helpers/memoryRepo.js';

const appYaml = (name: string, chart: string) => `
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata: { name: ${name} }
spec:
  source: { repoURL: https://charts.example.com, chart: ${chart}, targetRevision: 1.0.0 }
`;

vi.mock('../git/repoSnapshot.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  createRepoOpener: () => ({
    openRepo: async () =>
      memoryRepo({ 'a.yaml': appYaml('app-a', 'redis'), 'b.yaml': appYaml('app-b', 'redis') }),
    cleanup: async () => {},
  }),
}));
vi.mock('../helm/chartVersions.js', () => ({
  normalizeChartRepoUrl: (url: string) => url,
  fetchChartVersions: async () => ['1.0.0', '2.0.0'],
}));
vi.mock('../helm/renderChart.js', () => ({
  renderChartImages: async () => ['docker.io/library/redis:7.0'],
}));
vi.mock('../registry/imageRef.js', () => ({ fetchImageTags: async () => ['7.0', '7.2'] }));
const scanImage = vi.fn(async () => [
  {
    vulnerabilityId: 'CVE-1',
    pkgName: 'openssl',
    installedVersion: '1',
    fixedVersion: '2',
    severity: 'HIGH' as const,
    title: null,
  },
]);
vi.mock('../trivy/scanImage.js', () => ({ scanImageForVulnerabilities: scanImage }));

const { executeScan } = await import('../scan/runScan.js');

describe('executeScan', () => {
  it('reports chart versions before scanning images, and scans a shared image once', async () => {
    const events: string[] = [];
    const cves: unknown[] = [];
    await executeScan(
      { repoUrl: 'https://github.com/o/r' },
      {
        phase: async (phase, total) => events.push(`phase:${phase}:${total ?? 0}`),
        step: async () => {},
        chartFinding: async (f) => events.push(`chart:${f.applicationName}:${f.status}`),
        imageFindings: async (f) => events.push(`images:${f.length}`),
        imageScanned: async (image, found) => {
          events.push(`scanned:${image.repository}:${image.tag}`);
          cves.push(...found);
        },
        warnings: async () => {},
      },
    );

    expect(events).toEqual([
      'phase:cloning:0',
      'phase:resolving:0',
      'phase:chart_versions:2',
      'chart:app-a:outdated',
      'chart:app-b:outdated',
      'phase:images:2',
      'images:1',
      'images:1',
      'phase:vulnerabilities:1',
      'scanned:docker.io/library/redis:7.0',
    ]);
    expect(scanImage).toHaveBeenCalledTimes(1);
    expect(cves).toEqual([
      expect.objectContaining({ applicationName: 'app-a', image: 'docker.io/library/redis' }),
      expect.objectContaining({ applicationName: 'app-b', image: 'docker.io/library/redis' }),
    ]);
  });
});
