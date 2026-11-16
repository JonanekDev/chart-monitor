import {
  CveSeverity,
  ScanState,
  VersionStatus,
  type ScanCounts,
  type ScanDetail,
  type ScanPhaseValue,
  type ScanSummary,
} from '@chart-monitor/shared';
import type { Monitor, Prisma, PrismaClient, Scan } from '../generated/prisma/client.js';
import { ScanNotFoundError } from '../errors.js';
import { executeScan, type ScanReporter } from './runScan.js';
import { notifyAfterScan } from '../notify/notifyAfterScan.js';

type ScanWithFindings = Prisma.ScanGetPayload<{
  include: { chartFindings: true; imageFindings: true; cveFindings: true };
}>;

const NO_COUNTS: ScanCounts = { outdatedCharts: 0, critical: 0, high: 0 };

export function toScanSummary(scan: Scan, counts: ScanCounts = NO_COUNTS): ScanSummary {
  return {
    id: scan.id,
    monitorId: scan.monitorId,
    repoUrl: scan.repoUrl,
    state: scan.state as ScanSummary['state'],
    createdAt: scan.createdAt.toISOString(),
    finishedAt: scan.finishedAt?.toISOString() ?? null,
    errorMessage: scan.errorMessage,
    progress: scan.phase
      ? {
          phase: scan.phase as ScanPhaseValue,
          done: scan.progressDone,
          total: scan.progressTotal,
          detail: scan.progressDetail,
        }
      : null,
    counts,
  };
}

/** Headline numbers for many scans at once, counted in the DB rather than by loading findings */
export async function countFindings(
  prisma: PrismaClient,
  scanIds: string[],
): Promise<Map<string, ScanCounts>> {
  const [charts, cves] = await Promise.all([
    prisma.chartFinding.groupBy({
      by: ['scanId'],
      where: { scanId: { in: scanIds }, status: VersionStatus.OUTDATED },
      _count: true,
    }),
    prisma.cveFinding.groupBy({
      by: ['scanId', 'severity'],
      where: {
        scanId: { in: scanIds },
        severity: { in: [CveSeverity.CRITICAL, CveSeverity.HIGH] },
      },
      _count: true,
    }),
  ]);

  const counts = new Map(scanIds.map((id) => [id, { ...NO_COUNTS }]));
  for (const row of charts) counts.get(row.scanId)!.outdatedCharts = row._count;
  for (const row of cves) {
    counts.get(row.scanId)![row.severity === CveSeverity.CRITICAL ? 'critical' : 'high'] =
      row._count;
  }
  return counts;
}

function toScanDetail(scan: ScanWithFindings): ScanDetail {
  return {
    ...toScanSummary(scan, {
      outdatedCharts: scan.chartFindings.filter((f) => f.status === VersionStatus.OUTDATED).length,
      critical: scan.cveFindings.filter((f) => f.severity === CveSeverity.CRITICAL).length,
      high: scan.cveFindings.filter((f) => f.severity === CveSeverity.HIGH).length,
    }),
    warnings: JSON.parse(scan.warnings) as string[],
    chartFindings: scan.chartFindings.map((f) => ({
      applicationName: f.applicationName,
      applicationSetName: f.applicationSetName,
      chartName: f.chartName,
      repoUrl: f.repoUrl,
      currentVersion: f.currentVersion,
      latestVersion: f.latestVersion,
      status: f.status,
      note: f.note,
    })),
    imageFindings: scan.imageFindings.map((f) => ({
      applicationName: f.applicationName,
      image: f.image,
      currentTag: f.currentTag,
      latestTag: f.latestTag,
      status: f.status,
      note: f.note,
      vulnerabilitiesScanned: f.vulnerabilitiesScanned,
    })),
    cveFindings: scan.cveFindings.map((f) => ({
      applicationName: f.applicationName,
      image: f.image,
      vulnerabilityId: f.vulnerabilityId,
      pkgName: f.pkgName,
      installedVersion: f.installedVersion,
      fixedVersion: f.fixedVersion,
      severity: f.severity,
      title: f.title,
    })),
  };
}

// Scans run one at a time: several schedules firing together would otherwise all hit trivy and
// the network at once. Waiting scans sit in the `pending` state, which the UI already shows.
let queueTail: Promise<unknown> = Promise.resolve();
function enqueue(job: () => Promise<void>): void {
  queueTail = queueTail.then(job).catch(() => {});
}

