import bcrypt from 'bcryptjs';
import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SESSION_COOKIE, setupAuth, type AuthOptions } from '../auth/auth.js';

const HASH = bcrypt.hashSync('correct horse', 4);

async function buildApp(options: Partial<AuthOptions> = {}) {
  const app = Fastify();
  await setupAuth(app, { passwordHash: HASH, disabled: false, secret: 'test-secret', ...options });
  app.get('/api/scans/:id', async () => ({ secret: 'data' }));
  app.get('/index.html', async () => 'public page');
  return app;
}

async function login(app: Awaited<ReturnType<typeof buildApp>>, password: string, headers = {}) {
  return app.inject({ method: 'POST', url: '/api/login', payload: { password }, headers });
}

const sessionCookie = (res: { cookies: { name: string; value: string }[] }) =>
  `${SESSION_COOKIE}=${res.cookies.find((c) => c.name === SESSION_COOKIE)!.value}`;

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

    const authed = await app.inject({ url: '/api/scans/1', headers: { cookie: sessionCookie(res) } });
    expect(authed.json()).toEqual({ secret: 'data' });
  });

  it('marks the cookie Secure behind an HTTPS proxy', async () => {
    const app = await buildApp();
    const res = await login(app, 'correct horse', { 'x-forwarded-proto': 'https' });
    expect(res.cookies.find((c) => c.name === SESSION_COOKIE)!.secure).toBe(true);
  });

  it('rejects tampered and expired sessions', async () => {
    const app = await buildApp();
    const cookie = sessionCookie(await login(app, 'correct horse'));
    const [, signed] = cookie.split('=');
    const tampered = `${SESSION_COOKIE}=${String(Date.now() + 1e12)}.${signed!.split('.')[1]}`;
    expect((await app.inject({ url: '/api/scans/1', headers: { cookie: tampered } })).statusCode).toBe(401);

    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 31 * 24 * 60 * 60 * 1000);
    expect((await app.inject({ url: '/api/scans/1', headers: { cookie } })).statusCode).toBe(401);
  });

  it('logs everyone out when the password hash changes', async () => {
    const cookie = sessionCookie(await login(await buildApp(), 'correct horse'));
    const afterChange = await buildApp({ passwordHash: bcrypt.hashSync('new password', 4) });
    expect((await afterChange.inject({ url: '/api/scans/1', headers: { cookie } })).statusCode).toBe(401);
  });

  it('rate-limits login attempts', async () => {
    const app = await buildApp();
    const codes = [];
    for (let i = 0; i < 6; i++) codes.push((await login(app, 'wrong')).statusCode);
    expect(codes).toEqual([401, 401, 401, 401, 401, 429]);
  });

  it('reports the session state and lets everything through when disabled', async () => {
    const app = await buildApp();
    expect((await app.inject('/api/session')).json()).toEqual({ authEnabled: true, authenticated: false });

    const open = await buildApp({ disabled: true, passwordHash: undefined });
    expect((await open.inject('/api/scans/1')).statusCode).toBe(200);
    expect((await open.inject('/api/session')).json()).toEqual({ authEnabled: false, authenticated: true });
  });
});
