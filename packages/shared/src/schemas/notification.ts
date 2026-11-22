import { z } from 'zod';

export const ChannelType = { DISCORD: 'discord', WEBHOOK: 'webhook' } as const;
export const channelTypeSchema = z.enum([ChannelType.DISCORD, ChannelType.WEBHOOK]);
export type ChannelTypeValue = z.infer<typeof channelTypeSchema>;

const webhookUrl = z
  .string()
  .trim()
  .regex(/^https?:\/\/\S+$/, 'Enter the webhook URL (https://…)');

export const channelInputSchema = z.object({
  name: z.string().trim().min(1).max(100),
  type: channelTypeSchema,
  url: webhookUrl,
});

export type ChannelInput = z.input<typeof channelInputSchema>;

/** `url` may be left out to keep the stored one (the UI never gets to see it again) */
export const channelUpdateSchema = channelInputSchema.partial();

export type ChannelUpdate = z.input<typeof channelUpdateSchema>;

export const channelSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  type: channelTypeSchema,
  /** The webhook URL is a secret (anyone with it can post): only its start is returned */
  urlPreview: z.string(),
  createdAt: z.string().datetime(),
});

export type Channel = z.infer<typeof channelSchema>;

/** Lowest CVE severity that triggers a notification; null = don't notify about CVEs */
export const notifySeveritySchema = z.enum(['CRITICAL', 'HIGH', 'MEDIUM']).nullable();

/** off | any new chart version | only versions whose upgrade fixes CVEs from `minSeverity` up */
export const chartUpdateModeSchema = z.enum(['off', 'any', 'fixes']);
export type ChartUpdateMode = z.infer<typeof chartUpdateModeSchema>;

export const monitorNotificationsSchema = z.object({
  /** null = notifications off for this monitor */
  channelId: z.uuid().nullable(),
  minSeverity: notifySeveritySchema,
  /** Only CVEs that have a fixed version (most others can't be acted on) */
  onlyFixable: z.boolean(),
  chartUpdates: chartUpdateModeSchema,
  onFailure: z.boolean(),
});

export type MonitorNotifications = z.infer<typeof monitorNotificationsSchema>;

export const DEFAULT_NOTIFICATIONS: MonitorNotifications = {
  channelId: null,
  minSeverity: 'HIGH',
  onlyFixable: true,
  chartUpdates: 'any',
  onFailure: true,
};
