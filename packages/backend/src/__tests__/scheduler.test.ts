import { afterEach, describe, expect, it } from 'vitest';
import { previewSchedule, Scheduler } from '../monitor/scheduler.js';

describe('previewSchedule', () => {
  it('lists the next runs of a valid expression', () => {
    const preview = previewSchedule('0 3 * * *');
    expect(preview).toMatchObject({ valid: true, error: null });
    expect(preview.nextRuns).toHaveLength(3);
    const [first, second] = preview.nextRuns.map((r) => new Date(r).getTime());
    expect(second! - first!).toBe(24 * 60 * 60 * 1000);
  });

  it.each(['not a cron', '61 * * * *', ''])('rejects %j', (expression) => {
    expect(previewSchedule(expression)).toMatchObject({ valid: false, nextRuns: [] });
  });

  it('rejects schedules that would run more often than every 5 minutes', () => {
    expect(previewSchedule('* * * * *')).toMatchObject({
      valid: false,
      error: 'Runs more often than every 5 minutes',
    });
    expect(previewSchedule('*/5 * * * *').valid).toBe(true);
  });
});

describe('Scheduler', () => {
  const scheduler = new Scheduler(async () => {});
  afterEach(() => scheduler.stopAll());

  it('schedules only enabled monitors with a schedule, and can change or drop them', () => {
    scheduler.set({ id: 'a', schedule: '0 3 * * *', enabled: true });
    scheduler.set({ id: 'paused', schedule: '0 3 * * *', enabled: false });
    scheduler.set({ id: 'manual', schedule: null, enabled: true });

    expect(scheduler.nextRunAt('a')).toBeInstanceOf(Date);
    expect(scheduler.nextRunAt('paused')).toBeNull();
    expect(scheduler.nextRunAt('manual')).toBeNull();

    scheduler.set({ id: 'a', schedule: '0 4 * * *', enabled: true });
    expect(scheduler.nextRunAt('a')!.getMinutes()).toBe(0);
    scheduler.remove('a');
    expect(scheduler.nextRunAt('a')).toBeNull();
  });
});
