import { createHmac, randomBytes } from 'node:crypto';
import fastifyCookie from '@fastify/cookie';
import fastifyRateLimit from '@fastify/rate-limit';
import bcrypt from 'bcryptjs';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { PrismaClient } from '../generated/prisma/client.js';

export const SESSION_COOKIE = 'session';
const DAY_MS = 24 * 60 * 60 * 1000;
const SESSION_TTL_MS = 7 * DAY_MS;
// A session in use is extended at most once a day (one DB write, not one per request)
const RENEW_AFTER_MS = DAY_MS;
/** API routes reachable without a session (matched against the route pattern, not the raw URL) */
const PUBLIC_ROUTES = new Set(['/api/login', '/api/session', '/api/logout']);

const loginSchema = z.object({ password: z.string().min(1).max(200) });

/** Where sessions live: the DB in the app, memory in tests */
export interface SessionStore {
  create(id: string, expiresAt: Date): Promise<unknown>;
  expiresAt(id: string): Promise<Date | null>;
  extend(id: string, expiresAt: Date): Promise<unknown>;
  delete(id: string): Promise<unknown>;
  deleteAll(): Promise<unknown>;
}

export function prismaSessionStore(prisma: PrismaClient): SessionStore {
  return {
    async create(id, expiresAt) {
      // Expired sessions are only ever looked up and refused; clear them out now and then
      await prisma.session.deleteMany({ where: { expiresAt: { lt: new Date() } } });
      return prisma.session.create({ data: { id, expiresAt } });
    },
    expiresAt: async (id) =>
      (await prisma.session.findUnique({ where: { id } }))?.expiresAt ?? null,
    extend: (id, expiresAt) => prisma.session.updateMany({ where: { id }, data: { expiresAt } }),
    delete: (id) => prisma.session.deleteMany({ where: { id } }),
    deleteAll: () => prisma.session.deleteMany(),
  };
}

export interface AuthOptions {
  /** bcrypt hash of the login password; required unless `disabled` */
  passwordHash?: string;
  disabled: boolean;
  /** Random per-installation secret, see loadSessionSecret */
  secret: string;
  sessions: SessionStore;
}

/** The secret behind session cookies: generated on first start and kept in the DB, so restarts
 * don't log anyone out and nobody has to configure it. */
export async function loadSessionSecret(prisma: PrismaClient): Promise<string> {
  const existing = await prisma.appSetting.findUnique({ where: { key: 'sessionSecret' } });
  if (existing) return existing.value;
  const value = randomBytes(32).toString('hex');
  await prisma.appSetting.create({ data: { key: 'sessionSecret', value } });
  return value;
}

/** Behind a TLS-terminating proxy the app itself sees plain HTTP. Trusting the header only for
 * this is safe: a spoofed value can just make the cookie stricter. */
function isHttps(request: FastifyRequest): boolean {
  return request.protocol === 'https' || request.headers['x-forwarded-proto'] === 'https';
}

/** Single-password login. The session cookie holds a random id, signed, that must exist in the
 * session store: logging out deletes it, and a session in use stays valid while an idle one
 * expires after SESSION_TTL_MS. Registered on the root instance, so the guard applies to every
 * /api route. */
export async function setupAuth(app: FastifyInstance, options: AuthOptions): Promise<void> {
  const { passwordHash, disabled, secret, sessions } = options;

  // Signing key mixes in the password hash: changing the password invalidates every session
  const signingKey = createHmac('sha256', secret)
    .update(passwordHash ?? '')
    .digest('hex');
  await app.register(fastifyCookie, { secret: signingKey });
  await app.register(fastifyRateLimit, { global: false });

  /** The id from a validly signed cookie, without asking the store */
  const cookieSessionId = (request: FastifyRequest): string | null => {
    const raw = request.cookies[SESSION_COOKIE];
    if (!raw) return null;
    const { valid, value } = request.unsignCookie(raw);
    return valid && value ? value : null;
  };

  const currentSession = async (request: FastifyRequest) => {
    const id = cookieSessionId(request);
    const expiresAt = id ? await sessions.expiresAt(id) : null;
    return id && expiresAt && expiresAt.getTime() > Date.now() ? { id, expiresAt } : null;
  };

  const setSessionCookie = (request: FastifyRequest, reply: FastifyReply, id: string) =>
    reply.setCookie(SESSION_COOKIE, id, {
      signed: true,
      httpOnly: true, // not readable by scripts on the page
      sameSite: 'strict', // never sent on cross-site requests, which also rules out CSRF
      secure: isHttps(request),
      path: '/',
      maxAge: SESSION_TTL_MS / 1000,
    });

  app.addHook('onRequest', async (request, reply) => {
    // The matched route pattern, so encoded or odd-looking URLs can't sneak past the check
    const route = request.routeOptions.url;
    if (disabled || !route?.startsWith('/api/') || PUBLIC_ROUTES.has(route)) return;
    const session = await currentSession(request);
    if (!session) {
      await reply.status(401).send({ error: 'Not logged in' });
      return;
    }
    if (session.expiresAt.getTime() - Date.now() < SESSION_TTL_MS - RENEW_AFTER_MS) {
      await sessions.extend(session.id, new Date(Date.now() + SESSION_TTL_MS));
      setSessionCookie(request, reply, session.id);
    }
  });

  app.get('/api/session', async (request) => ({
    authEnabled: !disabled,
    authenticated: disabled || (await currentSession(request)) !== null,
  }));

  app.post(
    '/api/login',
    { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } },
    async (request, reply) => {
      if (disabled) return reply.status(204).send();
      const parsed = loginSchema.safeParse(request.body);
      const ok = parsed.success && (await bcrypt.compare(parsed.data.password, passwordHash!));
      if (!ok) return reply.status(401).send({ error: 'Wrong password' });

      const id = randomBytes(32).toString('hex');
      await sessions.create(id, new Date(Date.now() + SESSION_TTL_MS));
      setSessionCookie(request, reply, id);
      return reply.status(204).send();
    },
  );

  // Public, so an already expired session can still clear its cookie
  app.post('/api/logout', async (request, reply) => {
    const id = cookieSessionId(request);
    if (id) await sessions.delete(id);
    return reply.clearCookie(SESSION_COOKIE, { path: '/' }).status(204).send();
  });

  /** Ends every session, e.g. after leaving a browser logged in somewhere */
  app.post('/api/logout-all', async (_request, reply) => {
    await sessions.deleteAll();
    return reply.clearCookie(SESSION_COOKIE, { path: '/' }).status(204).send();
  });
}
