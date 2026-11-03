import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { ConfigError } from '../errors.js';

const envSchema = z.object({
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z.string().url(),
  TRIVY_SERVER_URL: z.string().url(),
  GITHUB_APP_ID: z.string().min(1),
  GITHUB_APP_PRIVATE_KEY_PATH: z.string().default('/run/secrets/github_app_key'),
  GITHUB_APP_PRIVATE_KEY: z.string().optional(),
});

function resolvePrivateKey(env: z.infer<typeof envSchema>): string {
  try {
    return readFileSync(env.GITHUB_APP_PRIVATE_KEY_PATH, 'utf-8');
  } catch (cause) {
    if (env.GITHUB_APP_PRIVATE_KEY) {
      return env.GITHUB_APP_PRIVATE_KEY.replace(/\\n/g, '\n');
    }
    throw new ConfigError(
      `Could not read private key from ${env.GITHUB_APP_PRIVATE_KEY_PATH}, and no ` +
        'GITHUB_APP_PRIVATE_KEY fallback was set',
      cause,
    );
  }
}

function loadEnv() {
  const result = envSchema.safeParse(process.env);
  if (!result.success) {
    throw new ConfigError(`Invalid environment configuration: ${result.error.message}`);
  }
  return { ...result.data, GITHUB_APP_PRIVATE_KEY: resolvePrivateKey(result.data) };
}

export const env = loadEnv();
