import {
  countBySeverity,
  severityRank,
  type ChartUpdateMode,
  type ChartUpgrade,
  type CveSeverityValue,
  type SeverityCounts,
} from '@chart-monitor/shared';

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
  images: { image: string; currentTag: string }[];
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

/** All new occurrences of one vulnerability id */
export interface VulnerabilityGroup {
  vulnerabilityId: string;
  /** The highest one: distros may rate the same CVE differently */
  severity: CveSeverityValue;
  title: string | null;
  packages: string[];
  /** Distinct installed → fixed pairs, most common first */
  versions: { installed: string; fixed: string | null }[];
  images: string[];
  applications: string[];
  /** advisory: found in an image that didn't change, so a vulnerability DB update, not something
   * you did; change: came with a new image or tag. null in the first overview */
  reason: 'advisory' | 'change' | null;
  /** The id was already reported for other images: these are more images with it, not a new
   * vulnerability, so it isn't counted as one */
  knownElsewhere: boolean;
}

export interface NotificationContent {
  /** baseline: first successful scan of a monitor; changes: something new since the last one */
  kind: 'baseline' | 'changes' | 'failure';
  summary: string;
  /** One entry per image + CVE + package (kept as is for webhook consumers) */
  newVulnerabilities: NewVulnerability[];
  /** The same, one entry per vulnerability id, most important first */
  vulnerabilityGroups: VulnerabilityGroup[];
  chartUpdates: ChartUpdate[];
  error: string | null;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** CVEs passing the monitor's filter, one entry per image + CVE + package (an image used by
 * several applications is reported once). Most severe first. */
