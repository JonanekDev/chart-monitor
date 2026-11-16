import {
  ScanState,
  type ScanDetail,
  type ScanPhaseValue,
  type ScanSummary,
} from '@chart-monitor/shared';
import type { Prisma, PrismaClient, Scan } from '../generated/prisma/client.js';
import { ScanNotFoundError } from '../errors.js';
import { executeScan, type ScanReporter } from './runScan.js';

type ScanWithFindings = Prisma.ScanGetPayload<{
  include: { chartFindings: true; imageFindings: true; cveFindings: true };
}>;

function toScanSummary(scan: Scan): ScanSummary {
  return {
    id: scan.id,
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
  };
}

function toScanDetail(scan: ScanWithFindings): ScanDetail {
  return {
    ...toScanSummary(scan),
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

export async function createScan(
  prisma: PrismaClient,
  input: { repoUrl: string; searchPath?: string; ref?: string },
): Promise<ScanSummary> {
  const scan = await prisma.scan.create({
    data: { repoUrl: input.repoUrl, searchPath: input.searchPath, ref: input.ref },
  });

  void runInBackground(prisma, scan.id, input);

  return toScanSummary(scan);
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

async function runInBackground(
  prisma: PrismaClient,
  scanId: string,
  input: { repoUrl: string; searchPath?: string; ref?: string },
): Promise<void> {
  await prisma.scan.update({ where: { id: scanId }, data: { state: ScanState.RUNNING } });

  try {
    await executeScan(input, databaseReporter(prisma, scanId));
    await prisma.scan.update({
      where: { id: scanId },
      data: { state: ScanState.SUCCEEDED, finishedAt: new Date(), phase: null },
    });
  } catch (error) {
    console.error(`[Scan ${scanId}] Scan execution failed:`, error);
    // `phase` is kept, so the UI can tell in which step it failed; partial findings stay too
    await prisma.scan.update({
      where: { id: scanId },
      data: {
        state: ScanState.FAILED,
        finishedAt: new Date(),
        errorMessage: error instanceof Error ? error.message : 'Unknown error',
      },
    });
  }
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

export async function listScans(prisma: PrismaClient): Promise<ScanSummary[]> {
  const scans = await prisma.scan.findMany({ orderBy: { createdAt: 'desc' } });
  return scans.map(toScanSummary);
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
