import type { ChartUpdate, NotificationContent, SeverityCounts } from './buildNotification.js';

export interface NotificationContext {
  /** Short repo label, e.g. org/repo@main */
  repo: string;
  /** Link to the scan in the UI; null when PUBLIC_URL isn't set */
  scanUrl: string | null;
}

const MAX_LISTED = 10;
// Discord embed description limit is 4096; stay clear of it
const MAX_DESCRIPTION = 3800;

const COLORS = { failure: 0xef4444, critical: 0xef4444, high: 0xf97316, other: 0x1caf87 };

const describeCounts = (counts: SeverityCounts) =>
  Object.entries(counts)
    .map(([severity, n]) => `${n} ${severity.toLowerCase()}`)
    .join(', ');

/** ` · fixes 3 critical, 10 high · adds 1 high` */
function describeChange({ vulnerabilities }: ChartUpdate): string {
  if (!vulnerabilities) return '';
  const fixed = describeCounts(vulnerabilities.fixed);
  const introduced = describeCounts(vulnerabilities.introduced);
  return `${fixed ? ` · fixes ${fixed}` : ''}${introduced ? ` · adds ${introduced}` : ''}`;
}

function lines(content: NotificationContent): string[] {
  const out: string[] = [];
  if (content.error) out.push(`\`${content.error.slice(0, 500)}\``);

  if (content.newVulnerabilities.length) {
    out.push('', '**Vulnerabilities**');
    for (const v of content.newVulnerabilities.slice(0, MAX_LISTED)) {
      const fix = v.fixedVersion ? ` → fixed in ${v.fixedVersion}` : '';
      out.push(
        `• **${v.severity}** ${v.vulnerabilityId} in ${v.pkgName} ${v.installedVersion}${fix} · \`${v.image}\``,
      );
    }
    const more = content.newVulnerabilities.length - MAX_LISTED;
    if (more > 0) out.push(`…and ${more} more`);
  }

  if (content.chartUpdates.length) {
    out.push('', '**Chart updates**');
    for (const u of content.chartUpdates.slice(0, MAX_LISTED)) {
      out.push(
        `• ${u.chartName} ${u.currentVersion} → ${u.latestVersion} (${u.applicationName})${describeChange(u)}`,
      );
      for (const warning of u.warnings) out.push(`  ⚠ ${warning}`);
    }
    const more = content.chartUpdates.length - MAX_LISTED;
    if (more > 0) out.push(`…and ${more} more`);
  }
  return out;
}

function color(content: NotificationContent): number {
  if (content.kind === 'failure') return COLORS.failure;
  if (content.newVulnerabilities.some((v) => v.severity === 'CRITICAL')) return COLORS.critical;
  if (content.newVulnerabilities.some((v) => v.severity === 'HIGH')) return COLORS.high;
  return COLORS.other;
}

/** One embed per scan: summary, the most severe items, and a link to the full scan */
export function toDiscordPayload(content: NotificationContent, ctx: NotificationContext) {
  let description = [content.summary, ...lines(content)].join('\n');
  if (description.length > MAX_DESCRIPTION)
    description = `${description.slice(0, MAX_DESCRIPTION)}…`;
  return {
    username: 'chart-monitor',
    embeds: [
      {
        title: ctx.repo,
        ...(ctx.scanUrl ? { url: ctx.scanUrl } : {}),
        description,
        color: color(content),
      },
    ],
    // Never ping @everyone/@here from repo-controlled text (CVE titles, error messages)
    allowed_mentions: { parse: [] },
  };
}

/** Plain JSON for ntfy, Gotify, n8n, scripts…: the full data plus a readable `text` */
export function toWebhookPayload(content: NotificationContent, ctx: NotificationContext) {
  return {
    source: 'chart-monitor',
    repo: ctx.repo,
    scanUrl: ctx.scanUrl,
    ...content,
    text: [`${ctx.repo}: ${content.summary}`, ...lines(content)].join('\n').replaceAll('**', ''),
  };
}
