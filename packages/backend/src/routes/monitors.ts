import type { FastifyInstance } from 'fastify';
import { monitorInputSchema, monitorUpdateSchema } from '@chart-monitor/shared';
import { z } from 'zod';
import { sendAppError } from './errors.js';
import {
  createMonitor,
  deleteMonitor,
  listMonitors,
  runMonitor,
  updateMonitor,
  type MonitorDeps,
} from '../monitor/monitorService.js';
import { previewSchedule } from '../monitor/scheduler.js';

type IdParams = { Params: { id: string } };

export function monitorRoutes(deps: MonitorDeps) {
  return async (app: FastifyInstance): Promise<void> => {
    app.setErrorHandler(sendAppError);

    app.get('/api/monitors', async () => listMonitors(deps));

    app.post('/api/monitors', async (request, reply) => {
      const parsed = monitorInputSchema.safeParse(request.body);
      if (!parsed.success) return reply.status(400).send({ error: z.prettifyError(parsed.error) });
      return reply.status(201).send(await createMonitor(deps, parsed.data));
    });

    app.patch<IdParams>('/api/monitors/:id', async (request, reply) => {
      const parsed = monitorUpdateSchema.safeParse(request.body);
      if (!parsed.success) return reply.status(400).send({ error: z.prettifyError(parsed.error) });
      return updateMonitor(deps, request.params.id, parsed.data);
    });

    app.delete<IdParams>('/api/monitors/:id', async (request, reply) => {
      await deleteMonitor(deps, request.params.id);
      return reply.status(204).send();
    });

    app.post<IdParams>('/api/monitors/:id/scans', async (request, reply) =>
      reply.status(201).send(await runMonitor(deps, request.params.id)),
    );

    app.get<{ Querystring: { expression?: string } }>('/api/schedule-preview', async (request) =>
      previewSchedule(request.query.expression ?? ''),
    );
  };
}
