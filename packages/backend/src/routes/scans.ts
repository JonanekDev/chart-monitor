import type { FastifyInstance } from 'fastify';
import { createScanRequestSchema } from '@chart-monitor/shared';
import { prisma } from '../db/client.js';
import { createScan, getScan, listScans } from '../scan/scanService.js';
import { ScanNotFoundError } from '../errors.js';

export async function scanRoutes(app: FastifyInstance): Promise<void> {
  app.post('/api/scans', async (request, reply) => {
    const parsed = createScanRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() });
    }
    const scan = await createScan(prisma, parsed.data);
    return reply.status(201).send(scan);
  });

  app.get('/api/scans', async () => listScans(prisma));

  app.get<{ Params: { id: string } }>('/api/scans/:id', async (request, reply) => {
    try {
      return await getScan(prisma, request.params.id);
    } catch (error) {
      if (error instanceof ScanNotFoundError) {
        return reply.status(404).send({ error: error.message });
      }
      throw error;
    }
  });
}
