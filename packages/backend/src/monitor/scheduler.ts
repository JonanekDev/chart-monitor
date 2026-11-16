import { Cron } from 'croner';
import type { SchedulePreview } from '@chart-monitor/shared';

const MIN_INTERVAL_MS = 5 * 60 * 1000;
const PREVIEW_RUNS = 3;

/** Validates a cron expression and lists its next runs (in the process TZ, like the schedule). */
export function previewSchedule(expression: string): SchedulePreview {
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  let job: Cron;
  try {
    job = new Cron(expression, { paused: true });
  } catch (error) {
    return { valid: false, error: (error as Error).message, nextRuns: [], timezone };
  }
  const nextRuns = job.nextRuns(PREVIEW_RUNS);
  job.stop();

  // A typo like `* * * * *` would queue a full scan every minute
  const tooFrequent = nextRuns.some(
    (run, i) => i > 0 && run.getTime() - nextRuns[i - 1]!.getTime() < MIN_INTERVAL_MS,
  );
  if (tooFrequent) {
    return { valid: false, error: 'Runs more often than every 5 minutes', nextRuns: [], timezone };
  }
  return { valid: true, error: null, nextRuns: nextRuns.map((d) => d.toISOString()), timezone };
}

/** One cron job per monitor that has a schedule and isn't paused. */
export class Scheduler {
  private readonly jobs = new Map<string, Cron>();

  constructor(private readonly onFire: (monitorId: string) => Promise<unknown>) {}

  /** (Re)applies a monitor's schedule; call after every create/update */
  set(monitor: { id: string; schedule: string | null; enabled: boolean }): void {
    this.remove(monitor.id);
    if (!monitor.enabled || !monitor.schedule) return;
    this.jobs.set(
      monitor.id,
      // protect: never overlap with a still-running callback of the same job
      new Cron(monitor.schedule, { protect: true }, async () => {
        await this.onFire(monitor.id).catch((error: unknown) =>
          console.error(`[Monitor ${monitor.id}] scheduled scan failed to start:`, error),
        );
      }),
    );
  }

  remove(monitorId: string): void {
    this.jobs.get(monitorId)?.stop();
    this.jobs.delete(monitorId);
  }

  nextRunAt(monitorId: string): Date | null {
    return this.jobs.get(monitorId)?.nextRun() ?? null;
  }

  stopAll(): void {
    for (const job of this.jobs.values()) job.stop();
    this.jobs.clear();
  }
}
