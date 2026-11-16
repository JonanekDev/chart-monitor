import { existsSync } from 'node:fs';
import { defineConfig, env } from 'prisma/config';

// Same repo-root .env the backend reads (see src/config/env.ts)
const ROOT_ENV_FILE = new URL('../../.env', import.meta.url);
if (existsSync(ROOT_ENV_FILE)) process.loadEnvFile(ROOT_ENV_FILE);

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
  },
  datasource: {
    url: env('DATABASE_URL'),
  },
});
