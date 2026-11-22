import bcrypt from 'bcryptjs';
import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SESSION_COOKIE, setupAuth, type AuthOptions, type SessionStore } from '../auth/auth.js';

const HASH = bcrypt.hashSync('correct horse', 4);

function memorySessions(): SessionStore & { all: Map<string, Date> } {
  const all = new Map<string, Date>();
  return {
    all,
    create: async (id, expiresAt) => all.set(id, expiresAt),
    expiresAt: async (id) => all.get(id) ?? null,
    extend: async (id, expiresAt) => all.has(id) && all.set(id, expiresAt),
    delete: async (id) => all.delete(id),
    deleteAll: async () => all.clear(),
  };
}

async function buildApp(options: Partial<AuthOptions> = {}, trustProxy: boolean = false) {
  const app = Fastify({ trustProxy });
  await setupAuth(app, {
    passwordHash: HASH,
    disabled: false,
    secret: 'test-secret',
    sessions: memorySessions(),
    ...options,
  });
  app.get('/api/scans/:id', async () => ({ secret: 'data' }));
  app.get('/index.html', async () => 'public page');
  return app;
}

async function login(app: Awaited<ReturnType<typeof buildApp>>, password: string, headers = {}) {
  return app.inject({ method: 'POST', url: '/api/login', payload: { password }, headers });
}

const sessionCookie = (res: { cookies: { name: string; value: string }[] }) =>
  `${SESSION_COOKIE}=${res.cookies.find((c) => c.name === SESSION_COOKIE)!.value}`;

const DAY = 24 * 60 * 60 * 1000;
const scans = (app: Awaited<ReturnType<typeof buildApp>>, cookie: string) =>
  app.inject({ url: '/api/scans/1', headers: { cookie } });

afterEach(() => vi.restoreAllMocks());

describe('auth', () => {
  it('rejects API calls without a session but leaves non-API routes public', async () => {
    const app = await buildApp();
    expect((await app.inject('/api/scans/1')).statusCode).toBe(401);
    expect((await app.inject('/index.html')).statusCode).toBe(200);
  });

  // The router decodes these to /api/scans/1, so a check on the raw URL would let them through
  it.each(['/%61pi/scans/1', '/api/%73cans/1'])('cannot be bypassed via %s', async (url) => {
    const app = await buildApp();
    expect((await app.inject(url)).statusCode).toBe(401);
  });

  it('logs in with the right password and sets a locked-down cookie', async () => {
    const app = await buildApp();
    expect((await login(app, 'wrong')).statusCode).toBe(401);

    const res = await login(app, 'correct horse');
    expect(res.statusCode).toBe(204);
    const cookie = res.cookies.find((c) => c.name === SESSION_COOKIE)!;
    expect(cookie).toMatchObject({ httpOnly: true, sameSite: 'Strict', path: '/' });
    expect(cookie.secure).toBeFalsy();

    const authed = await app.inject({
      url: '/api/scans/1',
      headers: { cookie: sessionCookie(res) },
    });
    expect(authed.json()).toEqual({ secret: 'data' });
  });

  it('marks the cookie Secure behind an HTTPS proxy', async () => {
    const app = await buildApp();
    const res = await login(app, 'correct horse', { 'x-forwarded-proto': 'https' });
    expect(res.cookies.find((c) => c.name === SESSION_COOKIE)!.secure).toBe(true);
  });

  it('rejects tampered and idle-expired sessions', async () => {
    const app = await buildApp();
    const cookie = sessionCookie(await login(app, 'correct horse'));
    const [, signed] = cookie.split('=');
    const tampered = `${SESSION_COOKIE}=${'0'.repeat(64)}.${signed!.split('.')[1]}`;
    expect((await scans(app, tampered)).statusCode).toBe(401);

    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now + 8 * DAY);
    expect((await scans(app, cookie)).statusCode).toBe(401);
  });

  it('keeps a session in use alive, renewing it at most once a day', async () => {
    const sessions = memorySessions();
    const app = await buildApp({ sessions });
    const cookie = sessionCookie(await login(app, 'correct horse'));
    const now = Date.now();
    const clock = vi.spyOn(Date, 'now');

    clock.mockReturnValue(now + DAY / 2);
    expect((await scans(app, cookie)).cookies).toEqual([]); // not yet

    clock.mockReturnValue(now + 6 * DAY);
    const renewed = await scans(app, cookie);
    expect(renewed.statusCode).toBe(200);
    expect(renewed.cookies.find((c) => c.name === SESSION_COOKIE)?.maxAge).toBe(7 * 24 * 60 * 60);

    // Past the first expiry, still valid: it was used
    clock.mockReturnValue(now + 10 * DAY);
    expect((await scans(app, cookie)).statusCode).toBe(200);
  });

  it('ends the session on the server when logging out, not just in the browser', async () => {
    const app = await buildApp();
    const cookie = sessionCookie(await login(app, 'correct horse'));
    await app.inject({ method: 'POST', url: '/api/logout', headers: { cookie } });
    // A copy of the cookie (e.g. stolen before) no longer works
    expect((await scans(app, cookie)).statusCode).toBe(401);
  });

  it('logs out every session at once', async () => {
    const app = await buildApp();
    const laptop = sessionCookie(await login(app, 'correct horse'));
    const phone = sessionCookie(await login(app, 'correct horse'));
    const res = await app.inject({
      method: 'POST',
      url: '/api/logout-all',
      headers: { cookie: phone },
    });
    expect(res.statusCode).toBe(204);
    expect((await scans(app, laptop)).statusCode).toBe(401);
    expect((await scans(app, phone)).statusCode).toBe(401);
    // And only for someone logged in
    expect((await app.inject({ method: 'POST', url: '/api/logout-all' })).statusCode).toBe(401);
  });

  it('logs everyone out when the password hash changes', async () => {
    const sessions = memorySessions();
    const cookie = sessionCookie(await login(await buildApp({ sessions }), 'correct horse'));
    const afterChange = await buildApp({
      sessions,
      passwordHash: bcrypt.hashSync('new password', 4),
    });
    expect((await scans(afterChange, cookie)).statusCode).toBe(401);
  });

  it('rate-limits login attempts', async () => {
    const app = await buildApp();
    const codes = [];
    for (let i = 0; i < 6; i++) codes.push((await login(app, 'wrong')).statusCode);
    expect(codes).toEqual([401, 401, 401, 401, 401, 429]);
  });

  it('rate-limits per client behind a trusted proxy, not per proxy', async () => {
    const app = await buildApp({}, true);
    const from = (ip: string) => ({ 'x-forwarded-for': ip });
    for (let i = 0; i < 5; i++) await login(app, 'wrong', from('203.0.113.7'));
    expect((await login(app, 'wrong', from('203.0.113.7'))).statusCode).toBe(429);
    // Someone else behind the same proxy isn't locked out by it
    expect((await login(app, 'correct horse', from('198.51.100.1'))).statusCode).toBe(204);
  });

  it('reports the session state and lets everything through when disabled', async () => {
    const app = await buildApp();
    expect((await app.inject('/api/session')).json()).toEqual({
      authEnabled: true,
      authenticated: false,
    });

    const open = await buildApp({ disabled: true, passwordHash: undefined });
    expect((await open.inject('/api/scans/1')).statusCode).toBe(200);
    expect((await open.inject('/api/session')).json()).toEqual({
      authEnabled: false,
      authenticated: true,
    });
  });
});
