/** Schedules most people want; anything else is a custom cron expression */
export const SCHEDULE_PRESETS: { label: string; value: string | null }[] = [
  { label: 'Manual only', value: null },
  { label: 'Every 6 hours', value: '0 */6 * * *' },
  { label: 'Daily at 03:00', value: '0 3 * * *' },
  { label: 'Weekly, Monday 03:00', value: '0 3 * * 1' },
];

export function describeSchedule(schedule: string | null): string {
  return SCHEDULE_PRESETS.find((p) => p.value === schedule)?.label ?? schedule ?? 'Manual only';
}

const relative = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ['day', 86_400_000],
  ['hour', 3_600_000],
  ['minute', 60_000],
];

/** "3 hours ago", "in 2 days", "now" */
export function relativeTime(iso: string): string {
  const diff = new Date(iso).getTime() - Date.now();
  for (const [unit, ms] of UNITS) {
    if (Math.abs(diff) >= ms) return relative.format(Math.round(diff / ms), unit);
  }
  return 'now';
}

export function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' });
}
