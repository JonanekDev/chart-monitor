import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { env } from './config/env.js';
import { scanRoutes } from './routes/scans.js';

// Built frontend, resolved from src/ or dist/ alike. Missing during `pnpm dev`, where Vite serves
// the UI itself and proxies /api here.
const FRONTEND_DIST = fileURLToPath(new URL('../../frontend/dist', import.meta.url));

const app = Fastify({ logger: true });

await app.register(scanRoutes);

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

app.listen({ port: env.PORT, host: '0.0.0.0' }).catch((error) => {
  app.log.error(error);
  process.exit(1);
});
