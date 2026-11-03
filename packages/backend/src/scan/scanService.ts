import { ScanState, type ScanDetail, type ScanSummary } from '@chart-monitor/shared';
import type { Prisma, PrismaClient, Scan } from '../generated/prisma/client.js';
import { ScanNotFoundError } from '../errors.js';
import { executeScan } from './runScan.js';

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
  };
}

function toScanDetail(scan: ScanWithFindings): ScanDetail {
  return {
    ...toScanSummary(scan),
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

async function runInBackground(
  prisma: PrismaClient,
  scanId: string,
  input: { repoUrl: string; searchPath?: string; ref?: string },
): Promise<void> {
  await prisma.scan.update({ where: { id: scanId }, data: { state: ScanState.RUNNING } });

  try {
    const result = await executeScan(input.repoUrl, input.searchPath, input.ref);
    await prisma.$transaction([
      prisma.chartFinding.createMany({
        data: result.chartFindings.map((f) => ({ ...f, scanId })),
      }),
      prisma.imageFinding.createMany({
        data: result.imageFindings.map((f) => ({ ...f, scanId })),
      }),
      prisma.cveFinding.createMany({
        data: result.cveFindings.map((f) => ({ ...f, scanId })),
      }),
      prisma.scan.update({
        where: { id: scanId },
        data: { state: ScanState.SUCCEEDED, finishedAt: new Date() },
      }),
    ]);
  } catch (error) {
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

export async function listScans(prisma: PrismaClient): Promise<ScanSummary[]> {
  const scans = await prisma.scan.findMany({ orderBy: { createdAt: 'desc' } });
  return scans.map(toScanSummary);
}

export async function getScan(prisma: PrismaClient, id: string): Promise<ScanDetail> {
  const scan = await prisma.scan.findUnique({
    where: { id },
    include: { chartFindings: true, imageFindings: true, cveFindings: true },
  });
  if (!scan) throw new ScanNotFoundError(`Scan ${id} not found`);
  return toScanDetail(scan);
}
