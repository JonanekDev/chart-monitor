import { describe, expect, it } from 'vitest';
import {
  buildNotification,
  type NotifyRules,
  type ScanSnapshot,
} from '../notify/buildNotification.js';
import { toDiscordPayload, toWebhookPayload } from '../notify/format.js';

const rules: NotifyRules = {
  minSeverity: 'HIGH',
  onlyFixable: true,
  chartUpdates: 'any',
  onFailure: true,
};

type Cve = ScanSnapshot['cves'][number];
const cve = (
  id: string,
  severity: Cve['severity'],
  fixedVersion: string | null,
  more: Partial<Cve> = {},
): Cve => ({
  applicationName: 'app-a',
  image: 'quay.io/cilium/cilium',
  vulnerabilityId: id,
  pkgName: 'openssl',
  installedVersion: '3.0.1',
  fixedVersion,
  severity,
  title: null,
  ...more,
});
const chart = (latestVersion: string | null, status = 'outdated') => ({
  applicationName: 'cilium',
  chartName: 'cilium',
  currentVersion: '1.20.4',
  latestVersion,
  status,
});
const scan = (
  cves: Cve[],
  charts: ScanSnapshot['charts'] = [chart('1.20.4', 'up_to_date')],
  state = 'succeeded',
  images = [{ image: 'quay.io/cilium/cilium', currentTag: 'v1.20.4' }],
): ScanSnapshot => ({
  state,
  errorMessage: state === 'failed' ? 'Could not clone' : null,
  charts,
  cves,
  images,
});

