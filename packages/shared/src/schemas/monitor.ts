import { z } from 'zod';
import { scanSummarySchema } from './scan.js';
import { monitorNotificationsSchema } from './notification.js';

// Empty form fields mean "not set"
const optionalText = z
  .string()
  .trim()
  .max(500)
  .nullish()
  .transform((val) => val || null);

export const monitorInputSchema = z.object({
  repoUrl: z
    .string()
    .trim()
    .regex(
      /^(https?:\/\/|ssh:\/\/|[\w.-]+@[\w.-]+:)\S+$/,
      'Enter a git URL: https://host/org/repo or git@host:org/repo.git',
    ),
  /** Only look for manifests under this path */
  searchPath: optionalText,
  /** Branch, tag or commit; default branch when empty */
  ref: optionalText,
  /** Cron expression (in the server's TZ); null = run manually only */
  schedule: optionalText,
  /** Defaults to notifications off */
  notifications: monitorNotificationsSchema.optional(),
});

export type MonitorInput = z.input<typeof monitorInputSchema>;

export const monitorUpdateSchema = monitorInputSchema.partial().extend({
  enabled: z.boolean().optional(),
});

export type MonitorUpdate = z.input<typeof monitorUpdateSchema>;

export const monitorSchema = z.object({
  id: z.uuid(),
  repoUrl: z.string(),
  searchPath: z.string().nullable(),
  ref: z.string().nullable(),
  schedule: z.string().nullable(),
  /** False = paused: the schedule doesn't fire, manual runs still work */
  enabled: z.boolean(),
  createdAt: z.string().datetime(),
  nextRunAt: z.string().datetime().nullable(),
  notifications: monitorNotificationsSchema,
  /** Newest first; older ones are pruned (SCAN_RETENTION) */
  scans: z.array(scanSummarySchema),
});

export type Monitor = z.infer<typeof monitorSchema>;

export const schedulePreviewSchema = z.object({
  valid: z.boolean(),
  error: z.string().nullable(),
  nextRuns: z.array(z.string().datetime()),
  /** The server's time zone, which schedules are interpreted in */
  timezone: z.string(),
});

export type SchedulePreview = z.infer<typeof schedulePreviewSchema>;
