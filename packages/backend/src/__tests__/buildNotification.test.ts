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
): ScanSnapshot => ({
  state,
  errorMessage: state === 'failed' ? 'Could not clone' : null,
  charts,
  cves,
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
          },
        },
      ],
    );
    expect(buildNotification(rules, risky, before)!.chartUpdates[0]?.warnings).toEqual([
      'values no longer in the chart: a.b',
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