describe('buildNotification', () => {
  it('sends one overview for the first scan', () => {
    const first = scan(
      [
        cve('CVE-1', 'CRITICAL', '3.0.2'),
        cve('CVE-2', 'HIGH', '3.0.2'),
        cve('CVE-3', 'HIGH', null),
      ],
      [chart('1.20.5')],
    );
    const content = buildNotification(rules, first, null)!;
    expect(content.kind).toBe('baseline');
    expect(content.summary).toBe(
      'Monitoring started: 1 chart update, 1 critical, 1 high fixable vulnerabilities',
    );
    expect(content.newVulnerabilities.map((v) => v.vulnerabilityId)).toEqual(['CVE-1', 'CVE-2']);
  });

  it('stays silent when nothing changed', () => {
    const s = scan([cve('CVE-1', 'CRITICAL', '3.0.2')], [chart('1.20.5')]);
    expect(buildNotification(rules, s, s)).toBeNull();
  });

  it('reports only new CVEs at or above the severity, fixable only', () => {
    const before = scan([cve('CVE-1', 'HIGH', '3.0.2')]);
    const now = scan([
      cve('CVE-1', 'HIGH', '3.0.2'),
      cve('CVE-2', 'CRITICAL', '3.0.2'),
      cve('CVE-3', 'MEDIUM', '3.0.2'),
      cve('CVE-4', 'HIGH', null),
    ]);
    const content = buildNotification(rules, now, before)!;
    expect(content.kind).toBe('changes');
    expect(content.newVulnerabilities.map((v) => v.vulnerabilityId)).toEqual(['CVE-2']);

    const anyFix = buildNotification(
      { ...rules, onlyFixable: false, minSeverity: 'MEDIUM' },
      now,
      before,
    )!;
    expect(anyFix.newVulnerabilities.map((v) => v.vulnerabilityId)).toEqual([
      'CVE-2',
      'CVE-4',
      'CVE-3',
    ]);
  });

  it('reports a known CVE again once a fix becomes available', () => {
    const before = scan([cve('CVE-1', 'HIGH', null)]);
    const now = scan([cve('CVE-1', 'HIGH', '3.0.2')]);
    expect(buildNotification(rules, now, before)!.newVulnerabilities).toHaveLength(1);
  });

  it('merges one CVE found in an image used by several applications', () => {
    const now = scan([
      cve('CVE-1', 'HIGH', '3.0.2'),
      cve('CVE-1', 'HIGH', '3.0.2', { applicationName: 'app-b' }),
    ]);
    const [v] = buildNotification(rules, now, scan([]))!.newVulnerabilities;
    expect(v!.applications).toEqual(['app-a', 'app-b']);
  });

  it('announces a chart version once, and respects chartUpdates off', () => {
    const before = scan([], [chart('1.20.4', 'up_to_date')]);
    const now = scan([], [chart('1.20.5')]);
    expect(buildNotification(rules, now, before)!.chartUpdates).toEqual([
      {
        applicationName: 'cilium',
        chartName: 'cilium',
        currentVersion: '1.20.4',
        latestVersion: '1.20.5',
        warnings: [],
        vulnerabilities: null,
        changelog: null,
      },
    ]);
    expect(buildNotification(rules, now, now)).toBeNull(); // same latest version again
    expect(buildNotification({ ...rules, chartUpdates: 'off' }, now, before)).toBeNull();
    const risky = scan(
      [],
      [
        {
          ...chart('1.20.5'),
          upgrade: {
            removedValues: ['a.b'],
            manifestChanges: [],
            renderError: null,
            vulnerabilities: null,
            changelog: null,
          },
        },
      ],
    );
    expect(buildNotification(rules, risky, before)!.chartUpdates[0]?.warnings).toEqual([
      'values no longer in the chart: a.b',
    ]);
    const rbac = scan(
      [],
      [
        {
          ...chart('1.20.5'),
          upgrade: {
            removedValues: [],
            manifestChanges: [
              {
                resource: 'ClusterRole op',
                change: 'changed',
                fields: [],
                fieldsNotListed: 0,
                immutableFields: [],
                rbacFields: ['rules'],
              },
              {
                resource: 'RoleBinding ops/ci',
                change: 'added',
                fields: [],
                fieldsNotListed: 0,
                immutableFields: [],
                rbacFields: ['subjects', 'roleRef'],
              },
            ],
            renderError: null,
            vulnerabilities: null,
            changelog: null,
          },
        },
      ],
    );
    const withChangelog = scan(
      [],
      [
        {
          ...chart('1.20.5'),
          upgrade: {
            removedValues: [],
            manifestChanges: [],
            renderError: null,
            vulnerabilities: null,
            changelog: {
              versions: [
                {
                  version: '1.20.5',
                  changes: [
                    { kind: 'security', description: 'Fix CVE-1 in the agent', links: [] },
                    { kind: 'removed', description: 'Drop the old flag', links: [] },
                  ],
                },
                {
                  version: '1.20.4',
                  changes: [{ kind: 'deprecated', description: 'x', links: [] }],
                },
              ],
              notLoaded: 0,
              releasesUrl: 'https://github.com/cilium/cilium/releases?q=1.20.5&expanded=true',
            },
          },
        },
      ],
    );
    const content = buildNotification(rules, withChangelog, before)!;
    const text = toWebhookPayload(content, { repo: 'o/r', scanUrl: null }).text;
    expect(text).toContain('⚠ security (1.20.5): Fix CVE-1 in the agent');
    expect(text).toContain(
      'changelog: 1 removed, 1 deprecated · https://github.com/cilium/cilium/releases?q=1.20.5&expanded=true',
    );
    expect(text).not.toContain('Drop the old flag');
    // The JSON webhook gets the whole changelog
    expect(content.chartUpdates[0]?.changelog?.versions).toHaveLength(2);
    expect(buildNotification(rules, rbac, before)!.chartUpdates[0]?.warnings).toEqual([
      'ClusterRole op: RBAC rules change, review the permissions',
      'RoleBinding ops/ci: new, review the permissions it grants',
    ]);
    expect(buildNotification(rules, scan([], [chart('1.21.0')]), now)!.summary).toBe(
      'New: 1 chart update',
    );
  });

  it("with chartUpdates 'fixes', announces only upgrades that fix CVEs from minSeverity up", () => {
    const change = (id: string, severity: Cve['severity']) => ({
      vulnerabilityId: id,
      pkgName: 'openssl',
      severity,
      image: 'quay.io/cilium/cilium',
      title: null,
    });
    const upgraded = (fixed: ReturnType<typeof change>[]) =>
      scan(
        [],
        [
          {
            ...chart('1.20.5'),
            upgrade: {
              removedValues: [],
              manifestChanges: [],
              renderError: null,
              vulnerabilities: { fixed, introduced: [change('CVE-9', 'HIGH')] },
              changelog: null,
            },
          },
        ],
      );
    const fixes = { ...rules, chartUpdates: 'fixes' as const };
    const before = scan([], [chart('1.20.4', 'up_to_date')]);

    expect(buildNotification(fixes, upgraded([change('CVE-1', 'MEDIUM')]), before)).toBeNull();

    const fixing = upgraded([change('CVE-1', 'CRITICAL'), change('CVE-2', 'LOW')]);
    const content = buildNotification(fixes, fixing, before)!;
    expect(content.chartUpdates[0]?.vulnerabilities).toEqual({
      fixed: { CRITICAL: 1 },
      introduced: { HIGH: 1 },
    });
    expect(toWebhookPayload(content, { repo: 'o/r', scanUrl: null }).text).toContain(
      'cilium 1.20.4 → 1.20.5 (cilium) · fixes 1 critical · adds 1 high',
    );
    // Already announced, even though the previous scan's latest version was the same
    expect(buildNotification(fixes, fixing, fixing)).toBeNull();
    // Starts fixing something later (vulnerability DB update): news then
    expect(buildNotification(fixes, fixing, upgraded([]))).not.toBeNull();
  });

  it('reports failures unless turned off', () => {
    const failed = scan([], [], 'failed');
    expect(buildNotification(rules, failed, null)).toMatchObject({
      kind: 'failure',
      error: 'Could not clone',
    });
    expect(buildNotification({ ...rules, onFailure: false }, failed, null)).toBeNull();
  });

  it('ignores CVEs entirely when minSeverity is off', () => {
    const now = scan([cve('CVE-1', 'CRITICAL', '3.0.2')]);
    expect(buildNotification({ ...rules, minSeverity: null }, now, scan([]))).toBeNull();
  });
});

