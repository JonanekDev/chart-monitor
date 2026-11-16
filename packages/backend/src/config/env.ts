import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { ConfigError } from '../errors.js';
import { parseGitCredentials } from '../git/repoSnapshot.js';

// Repo-root .env, same file docker compose reads. Resolved from this file (src/config or
// dist/config), so it works whatever the working directory is. Variables already set in the
// environment (e.g. by docker compose) take precedence over the file.
const ROOT_ENV_FILE = fileURLToPath(new URL('../../../../.env', import.meta.url));
if (existsSync(ROOT_ENV_FILE)) process.loadEnvFile(ROOT_ENV_FILE);

const envSchema = z.object({
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z.string().default('file:./chart-monitor.db'),
  TRIVY_SERVER_URL: z.string().url().default('http://localhost:4954'),
  /** Optional. Only needed for private GitHub repos; sent to github.com only. */
  GITHUB_TOKEN: z
    .string()
    .optional()
    .transform((val) => val || undefined),
  /** Optional. Tokens for private repos on any git host: `https://user:token@host`, one per line
   * (or comma-separated). Each token is only sent to its own host. */
  GIT_CREDENTIALS: z.string().optional().transform(parseGitCredentials),
  INCLUDE_PRERELEASES: z
    .string()
    .default('false')
    .transform((val) => val.toLowerCase() === 'true' || val === '1'),
});

function loadEnv() {
  const result = envSchema.safeParse(process.env);
  if (!result.success) {
    throw new ConfigError(`Invalid environment configuration: ${result.error.message}`);
  }
  return result.data;
}

export const env = loadEnv();
