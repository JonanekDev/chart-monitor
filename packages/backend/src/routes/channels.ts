import type { FastifyInstance } from 'fastify';
import { channelInputSchema, channelUpdateSchema } from '@chart-monitor/shared';
import { z } from 'zod';
import type { PrismaClient } from '../generated/prisma/client.js';
import {
  createChannel,
  deleteChannel,
  listChannels,
  sendTestNotification,
  updateChannel,
} from '../notify/channels.js';
import { sendAppError } from './errors.js';

type IdParams = { Params: { id: string } };

export function channelRoutes(prisma: PrismaClient) {
  return async (app: FastifyInstance): Promise<void> => {
    app.setErrorHandler(sendAppError);

    app.get('/api/channels', async () => listChannels(prisma));

    app.post('/api/channels', async (request, reply) => {
      const parsed = channelInputSchema.safeParse(request.body);
      if (!parsed.success) return reply.status(400).send({ error: z.prettifyError(parsed.error) });
      return reply.status(201).send(await createChannel(prisma, parsed.data));
    });

    app.patch<IdParams>('/api/channels/:id', async (request, reply) => {
      const parsed = channelUpdateSchema.safeParse(request.body);
      if (!parsed.success) return reply.status(400).send({ error: z.prettifyError(parsed.error) });
      return updateChannel(prisma, request.params.id, parsed.data);
    });

    app.delete<IdParams>('/api/channels/:id', async (request, reply) => {
      await deleteChannel(prisma, request.params.id);
      return reply.status(204).send();
    });

    app.post<IdParams>('/api/channels/:id/test', async (request, reply) => {
      await sendTestNotification(prisma, request.params.id);
      return reply.status(204).send();
    });
  };
}