describe('vulnerability groups', () => {
  const harbor = (image: string, id: string, severity: Cve['severity'], fixed = '8.23.0') =>
    ['curl', 'curl-libs'].map((pkgName) =>
      cve(id, severity, fixed, { applicationName: 'harbor', image, pkgName }),
    );
  const images = (tag: string) => [
    { image: 'harbor-core', currentTag: 'v2.15.4' },
    { image: 'harbor-portal', currentTag: tag },
  ];

  it('counts each id once, under its highest severity, and says why it is new', () => {
    const now = scan(
      [
        ...harbor('harbor-core', 'CVE-1', 'CRITICAL'),
        ...harbor('harbor-portal', 'CVE-1', 'HIGH'),
        ...harbor('harbor-portal', 'CVE-2', 'HIGH'),
      ],
      undefined,
      undefined,
      images('v2.16.0'),
    );
    const content = buildNotification(
      rules,
      now,
      scan([], undefined, undefined, images('v2.15.4')),
    )!;

    // CVE-1 hit the unchanged harbor-core: an advisory, though the upgraded portal has it too
    expect(content.summary).toBe(
      'New: 1 critical fixable vulnerability in new advisories for unchanged images, ' +
        '1 high fixable vulnerability introduced by changes',
    );
    expect(content.newVulnerabilities).toHaveLength(6);
    expect(content.vulnerabilityGroups[0]).toMatchObject({
      vulnerabilityId: 'CVE-1',
      severity: 'CRITICAL',
      packages: ['curl', 'curl-libs'],
      images: ['harbor-core', 'harbor-portal'],
      reason: 'advisory',
      knownElsewhere: false,
    });
    const text = toWebhookPayload(content, { repo: 'o/r', scanUrl: null }).text;
    expect(text).toContain('New advisories for unchanged images: 1 critical');
    expect(text).toContain('CRITICAL CVE-1 in curl, curl-libs 3.0.1 → 8.23.0 · 2 images (harbor)');
    expect(text).toContain('Introduced by changes: 1 high');
  });

  it('lists a known id in a new image without counting it as a new vulnerability', () => {
    const before = scan(harbor('harbor-core', 'CVE-1', 'HIGH'), undefined, undefined, images('x'));
    const now = scan(
      [...harbor('harbor-core', 'CVE-1', 'HIGH'), ...harbor('harbor-portal', 'CVE-1', 'HIGH', '9')],
      undefined,
      undefined,
      images('y'),
    );
    const content = buildNotification(rules, now, before)!;
    expect(content.summary).toBe('New: 1 known vulnerability in new images');
    const text = toWebhookPayload(content, { repo: 'o/r', scanUrl: null }).text;
    expect(text).toContain('Introduced by changes: none new');
    expect(text).toContain('HIGH CVE-1 in curl, curl-libs 3.0.1 → 9 · +1 new image (harbor)');
  });

  it('notes other versions and sorts by severity, fix, then images affected', () => {
    const now = scan([
      cve('CVE-A', 'HIGH', null, { image: 'a' }),
      cve('CVE-B', 'HIGH', '2', { image: 'a' }),
      cve('CVE-C', 'HIGH', '2', { image: 'a' }),
      cve('CVE-C', 'HIGH', '3', { image: 'b', installedVersion: '2.9' }),
    ]);
    const content = buildNotification({ ...rules, onlyFixable: false }, now, scan([]))!;
    expect(content.vulnerabilityGroups.map((g) => g.vulnerabilityId)).toEqual([
      'CVE-C',
      'CVE-B',
      'CVE-A',
    ]);
    expect(toWebhookPayload(content, { repo: 'o/r', scanUrl: null }).text).toContain(
      'CVE-C in openssl 3.0.1 → 2 (+1 other version) · 2 images',
    );
  });
});

describe('payloads', () => {
  const content = buildNotification(
    { ...rules, onlyFixable: false },
    scan(
      Array.from({ length: 300 }, (_, i) =>
        cve(`CVE-${i}`, 'CRITICAL', null, { title: '@everyone look' }),
      ),
    ),
    scan([]),
  )!;
  const ctx = { repo: 'org/repo@main', scanUrl: 'https://cm.example.com/scans/1' };

  it('builds a size-limited Discord embed that cannot ping anyone', () => {
    const payload = toDiscordPayload(content, ctx);
    expect(payload.allowed_mentions).toEqual({ parse: [] });
    expect(payload.embeds[0]!.description.length).toBeLessThanOrEqual(4096);
    expect(payload.embeds[0]).toMatchObject({
      title: 'org/repo@main',
      url: ctx.scanUrl,
      color: 0xef4444,
    });
    expect(payload.embeds[0]!.description).toContain('…and 290 more');
  });

  it('builds a generic webhook body with full data and plain text', () => {
    const payload = toWebhookPayload(content, ctx);
    expect(payload.newVulnerabilities).toHaveLength(300);
    expect(payload.text.startsWith('org/repo@main: New: 300 critical vulnerabilities')).toBe(true);
    expect(payload.text).not.toContain('**');
  });
});
