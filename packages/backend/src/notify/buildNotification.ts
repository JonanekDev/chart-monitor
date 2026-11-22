import type { ChartUpdateMode, ChartUpgrade, CveSeverityValue } from '@chart-monitor/shared';

export interface NotifyRules {
  minSeverity: 'CRITICAL' | 'HIGH' | 'MEDIUM' | null;
  onlyFixable: boolean;
  chartUpdates: ChartUpdateMode;
  onFailure: boolean;
}

/** What notifications need to know about one scan */
export interface ScanSnapshot {
  state: string;
  errorMessage: string | null;
  charts: {
    applicationName: string;
    chartName: string;
    currentVersion: string;
    latestVersion: string | null;
    status: string;
    upgrade?: ChartUpgrade | null;
  }[];
  cves: {
    applicationName: string;
    image: string;
    vulnerabilityId: string;
    pkgName: string;
    installedVersion: string;
    fixedVersion: string | null;
    severity: CveSeverityValue;
    title: string | null;
  }[];
}

export interface NewVulnerability {
  image: string;
  vulnerabilityId: string;
  pkgName: string;
  severity: CveSeverityValue;
  installedVersion: string;
  fixedVersion: string | null;
  title: string | null;
  /** Applications running the affected image */
  applications: string[];
}

export interface ChartUpdate {
  applicationName: string;
  chartName: string;
  currentVersion: string;
  latestVersion: string;
  /** What would break when upgrading */
  warnings: string[];
  /** CVEs from the monitor's minimum severity up that upgrading gets rid of / brings in, by
   * severity; null when unknown */
  vulnerabilities: { fixed: SeverityCounts; introduced: SeverityCounts } | null;
}

export type SeverityCounts = Partial<Record<CveSeverityValue, number>>;

export interface NotificationContent {
  /** baseline: first successful scan of a monitor; changes: something new since the last one */
  kind: 'baseline' | 'changes' | 'failure';
  summary: string;
  newVulnerabilities: NewVulnerability[];
  chartUpdates: ChartUpdate[];
  error: string | null;
}

const SEVERITY_RANK: Record<CveSeverityValue, number> = {
  CRITICAL: 4,
  HIGH: 3,
  MEDIUM: 2,
  LOW: 1,
  UNKNOWN: 0,
};

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** CVEs passing the monitor's filter, one entry per image + CVE + package (an image used by
 * several applications is reported once). Most severe first. */
function relevantVulnerabilities(
  scan: ScanSnapshot,
  rules: NotifyRules,
): Map<string, NewVulnerability> {
  const result = new Map<string, NewVulnerability>();
  if (!rules.minSeverity) return result;
  const minRank = SEVERITY_RANK[rules.minSeverity];
  const sorted = [...scan.cves].sort(
    (a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity],
  );
  for (const cve of sorted) {
    if (SEVERITY_RANK[cve.severity] < minRank) continue;
    if (rules.onlyFixable && !cve.fixedVersion) continue;
    const key = `${cve.image}|${cve.vulnerabilityId}|${cve.pkgName}`;
    const existing = result.get(key);
    if (existing) {
      if (!existing.applications.includes(cve.applicationName)) {
        existing.applications.push(cve.applicationName);
      }
      continue;
    }
    const { applicationName, ...rest } = cve;
    result.set(key, { ...rest, applications: [applicationName] });
  }
  return result;
}

const chartKey = (c: { applicationName: string; chartName: string }) =>
  `${c.applicationName}|${c.chartName}`;

function upgradeWarnings(upgrade: ChartUpgrade | null | undefined): string[] {
  if (!upgrade) return [];
  const warnings: string[] = [];
  if (upgrade.renderError)
    warnings.push(`fails to render with your values: ${upgrade.renderError}`);
  if (upgrade.removedValues.length) {
    warnings.push(`values no longer in the chart: ${upgrade.removedValues.join(', ')}`);
  }
  for (const change of upgrade.manifestChanges.filter((c) => c.immutableFields.length)) {
    warnings.push(
      `${change.resource}: immutable ${change.immutableFields.join(', ')} changes, sync fails until it is replaced`,
    );
  }
  return warnings;
}

