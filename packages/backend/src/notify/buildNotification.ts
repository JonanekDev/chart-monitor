import type { ChartUpdateMode, CveSeverityValue } from '@chart-monitor/shared';

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
}

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

function availableUpdates(scan: ScanSnapshot): Map<string, ChartUpdate> {
  return new Map(
    scan.charts
      .filter((c) => c.status === 'outdated' && c.latestVersion)
      .map((c) => [
        chartKey(c),
        {
          applicationName: c.applicationName,
          chartName: c.chartName,
          currentVersion: c.currentVersion,
          latestVersion: c.latestVersion!,
        },
      ]),
  );
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
  const updates = rules.chartUpdates === 'off' ? new Map() : availableUpdates(current);

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

  const previousLatest = new Map(previous.charts.map((c) => [chartKey(c), c.latestVersion]));
  // A chart update is news once: when its latest version first shows up
  const newUpdates = [...updates.values()].filter(
    (u: ChartUpdate) => previousLatest.get(chartKey(u)) !== u.latestVersion,
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
