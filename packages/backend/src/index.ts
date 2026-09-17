import Fastify from 'fastify';
import cors from '@fastify/cors';
import { env } from './config/env.js';
import { scanRoutes } from './routes/scans.js';

const app = Fastify({ logger: true });

await app.register(cors, { origin: true });
await app.register(scanRoutes);

app.listen({ port: env.PORT, host: '0.0.0.0' }).catch((error) => {
  app.log.error(error);
  process.exit(1);
});
