import {
  ScanState,
  type Monitor as MonitorDto,
  type monitorInputSchema,
  type monitorUpdateSchema,
} from '@chart-monitor/shared';
import type { Monitor, PrismaClient, Scan } from '../generated/prisma/client.js';
import { ConflictError, NotFoundError, ValidationError } from '../errors.js';
import { countFindings, createScan, toScanSummary } from '../scan/scanService.js';
import { previewSchedule, Scheduler } from './scheduler.js';
import type { z } from 'zod';

export interface MonitorDeps {
  prisma: PrismaClient;
  scheduler: Scheduler;
  /** Scans kept per monitor */
  retention: number;
}

const withScans = { scans: { orderBy: { createdAt: 'desc' } } } as const;

async function toMonitorDtos(
  { prisma, scheduler }: MonitorDeps,
  monitors: (Monitor & { scans: Scan[] })[],
): Promise<MonitorDto[]> {
  const counts = await countFindings(
    prisma,
    monitors.flatMap((m) => m.scans.map((s) => s.id)),
  );
  return monitors.map((m) => ({
    id: m.id,
    repoUrl: m.repoUrl,
    searchPath: m.searchPath,
    ref: m.ref,
    schedule: m.schedule,
    enabled: m.enabled,
    createdAt: m.createdAt.toISOString(),
    nextRunAt: scheduler.nextRunAt(m.id)?.toISOString() ?? null,
    scans: m.scans.map((s) => toScanSummary(s, counts.get(s.id))),
  }));
}

function assertValidSchedule(schedule: string | null): void {
  if (!schedule) return;
  const preview = previewSchedule(schedule);
  if (!preview.valid) throw new ValidationError(`Invalid schedule: ${preview.error}`);
}

async function findMonitor(prisma: PrismaClient, id: string): Promise<Monitor> {
  const monitor = await prisma.monitor.findUnique({ where: { id } });
  if (!monitor) throw new NotFoundError(`Monitor ${id} not found`);
  return monitor;
}

export async function listMonitors(deps: MonitorDeps): Promise<MonitorDto[]> {
  const monitors = await deps.prisma.monitor.findMany({
    orderBy: { createdAt: 'asc' },
    include: withScans,
  });
  return toMonitorDtos(deps, monitors);
}

async function getMonitorDto(deps: MonitorDeps, id: string): Promise<MonitorDto> {
  const monitor = await deps.prisma.monitor.findUnique({ where: { id }, include: withScans });
  if (!monitor) throw new NotFoundError(`Monitor ${id} not found`);
  return (await toMonitorDtos(deps, [monitor]))[0]!;
}

/** Creates the monitor and starts its first scan right away */
export async function createMonitor(
  deps: MonitorDeps,
  input: z.output<typeof monitorInputSchema>,
): Promise<MonitorDto> {
  assertValidSchedule(input.schedule);
  const monitor = await deps.prisma.monitor.create({ data: input });
  deps.scheduler.set(monitor);
  await createScan(deps.prisma, monitor, deps.retention);
  return getMonitorDto(deps, monitor.id);
}

export async function updateMonitor(
  deps: MonitorDeps,
  id: string,
  patch: z.output<typeof monitorUpdateSchema>,
): Promise<MonitorDto> {
  await findMonitor(deps.prisma, id);
  if (patch.schedule !== undefined) assertValidSchedule(patch.schedule);
  const monitor = await deps.prisma.monitor.update({ where: { id }, data: patch });
  deps.scheduler.set(monitor);
  return getMonitorDto(deps, id);
}

export async function deleteMonitor(deps: MonitorDeps, id: string): Promise<void> {
  await findMonitor(deps.prisma, id);
  deps.scheduler.remove(id);
  await deps.prisma.monitor.delete({ where: { id } }); // scans and findings cascade
}

/** Queues a scan now. One scan per monitor at a time: a second request while one is pending or
 * running is a conflict (a schedule firing then just skips). */
export async function runMonitor(deps: MonitorDeps, id: string) {
  const monitor = await findMonitor(deps.prisma, id);
  const active = await deps.prisma.scan.count({
    where: { monitorId: id, state: { in: [ScanState.PENDING, ScanState.RUNNING] } },
  });
  if (active > 0) throw new ConflictError('A scan of this monitor is already queued or running');
  return createScan(deps.prisma, monitor, deps.retention);
}

/** Scheduler callback: like a manual run, but a still-active previous scan just means "skip" */
export async function runScheduled(deps: MonitorDeps, id: string): Promise<void> {
  try {
    await runMonitor(deps, id);
  } catch (error) {
    if (error instanceof ConflictError) {
      console.warn(`[Monitor ${id}] previous scan still active, skipping this scheduled run`);
      return;
    }
    throw error;
  }
}

/** Registers the schedules of all monitors (call once at startup) */
export async function startScheduler(deps: MonitorDeps): Promise<number> {
  const monitors = await deps.prisma.monitor.findMany({
    where: { enabled: true, schedule: { not: null } },
  });
  for (const monitor of monitors) deps.scheduler.set(monitor);
  return monitors.length;
}
