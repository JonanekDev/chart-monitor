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
  fetchChartVersions: async () => [{ version: '1.0.0' }, { version: '2.0.0' }],
}));
const deployment = (tag: string, app: string) => ({
  kind: 'Deployment',
  metadata: { name: 'redis' },
  spec: {
    selector: { matchLabels: { app } },
    template: {
      spec: { containers: [{ name: 'redis', image: `docker.io/library/redis:${tag}` }] },
    },
  },
});
vi.mock('../helm/renderChart.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  renderChart: async (_helm: unknown, { targetRevision }: { targetRevision: string }) =>
    targetRevision === '1.0.0' ? [deployment('7.0', 'redis')] : [deployment('7.2', 'cache')],
  pullChart: async () => ({ defaults: {}, metadata: {} }),
}));
vi.mock('../registry/imageRef.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  fetchImageTags: async () => ['7.0', '7.2'],
}));
// The upgraded image (redis:7.2) has the CVE fixed
const scanImage = vi.fn(async (image: string) =>
  image.endsWith(':7.0')
    ? [
        {
          vulnerabilityId: 'CVE-1',
          pkgName: 'openssl',
          installedVersion: '1',
          fixedVersion: '2',
          severity: 'HIGH' as const,
          title: null,
        },
      ]
    : [],
);
vi.mock('../trivy/scanImage.js', () => ({ scanImageForVulnerabilities: scanImage }));

const { executeScan, classifyOutdatedImages } = await import('../scan/runScan.js');

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
        chartUpgrade: async (chart, { manifestChanges, vulnerabilities }) =>
          events.push(
            `upgrade:${chart.applicationName}:${manifestChanges.flatMap((c) => c.immutableFields)}` +
              (vulnerabilities
                ? `:fixes ${vulnerabilities.fixed.map((v) => v.vulnerabilityId)}`
                : ''),
          ),
        imageFindings: async (f) => events.push(`images:${f.map((i) => i.tagSource)}`),
        latestTagChecked: async (image) => events.push(`latest-tag:${image.repository}`),
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
      // The tag is the chart's default, and the chart upgrade brings the newer one: no tag scan
      'images:chart',
      'images:chart',
      'phase:upgrades:2',
      'upgrade:app-a:spec.selector',
      'upgrade:app-b:spec.selector',
      'phase:vulnerabilities:2',
      'scanned:docker.io/library/redis:7.0',
      'upgrade:app-a:spec.selector:fixes CVE-1',
      'upgrade:app-b:spec.selector:fixes CVE-1',
    ]);
    // Once per image, though two applications use it; the upgraded image isn't stored as findings
    expect(scanImage).toHaveBeenCalledTimes(2);
    expect(cves).toEqual([
      expect.objectContaining({ applicationName: 'app-a', image: 'docker.io/library/redis' }),
      expect.objectContaining({ applicationName: 'app-b', image: 'docker.io/library/redis' }),
    ]);
  });
});

describe('classifyOutdatedImages', () => {
  const job = {
    applicationName: 'app',
    applicationSetName: '',
    ctx: { openRepo: async () => memoryRepo({}), warn: () => {} },
    source: { repoURL: 'https://charts.example.com', chart: 'redis', targetRevision: '1.0.0' },
    valuesDocuments: ['app: { tag: 1.0 }'],
    // renderChart is mocked, so the session is never used
    helm: null as never,
    changelogCache: null as never,
    repoIndexes: new Map(),
  };
  const finding = (image: string, currentTag: string, latestTag: string) => ({
    applicationName: 'app',
    image,
    currentTag,
    latestTag,
    status: 'outdated' as const,
    note: null,
    vulnerabilitiesScanned: false,
    tagSource: null,
    latestTagCheck: null,
  });
  const images = ['docker.io/library/redis:7.0', 'quay.io/x/app:1.0'];

  it('tells chart defaults from values, and scans only sure latest tags', async () => {
    const findings = [
      finding('docker.io/library/redis', '7.0', '7.2'),
      finding('quay.io/x/app', '1.0', '1.1-rc1'),
    ];
    const scans = await classifyOutdatedImages(job, false, images, findings);

    expect(findings.map((f) => f.tagSource)).toEqual(['chart', 'values']);
    expect(scans.map((s) => s.latestRef)).toEqual(['docker.io/library/redis:7.2']);
    expect(findings[1]!.latestTagCheck).toEqual({ result: 'variant_unclear' });
  });

  it('ignores the registry, and falls back to the values text for images only values render', async () => {
    const findings = [
      // Mirrored (global.imageRegistry): still the chart's default redis:7.0
      finding('mirror.example.com/library/redis', '7.0', '7.2'),
      // Same repository, another tag: overridden in values
      finding('docker.io/library/redis', '6.2', '7.2'),
      // Not rendered without values; 1.0 is written in them
      finding('quay.io/x/app', '1.0', '1.1'),
      // Not rendered without values either, but its tag isn't in them (1.0 ≠ 1.0.5)
      finding('quay.io/x/sidecar', '1.0.5', '1.1.0'),
    ];
    await classifyOutdatedImages(
      job,
      false,
      [
        'mirror.example.com/library/redis:7.0',
        'redis:6.2',
        'quay.io/x/app:1.0',
        'quay.io/x/sidecar:1.0.5',
      ],
      findings,
    );
    expect(findings.map((f) => f.tagSource)).toEqual(['chart', 'values', 'values', 'chart']);
  });

  it('leaves chart defaults to the chart upgrade when the chart is outdated', async () => {
    const findings = [finding('docker.io/library/redis', '7.0', '7.2')];
    expect(await classifyOutdatedImages(job, true, images, findings)).toEqual([]);
    expect(findings[0]!.tagSource).toBe('chart');
  });
});
