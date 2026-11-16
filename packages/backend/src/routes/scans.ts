import type { FastifyInstance } from 'fastify';
import { prisma } from '../db/client.js';
import { getScan } from '../scan/scanService.js';
import { ScanNotFoundError } from '../errors.js';

export async function scanRoutes(app: FastifyInstance): Promise<void> {
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
