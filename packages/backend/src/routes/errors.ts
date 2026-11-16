import type { FastifyReply, FastifyRequest } from 'fastify';
import { AppError, ConflictError, NotFoundError, ValidationError } from '../errors.js';

const STATUS_BY_ERROR = new Map<new (...args: never[]) => AppError, number>([
  [ValidationError, 400],
  [NotFoundError, 404],
  [ConflictError, 409],
]);

/** Route error handler: known app errors become 400/404/409 with their message, the rest 500 */
export function sendAppError(error: unknown, _request: FastifyRequest, reply: FastifyReply) {
  const status = [...STATUS_BY_ERROR].find(([type]) => error instanceof type)?.[1];
  if (status) return reply.status(status).send({ error: (error as Error).message });
  throw error;
}
