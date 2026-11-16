import { createHmac, randomBytes } from 'node:crypto';
import fastifyCookie from '@fastify/cookie';
import fastifyRateLimit from '@fastify/rate-limit';
import bcrypt from 'bcryptjs';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { PrismaClient } from '../generated/prisma/client.js';

export const SESSION_COOKIE = 'session';
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** API routes reachable without a session (matched against the route pattern, not the raw URL) */
const PUBLIC_ROUTES = new Set(['/api/login', '/api/session']);

const loginSchema = z.object({ password: z.string().min(1).max(200) });

export interface AuthOptions {
  /** bcrypt hash of the login password; required unless `disabled` */
  passwordHash?: string;
  disabled: boolean;
  /** Random per-installation secret, see loadSessionSecret */
  secret: string;
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

/** Single-password login with a signed session cookie. Registered on the root instance, so the
 * guard applies to every /api route. */
export async function setupAuth(app: FastifyInstance, options: AuthOptions): Promise<void> {
  const { passwordHash, disabled, secret } = options;

  // Signing key mixes in the password hash: changing the password invalidates every session
  const signingKey = createHmac('sha256', secret)
    .update(passwordHash ?? '')
    .digest('hex');
  await app.register(fastifyCookie, { secret: signingKey });
  await app.register(fastifyRateLimit, { global: false });

  const isAuthenticated = (request: FastifyRequest): boolean => {
    if (disabled) return true;
    const raw = request.cookies[SESSION_COOKIE];
    if (!raw) return false;
    const { valid, value } = request.unsignCookie(raw);
    return valid && Number(value) > Date.now();
  };

  app.addHook('onRequest', async (request, reply) => {
    // The matched route pattern, so encoded or odd-looking URLs can't sneak past the check
    const route = request.routeOptions.url;
    if (!route?.startsWith('/api/') || PUBLIC_ROUTES.has(route)) return;
    if (!isAuthenticated(request)) {
      await reply.status(401).send({ error: 'Not logged in' });
    }
  });

  app.get('/api/session', async (request) => ({
    authEnabled: !disabled,
    authenticated: isAuthenticated(request),
  }));

  app.post(
    '/api/login',
    { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } },
    async (request, reply) => {
      if (disabled) return reply.status(204).send();
      const parsed = loginSchema.safeParse(request.body);
      const ok = parsed.success && (await bcrypt.compare(parsed.data.password, passwordHash!));
      if (!ok) return reply.status(401).send({ error: 'Wrong password' });

      reply.setCookie(SESSION_COOKIE, String(Date.now() + SESSION_TTL_MS), {
        signed: true,
        httpOnly: true, // not readable by scripts on the page
        sameSite: 'strict', // never sent on cross-site requests, which also rules out CSRF
        secure: isHttps(request),
        path: '/',
        maxAge: SESSION_TTL_MS / 1000,
      });
      return reply.status(204).send();
    },
  );

  app.post('/api/logout', async (_request, reply) =>
    reply.clearCookie(SESSION_COOKIE, { path: '/' }).status(204).send(),
  );
}
