import type { ChannelTypeValue } from '@chart-monitor/shared';
import type { NotificationContent } from './buildNotification.js';
import {
  toDiscordPayload,
  toSlackPayload,
  toWebhookPayload,
  type NotificationContext,
} from './format.js';

const TIMEOUT_MS = 10_000;

export async function sendNotification(
  channel: { type: ChannelTypeValue | string; url: string },
  content: NotificationContent,
  ctx: NotificationContext,
): Promise<void> {
  const payload =
    channel.type === 'discord'
      ? toDiscordPayload(content, ctx)
      : channel.type === 'slack'
        ? toSlackPayload(content, ctx)
        : toWebhookPayload(content, ctx);
  const response = await fetch(channel.url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!response.ok) {
    // The URL contains the secret token: report the status only
    throw new Error(`webhook answered ${response.status} ${response.statusText}`);
  }
}
