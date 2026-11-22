import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { env } from './config/env.js';
import { scanRoutes } from './routes/scans.js';
import { prisma } from './db/client.js';
import { failInterruptedScans } from './scan/scanService.js';
import { loadSessionSecret, prismaSessionStore, setupAuth } from './auth/auth.js';
import { securityHeaders } from './securityHeaders.js';
import { monitorRoutes } from './routes/monitors.js';
import { channelRoutes } from './routes/channels.js';
import { Scheduler } from './monitor/scheduler.js';
import { runScheduled, startScheduler, type MonitorDeps } from './monitor/monitorService.js';

// Built frontend, resolved from src/ or dist/ alike. Missing during `pnpm dev`, where Vite serves
// the UI itself and proxies /api here.
const FRONTEND_DIST = fileURLToPath(new URL('../../frontend/dist', import.meta.url));

const app = Fastify({ logger: true, trustProxy: env.TRUST_PROXY });
securityHeaders(app);

const interrupted = await failInterruptedScans(prisma);
if (interrupted > 0) app.log.warn(`Marked ${interrupted} interrupted scan(s) as failed`);

// Before any routes: the login guard must see every /api route
await setupAuth(app, {
  passwordHash: env.ADMIN_PASSWORD_HASH,
  disabled: env.AUTH_DISABLED,
  secret: await loadSessionSecret(prisma),
  sessions: prismaSessionStore(prisma),
});
if (env.AUTH_DISABLED) app.log.warn('AUTH_DISABLED=true: the app is reachable without login');

const scheduler = new Scheduler((monitorId) => runScheduled(deps, monitorId));
const deps: MonitorDeps = {
  prisma,
  scheduler,
  retention: env.SCAN_RETENTION,
  publicUrl: env.PUBLIC_URL,
};

await app.register(scanRoutes);
await app.register(monitorRoutes(deps));
await app.register(channelRoutes(prisma));

const scheduled = await startScheduler(deps);
app.log.info(`Scheduled ${scheduled} monitor(s), time zone ${env.TZ}`);

if (existsSync(FRONTEND_DIST)) {
  await app.register(fastifyStatic, {
    root: FRONTEND_DIST,
    setHeaders(reply, filePath) {
      // Vite puts a content hash in asset names, so they never change; index.html must always be
      // revalidated so a new release is picked up right away.
      reply.header(
        'cache-control',
        filePath.includes('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache',
      );
    },
  });

  // SPA fallback: client-side routes (/scans/<id>) get index.html; unknown /api paths stay a 404
  app.setNotFoundHandler((request, reply) => {
    if (request.method === 'GET' && !request.url.startsWith('/api/')) {
      return reply.sendFile('index.html');
    }
    return reply.status(404).send({ error: 'Not found' });
  });
}

// As PID 1 in a container, node ignores SIGTERM unless it handles it, so `docker stop` would wait
// 10s and then SIGKILL. Running scans die either way; failInterruptedScans marks them on next start.
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
    app.log.info(`${signal} received, shutting down`);
    scheduler.stopAll();
    void app.close().finally(() => process.exit(0));
  });
}

app.listen({ port: env.PORT, host: '0.0.0.0' }).catch((error) => {
  app.log.error(error);
  process.exit(1);
});