function relevantVulnerabilities(
  scan: ScanSnapshot,
  rules: NotifyRules,
): Map<string, NewVulnerability> {
  const result = new Map<string, NewVulnerability>();
  if (!rules.minSeverity) return result;
  const minRank = severityRank(rules.minSeverity);
  const sorted = [...scan.cves].sort((a, b) => severityRank(b.severity) - severityRank(a.severity));
  for (const cve of sorted) {
    if (severityRank(cve.severity) < minRank) continue;
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
  for (const change of upgrade.manifestChanges.filter((c) => c.rbacFields?.length)) {
    warnings.push(
      change.change === 'added'
        ? `${change.resource}: new, review the permissions it grants`
        : `${change.resource}: RBAC ${change.rbacFields.join(', ')} change, review the permissions`,
    );
  }
  return warnings;
}

/** Distinct ids from `minSeverity` up (all when null) */
function countFrom(
  list: { vulnerabilityId: string; severity: CveSeverityValue }[],
  minSeverity: NotifyRules['minSeverity'],
): SeverityCounts {
  return Object.fromEntries(
    Object.entries(countBySeverity(list)).filter(
      ([severity]) =>
        !minSeverity || severityRank(severity as CveSeverityValue) >= severityRank(minSeverity),
    ),
  );
}

/** `10 critical, 27 high` */
export const describeCounts = (counts: SeverityCounts) =>
  Object.entries(counts)
    .map(([severity, n]) => `${n} ${severity.toLowerCase()}`)
    .join(', ');

function groupVulnerabilities(
  vulns: NewVulnerability[],
  reasonOf: (v: NewVulnerability) => VulnerabilityGroup['reason'],
  knownIds: Set<string>,
): VulnerabilityGroup[] {
  const groups = new Map<string, VulnerabilityGroup & { pairs: Map<string, number> }>();
  for (const v of vulns) {
    let group = groups.get(v.vulnerabilityId);
    if (!group) {
      group = {
        vulnerabilityId: v.vulnerabilityId,
        severity: v.severity,
        title: v.title,
        packages: [],
        versions: [],
        images: [],
        applications: [],
        reason: reasonOf(v),
        knownElsewhere: knownIds.has(v.vulnerabilityId),
        pairs: new Map(),
      };
      groups.set(v.vulnerabilityId, group);
    }
    if (severityRank(v.severity) > severityRank(group.severity)) group.severity = v.severity;
    group.title ??= v.title;
    // Hit by an advisory anywhere means it's a DB update, even if a changed image has it too
    if (reasonOf(v) === 'advisory') group.reason = 'advisory';
    const pair = JSON.stringify([v.installedVersion, v.fixedVersion]);
    group.pairs.set(pair, (group.pairs.get(pair) ?? 0) + 1);
    for (const [list, items] of [
      [group.packages, [v.pkgName]],
      [group.images, [v.image]],
      [group.applications, v.applications],
    ] as const) {
      for (const item of items) if (!list.includes(item)) list.push(item);
    }
  }

  return [...groups.values()]
    .map(({ pairs, ...group }) => ({
      ...group,
      versions: [...pairs]
        .sort(([, a], [, b]) => b - a)
        .map(([pair]) => {
          const [installed, fixed] = JSON.parse(pair) as [string, string | null];
          return { installed, fixed };
        }),
    }))
    .sort(
      (a, b) =>
        severityRank(b.severity) - severityRank(a.severity) ||
        Number(b.versions.some((v) => v.fixed)) - Number(a.versions.some((v) => v.fixed)) ||
        b.images.length - a.images.length,
    );
}

/** Groups counted as new vulnerabilities */
const countNew = (groups: VulnerabilityGroup[]) =>
  countBySeverity(groups.filter((g) => !g.knownElsewhere));

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

/** `10 critical, 27 high fixable vulnerabilities` */
function describeVulnerabilities(counts: SeverityCounts, fixableOnly: boolean): string {
  const n = Object.values(counts).reduce((sum, count) => sum + count, 0);
  return `${describeCounts(counts) || '0'} ${fixableOnly ? 'fixable ' : ''}${n === 1 ? 'vulnerability' : 'vulnerabilities'}`;
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
      vulnerabilityGroups: [],
      chartUpdates: [],
      error: current.errorMessage,
    };
  }
  if (current.state !== 'succeeded') return null;

  const vulns = relevantVulnerabilities(current, rules);
  const updates = availableUpdates(current, rules);

  if (!previous) {
    // First scan: everything would be "new", so send one overview instead of a flood
    const groups = groupVulnerabilities([...vulns.values()], () => null, new Set());
    const parts = [plural(updates.size, 'chart update')];
    if (rules.minSeverity) parts.push(describeVulnerabilities(countNew(groups), rules.onlyFixable));
    return {
      kind: 'baseline',
      summary: `Monitoring started: ${parts.join(', ')}`,
      newVulnerabilities: [...vulns.values()],
      vulnerabilityGroups: groups,
      chartUpdates: [...updates.values()],
      error: null,
    };
  }

  const before = relevantVulnerabilities(previous, rules);
  const newVulns = [...vulns].filter(([key]) => !before.has(key)).map(([, v]) => v);

  // ponytail: a moved tag (latest) counts as unchanged; compare digests if that misleads
  const previousRefs = new Set(previous.images.map((i) => `${i.image}:${i.currentTag}`));
  const unchanged = (image: string) =>
    current.images.some((i) => i.image === image && previousRefs.has(`${i.image}:${i.currentTag}`));
  const groups = groupVulnerabilities(
    newVulns,
    (v) => (unchanged(v.image) ? 'advisory' : 'change'),
    new Set([...before.values()].map((v) => v.vulnerabilityId)),
  );

  // A chart update is news once: when its latest version first shows up (with 'fixes': first
  // fixes something, the vulnerability DB keeps changing)
  const previousUpdates = availableUpdates(previous, rules);
  const newUpdates = [...updates.values()].filter(
    (u) => previousUpdates.get(chartKey(u))?.latestVersion !== u.latestVersion,
  );

  if (newVulns.length === 0 && newUpdates.length === 0) return null;
  const advisories = countNew(groups.filter((g) => g.reason === 'advisory'));
  const introduced = countNew(groups.filter((g) => g.reason === 'change'));
  const parts = [];
  if (Object.keys(advisories).length) {
    parts.push(
      `${describeVulnerabilities(advisories, rules.onlyFixable)} in new advisories for unchanged images`,
    );
  }
  if (Object.keys(introduced).length) {
    parts.push(`${describeVulnerabilities(introduced, rules.onlyFixable)} introduced by changes`);
  }
  const knownInNewImages = groups.filter((g) => g.knownElsewhere).length;
  if (parts.length === 0 && knownInNewImages) {
    const word = knownInNewImages === 1 ? 'vulnerability' : 'vulnerabilities';
    parts.push(`${knownInNewImages} known ${word} in new images`);
  }
  if (newUpdates.length) parts.push(plural(newUpdates.length, 'chart update'));
  return {
    kind: 'changes',
    summary: `New: ${parts.join(', ')}`,
    newVulnerabilities: newVulns,
    vulnerabilityGroups: groups,
    chartUpdates: newUpdates,
    error: null,
  };
}