/** Persists everything as it arrives, so the UI (polling the scan) fills in step by step */
function databaseReporter(prisma: PrismaClient, scanId: string): ScanReporter {
  const updateScan = (data: Prisma.ScanUpdateInput) =>
    prisma.scan.update({ where: { id: scanId }, data });
  return {
    phase: (phase, total = 0) =>
      updateScan({ phase, progressDone: 0, progressTotal: total, progressDetail: null }),
    step: (detail) => updateScan({ progressDone: { increment: 1 }, progressDetail: detail }),
    chartFinding: (finding) => prisma.chartFinding.create({ data: { ...finding, scanId } }),
    imageFindings: (findings) =>
      prisma.imageFinding.createMany({ data: findings.map((f) => ({ ...f, scanId })) }),
    imageScanned: ({ repository, tag }, cves) =>
      prisma.$transaction([
        prisma.cveFinding.createMany({ data: cves.map((c) => ({ ...c, scanId })) }),
        prisma.imageFinding.updateMany({
          where: { scanId, image: repository, currentTag: tag },
          data: { vulnerabilitiesScanned: true },
        }),
      ]),
    warnings: (warnings) => updateScan({ warnings: JSON.stringify(warnings) }),
  };
}

async function runScan(prisma: PrismaClient, scan: Scan): Promise<void> {
  await prisma.scan.update({ where: { id: scan.id }, data: { state: ScanState.RUNNING } });

  try {
    await executeScan(
      {
        repoUrl: scan.repoUrl,
        searchPath: scan.searchPath ?? undefined,
        ref: scan.ref ?? undefined,
      },
      databaseReporter(prisma, scan.id),
    );
    await prisma.scan.update({
      where: { id: scan.id },
      data: { state: ScanState.SUCCEEDED, finishedAt: new Date(), phase: null },
    });
  } catch (error) {
    console.error(`[Scan ${scan.id}] Scan execution failed:`, error);
    // `phase` is kept, so the UI can tell in which step it failed; partial findings stay too.
    // updateMany: the monitor (and with it this scan) may have been deleted meanwhile.
    await prisma.scan.updateMany({
      where: { id: scan.id },
      data: {
        state: ScanState.FAILED,
        finishedAt: new Date(),
        errorMessage: error instanceof Error ? error.message : 'Unknown error',
      },
    });
  }
}

/** Keeps the newest `keep` scans of a monitor; findings go with them (cascade) */
export async function pruneScans(
  prisma: PrismaClient,
  monitorId: string,
  keep: number,
): Promise<number> {
  const old = await prisma.scan.findMany({
    where: { monitorId },
    orderBy: { createdAt: 'desc' },
    skip: keep,
    select: { id: true },
  });
  if (old.length === 0) return 0;
  const { count } = await prisma.scan.deleteMany({ where: { id: { in: old.map((s) => s.id) } } });
  return count;
}

export interface ScanOptions {
  /** Scans kept per monitor */
  retention: number;
  /** Base URL for links in notifications */
  publicUrl?: string;
}

/** Queues a scan of the monitor's current settings; it starts once earlier scans are done */
export async function createScan(
  prisma: PrismaClient,
  monitor: Monitor,
  { retention, publicUrl }: ScanOptions,
): Promise<ScanSummary> {
  const scan = await prisma.scan.create({
    data: {
      monitorId: monitor.id,
      repoUrl: monitor.repoUrl,
      searchPath: monitor.searchPath,
      ref: monitor.ref,
    },
  });

  enqueue(async () => {
    await runScan(prisma, scan);
    // Before pruning: the notification compares with the previous scan
    await notifyAfterScan(prisma, scan.id, publicUrl);
    await pruneScans(prisma, monitor.id, retention);
  });

  return toScanSummary(scan);
}

/** Scans run in-process, so a restart kills them; without this they'd show as running forever */
export async function failInterruptedScans(prisma: PrismaClient): Promise<number> {
  const { count } = await prisma.scan.updateMany({
    where: { state: { in: [ScanState.PENDING, ScanState.RUNNING] } },
    data: {
      state: ScanState.FAILED,
      finishedAt: new Date(),
      errorMessage: 'Interrupted: the app was restarted while this scan was running',
    },
  });
  return count;
}

export async function getScan(prisma: PrismaClient, id: string): Promise<ScanDetail> {
  const scan = await prisma.scan.findUnique({
    where: { id },
    // Findings are written as they finish (in parallel), so order them for a stable UI
    include: {
      chartFindings: { orderBy: [{ applicationName: 'asc' }, { chartName: 'asc' }] },
      imageFindings: { orderBy: [{ applicationName: 'asc' }, { image: 'asc' }] },
      cveFindings: true,
    },
  });
  if (!scan) throw new ScanNotFoundError(`Scan ${id} not found`);
  return toScanDetail(scan);
}
