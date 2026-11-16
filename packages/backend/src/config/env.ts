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

const booleanFlag = z
  .string()
  .default('false')
  .transform((val) => val.toLowerCase() === 'true' || val === '1');

// bcrypt modular format ($2a$/$2b$/$2y$, cost, 53 chars of salt+hash), as produced by htpasswd -B
const BCRYPT_HASH = /^\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}$/;

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
  INCLUDE_PRERELEASES: booleanFlag,
  /** bcrypt hash of the login password. Required unless AUTH_DISABLED. */
  ADMIN_PASSWORD_HASH: z
    .string()
    .optional()
    .transform((val) => val?.trim() || undefined),
  /** Turns the login off, for setups that already authenticate in front of the app (SSO proxy) */
  AUTH_DISABLED: booleanFlag,
  /** Time zone schedules are interpreted in. Node applies TZ itself; it's only validated here. */
  TZ: z.string().default('UTC'),
  /** Where the app is reachable, for links in notifications (e.g. https://charts.example.com) */
  PUBLIC_URL: z
    .string()
    .trim()
    .optional()
    .transform((val) => val || undefined)
    .pipe(z.url().optional()),
  /** Scans kept per monitor; older ones are deleted after each scan */
  SCAN_RETENTION: z.coerce.number().int().min(1).default(10),
});

const HASH_HELP =
  "Generate one with: htpasswd -nBC 12 '' | cut -d: -f2\n" +
  "and put it in .env in single quotes (so the $ signs stay intact): ADMIN_PASSWORD_HASH='$2y$12$...'";

function loadEnv() {
  const result = envSchema.safeParse(process.env);
  if (!result.success) {
    throw new ConfigError(`Invalid environment configuration: ${result.error.message}`);
  }
  const { ADMIN_PASSWORD_HASH, AUTH_DISABLED } = result.data;
  if (!AUTH_DISABLED && !ADMIN_PASSWORD_HASH) {
    throw new ConfigError(
      `ADMIN_PASSWORD_HASH is not set. ${HASH_HELP}\n` +
        'Or set AUTH_DISABLED=true if something in front of the app already handles login.',
    );
  }
  try {
    new Intl.DateTimeFormat('en', { timeZone: result.data.TZ });
  } catch {
    throw new ConfigError(`TZ "${result.data.TZ}" is not a valid time zone, e.g. Europe/Prague`);
  }
  if (ADMIN_PASSWORD_HASH && !BCRYPT_HASH.test(ADMIN_PASSWORD_HASH)) {
    throw new ConfigError(
      `ADMIN_PASSWORD_HASH is not a valid bcrypt hash (unquoted $ signs get mangled). ${HASH_HELP}`,
    );
  }
  return result.data;
}

function loadEnvOrExit() {
  try {
    return loadEnv();
  } catch (error) {
    // A config mistake is for the person running the app: print the advice, not a stack trace
    if (!(error instanceof ConfigError)) throw error;
    console.error(`\nConfiguration error: ${error.message}\n`);
    process.exit(1);
  }
}

export const env = loadEnvOrExit();
