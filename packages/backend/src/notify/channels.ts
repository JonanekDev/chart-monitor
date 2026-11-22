import type {
  Channel,
  ChannelTypeValue,
  channelInputSchema,
  channelUpdateSchema,
} from '@chart-monitor/shared';
import type { z } from 'zod';
import type { NotificationChannel, PrismaClient } from '../generated/prisma/client.js';
import { NotFoundError, ValidationError } from '../errors.js';
import { sendNotification } from './send.js';

/** Host only: the rest of a webhook URL is (or contains) its secret token */
function urlPreview(url: string): string {
  try {
    return `${new URL(url).origin}/…`;
  } catch {
    return '…';
  }
}

function toChannel(c: NotificationChannel): Channel {
  return {
    id: c.id,
    name: c.name,
    type: c.type as ChannelTypeValue,
    urlPreview: urlPreview(c.url),
    createdAt: c.createdAt.toISOString(),
  };
}

async function findChannel(prisma: PrismaClient, id: string): Promise<NotificationChannel> {
  const channel = await prisma.notificationChannel.findUnique({ where: { id } });
  if (!channel) throw new NotFoundError(`Channel ${id} not found`);
  return channel;
}

export async function listChannels(prisma: PrismaClient): Promise<Channel[]> {
  const channels = await prisma.notificationChannel.findMany({ orderBy: { createdAt: 'asc' } });
  return channels.map(toChannel);
}

export async function createChannel(
  prisma: PrismaClient,
  input: z.output<typeof channelInputSchema>,
): Promise<Channel> {
  return toChannel(await prisma.notificationChannel.create({ data: input }));
}

export async function updateChannel(
  prisma: PrismaClient,
  id: string,
  patch: z.output<typeof channelUpdateSchema>,
): Promise<Channel> {
  await findChannel(prisma, id);
  return toChannel(await prisma.notificationChannel.update({ where: { id }, data: patch }));
}

/** Monitors using it simply stop notifying (channelId is set to null) */
export async function deleteChannel(prisma: PrismaClient, id: string): Promise<void> {
  await findChannel(prisma, id);
  await prisma.notificationChannel.delete({ where: { id } });
}

export async function sendTestNotification(prisma: PrismaClient, id: string): Promise<void> {
  const channel = await findChannel(prisma, id);
  try {
    await sendNotification(
      channel,
      {
        kind: 'changes',
        summary: 'Test notification: this channel works.',
        newVulnerabilities: [],
        vulnerabilityGroups: [],
        chartUpdates: [],
        error: null,
      },
      { repo: `chart-monitor → ${channel.name}`, scanUrl: null },
    );
  } catch (error) {
    throw new ValidationError(`Sending failed: ${(error as Error).message}`);
  }
}