/** Most severe first, like the input */
function countFrom(
  list: { severity: CveSeverityValue }[],
  minSeverity: NotifyRules['minSeverity'],
): SeverityCounts {
  const counts: SeverityCounts = {};
  for (const { severity } of list) {
    if (minSeverity && SEVERITY_RANK[severity] < SEVERITY_RANK[minSeverity]) continue;
    counts[severity] = (counts[severity] ?? 0) + 1;
  }
  return counts;
}

/** Outdated charts the monitor's rules want to hear about */
function availableUpdates(scan: ScanSnapshot, rules: NotifyRules): Map<string, ChartUpdate> {
  if (rules.chartUpdates === 'off') return new Map();
  const updates = scan.charts
    .filter((c) => c.status === 'outdated' && c.latestVersion)
    .map((c): ChartUpdate => {
      // Upgrades stored before vulnerability comparisons existed have no such field
      const vulns = c.upgrade?.vulnerabilities;
      return {
        applicationName: c.applicationName,
        chartName: c.chartName,
        currentVersion: c.currentVersion,
        latestVersion: c.latestVersion!,
        warnings: upgradeWarnings(c.upgrade),
        vulnerabilities: vulns
          ? {
              fixed: countFrom(vulns.fixed, rules.minSeverity),
              introduced: countFrom(vulns.introduced, rules.minSeverity),
            }
          : null,
      };
    })
    .filter(
      (u) => rules.chartUpdates !== 'fixes' || Object.keys(u.vulnerabilities?.fixed ?? {}).length,
    );
  return new Map(updates.map((u) => [chartKey(u), u]));
}

function describeVulnerabilities(vulns: NewVulnerability[], fixableOnly: boolean): string {
  const counts = new Map<string, number>();
  for (const v of vulns) counts.set(v.severity, (counts.get(v.severity) ?? 0) + 1);
  const parts = [...counts].map(([severity, n]) => `${n} ${severity.toLowerCase()}`);
  return `${parts.join(', ')} ${fixableOnly ? 'fixable ' : ''}${vulns.length === 1 ? 'vulnerability' : 'vulnerabilities'}`;
}

/**
 * Decides what (if anything) to tell about a finished scan, by comparing it with the monitor's
 * previous successful scan. Only news is reported, so a daily scan of an unchanged repo is silent.
 * Returns null when there is nothing to send.
 */
export function buildNotification(
  rules: NotifyRules,
  current: ScanSnapshot,
  previous: ScanSnapshot | null,
): NotificationContent | null {
  if (current.state === 'failed') {
    if (!rules.onFailure) return null;
    return {
      kind: 'failure',
      summary: 'Scan failed',
      newVulnerabilities: [],
      chartUpdates: [],
      error: current.errorMessage,
    };
  }
  if (current.state !== 'succeeded') return null;

  const vulns = relevantVulnerabilities(current, rules);
  const updates = availableUpdates(current, rules);

  if (!previous) {
    // First scan: everything would be "new", so send one overview instead of a flood
    const parts = [plural(updates.size, 'chart update')];
    if (rules.minSeverity)
      parts.push(
        describeVulnerabilities([...vulns.values()], rules.onlyFixable) || '0 vulnerabilities',
      );
    return {
      kind: 'baseline',
      summary: `Monitoring started: ${parts.join(', ')}`,
      newVulnerabilities: [...vulns.values()],
      chartUpdates: [...updates.values()],
      error: null,
    };
  }

  const before = relevantVulnerabilities(previous, rules);
  const newVulns = [...vulns].filter(([key]) => !before.has(key)).map(([, v]) => v);

  // A chart update is news once: when its latest version first shows up (with 'fixes': first
  // fixes something, the vulnerability DB keeps changing)
  const previousUpdates = availableUpdates(previous, rules);
  const newUpdates = [...updates.values()].filter(
    (u) => previousUpdates.get(chartKey(u))?.latestVersion !== u.latestVersion,
  );

  if (newVulns.length === 0 && newUpdates.length === 0) return null;
  const parts = [];
  if (newVulns.length) parts.push(`${describeVulnerabilities(newVulns, rules.onlyFixable)}`);
  if (newUpdates.length) parts.push(plural(newUpdates.length, 'chart update'));
  return {
    kind: 'changes',
    summary: `New: ${parts.join(', ')}`,
    newVulnerabilities: newVulns,
    chartUpdates: newUpdates,
    error: null,
  };
}
