import {
  ScanState,
  type ChartUpdateMode,
  type ChartUpgrade,
  type CveSeverityValue,
} from '@chart-monitor/shared';
import type { PrismaClient } from '../generated/prisma/client.js';
import { buildNotification, type NotifyRules, type ScanSnapshot } from './buildNotification.js';
import { sendNotification } from './send.js';

const withFindings = { chartFindings: true, cveFindings: true, imageFindings: true } as const;

function snapshot(scan: {
  state: string;
  errorMessage: string | null;
  chartFindings: (Omit<ScanSnapshot['charts'][number], 'upgrade'> & { upgrade: string | null })[];
  cveFindings: (Omit<ScanSnapshot['cves'][number], 'severity'> & { severity: string })[];
  imageFindings: ScanSnapshot['images'];
}): ScanSnapshot {
  return {
    state: scan.state,
    errorMessage: scan.errorMessage,
    charts: scan.chartFindings.map((c) => ({
      ...c,
      upgrade: c.upgrade ? (JSON.parse(c.upgrade) as ChartUpgrade) : null,
    })),
    cves: scan.cveFindings.map((c) => ({ ...c, severity: c.severity as CveSeverityValue })),
    images: scan.imageFindings,
  };
}

/** `https://github.com/org/repo.git` -> `org/repo`, plus @ref */
export function repoLabel(repoUrl: string, ref: string | null): string {
  const name = repoUrl
    .replace(/^(https?:\/\/|ssh:\/\/)?([^@/]+@)?[^/:]+[/:]/, '')
    .replace(/\.git$/, '');
  return ref ? `${name}@${ref}` : name;
}

/** Sends the monitor's notification for a finished scan, if its rules say so. Never throws:
 * a broken webhook must not turn a good scan into a failed one. */
export async function notifyAfterScan(
  prisma: PrismaClient,
  scanId: string,
  publicUrl: string | undefined,
): Promise<void> {
  try {
    const scan = await prisma.scan.findUnique({
      where: { id: scanId },
      include: { ...withFindings, monitor: { include: { channel: true } } },
    });
    const channel = scan?.monitor.channel;
    if (!scan || !channel) return;

    const monitor = scan.monitor;
    const previous = await prisma.scan.findFirst({
      where: {
        monitorId: monitor.id,
        state: ScanState.SUCCEEDED,
        createdAt: { lt: scan.createdAt },
      },
      orderBy: { createdAt: 'desc' },
      include: withFindings,
    });

    const rules: NotifyRules = {
      minSeverity: monitor.notifyMinSeverity as NotifyRules['minSeverity'],
      onlyFixable: monitor.notifyOnlyFixable,
      chartUpdates: monitor.notifyChartUpdates as ChartUpdateMode,
      onFailure: monitor.notifyOnFailure,
    };
    const content = buildNotification(rules, snapshot(scan), previous ? snapshot(previous) : null);
    if (!content) return;

    await sendNotification(channel, content, {
      repo: repoLabel(scan.repoUrl, scan.ref),
      scanUrl: publicUrl ? `${publicUrl.replace(/\/$/, '')}/scans/${scan.id}` : null,
    });
  } catch (error) {
    console.error(`[Scan ${scanId}] notification failed:`, (error as Error).message);
  }
}
