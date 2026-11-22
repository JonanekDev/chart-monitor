import { countBySeverity } from '@chart-monitor/shared';
import {
  describeCounts,
  type ChartUpdate,
  type NotificationContent,
  type VulnerabilityGroup,
} from './buildNotification.js';

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

/** ` · fixes 3 critical, 10 high · adds 1 high` */
function describeChange({ vulnerabilities }: ChartUpdate): string {
  if (!vulnerabilities) return '';
  const fixed = describeCounts(vulnerabilities.fixed);
  const introduced = describeCounts(vulnerabilities.introduced);
  return `${fixed ? ` · fixes ${fixed}` : ''}${introduced ? ` · adds ${introduced}` : ''}`;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** `• **CRITICAL** CVE-1 in curl, curl-libs 8.22.0 → 8.23.0 (+2 other versions) · 7 images (harbor)` */
function describeGroup(g: VulnerabilityGroup): string {
  const [first, ...others] = g.versions;
  const versions = first
    ? ` ${first.installed}${first.fixed ? ` → ${first.fixed}` : ''}${others.length ? ` (+${plural(others.length, 'other version')})` : ''}`
    : '';
  const where = g.knownElsewhere
    ? `+${plural(g.images.length, 'new image')}`
    : g.images.length === 1
      ? `\`${g.images[0]}\``
      : `${g.images.length} images`;
  return `• **${g.severity}** ${g.vulnerabilityId} in ${g.packages.join(', ')}${versions} · ${where} (${g.applications.join(', ')})`;
}

function groupSection(out: string[], heading: string, groups: VulnerabilityGroup[]): void {
  const counts = describeCounts(countBySeverity(groups.filter((g) => !g.knownElsewhere)));
  out.push('', `**${heading}**${groups.length ? `: ${counts || 'none new'}` : ': none'}`);
  for (const group of groups.slice(0, MAX_LISTED)) out.push(describeGroup(group));
  const more = groups.length - MAX_LISTED;
  if (more > 0) out.push(`…and ${more} more`);
}

/** Security items in full; removed/deprecated as counts with the link; the rest is in the UI */
function changelogLines({ changelog }: ChartUpdate): string[] {
  if (!changelog) return [];
  const all = changelog.versions.flatMap((v) =>
    v.changes.map((c) => ({ ...c, version: v.version })),
  );
  const out = all
    .filter((c) => c.kind === 'security')
    .map((c) => `  ⚠ security (${c.version}): ${c.description.slice(0, 200)}`);
  const counts = (['removed', 'deprecated'] as const)
    .map((kind) => [kind, all.filter((c) => c.kind === kind).length] as const)
    .filter(([, n]) => n > 0)
    .map(([kind, n]) => `${n} ${kind}`);
  const summary = [counts.join(', '), changelog.releasesUrl].filter(Boolean).join(' · ');
  if (summary) out.push(`  changelog: ${summary}`);
  return out;
}

function lines(content: NotificationContent): string[] {
  const out: string[] = [];
  if (content.error) out.push(`\`${content.error.slice(0, 500)}\``);

  const groups = content.vulnerabilityGroups;
  if (content.kind === 'baseline') {
    if (groups.length) groupSection(out, 'Vulnerabilities', groups);
  } else {
    const advisories = groups.filter((g) => g.reason === 'advisory');
    const introduced = groups.filter((g) => g.reason === 'change');
    if (advisories.length) groupSection(out, 'New advisories for unchanged images', advisories);
    // With advisories, say explicitly that nothing you changed brought any in
    if (advisories.length || introduced.length) {
      groupSection(out, 'Introduced by changes', introduced);
    }
  }

  if (content.chartUpdates.length) {
    out.push('', '**Chart updates**');
    for (const u of content.chartUpdates.slice(0, MAX_LISTED)) {
      out.push(
        `• ${u.chartName} ${u.currentVersion} → ${u.latestVersion} (${u.applicationName})${describeChange(u)}`,
      );
      for (const warning of u.warnings) out.push(`  ⚠ ${warning}`);
      out.push(...changelogLines(u));
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

// Slack's mrkdwn needs these three escaped; it also keeps repo-controlled text (CVE titles, error
// messages) from forming <!channel>-style pings or links
const escapeSlack = (text: string) =>
  text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

/** A Slack incoming webhook message: the summary linked to the scan, then the most severe items */
export function toSlackPayload(content: NotificationContent, ctx: NotificationContext) {
  const repo = escapeSlack(ctx.repo);
  const title = ctx.scanUrl ? `<${ctx.scanUrl}|${repo}>` : repo;
  let body = escapeSlack(lines(content).join('\n')).replace(/\*\*(.+?)\*\*/g, '*$1*');
  if (body.length > MAX_DESCRIPTION) body = `${body.slice(0, MAX_DESCRIPTION)}…`;
  return {
    text: `*${title}*: ${escapeSlack(content.summary)}${body ? `\n${body}` : ''}`,
    // GitHub release and advisory links would each expand into a preview
    unfurl_links: false,
    unfurl_media: false,
  };
}

/** Plain JSON for n8n, Zapier, Home Assistant, scripts…: the full data plus a readable `text` */
export function toWebhookPayload(content: NotificationContent, ctx: NotificationContext) {
  return {
    source: 'chart-monitor',
    repo: ctx.repo,
    scanUrl: ctx.scanUrl,
    ...content,
    text: [`${ctx.repo}: ${content.summary}`, ...lines(content)].join('\n').replaceAll('**', ''),
  };
}
