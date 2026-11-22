import { ConfigError } from '../errors.js';

export interface Credentials {
  username: string;
  password: string;
}

/** Parses `https://user:secret@host[/path]` entries separated by newlines, commas or spaces.
 * `name` is the variable they come from; errors never include the entry itself. */
export function parseCredentialUrls(raw: string | undefined, name: string): URL[] {
  const entries = (raw ?? '').split(/[\s,]+/).filter(Boolean);
  return entries.map((entry, i) => {
    let url: URL | null = null;
    try {
      url = new URL(entry);
    } catch {
      // reported below
    }
    if (!url || !['https:', 'http:'].includes(url.protocol) || !url.username || !url.password) {
      throw new ConfigError(`${name} entry #${i + 1} is invalid, expected https://user:token@host`);
    }
    return url;
  });
}

export interface HelmRepoLogin extends Credentials {
  /** `https://host/path` without a trailing slash */
  prefix: string;
}

const withoutTrailingSlash = (url: URL) =>
  `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, '')}`;

export function parseHelmRepoCredentials(raw: string | undefined): HelmRepoLogin[] {
  return parseCredentialUrls(raw, 'HELM_REPO_CREDENTIALS').map((url) => ({
    prefix: withoutTrailingSlash(url),
    username: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
  }));
}

/** The login whose URL is the longest path-prefix of `repoUrl`: Nexus or Artifactory serve repos
 * with different logins from one host. Only for that host, never for a lookalike. */
export function matchHelmRepo(repoUrl: string, logins: HelmRepoLogin[]): Credentials | null {
  let url: URL;
  try {
    url = new URL(repoUrl);
  } catch {
    return null;
  }
  const target = withoutTrailingSlash(url);
  const best = logins
    .filter(({ prefix }) => target === prefix || target.startsWith(`${prefix}/`))
    .sort((a, b) => b.prefix.length - a.prefix.length)[0];
  return best ? { username: best.username, password: best.password } : null;
}

// Docker Hub's names: config.json keys it as https://index.docker.io/v1/, image refs say
// docker.io, and the API lives at registry-1.docker.io (what parseImageRef returns)
const DOCKER_HUB = new Set(['docker.io', 'index.docker.io', 'registry-1.docker.io']);

/** `https://index.docker.io/v1/` → `registry-1.docker.io`, `harbor.example.com:8443/x` → its host */
export function registryHost(key: string): string {
  const host = (key.replace(/^[a-z]+:\/\//i, '').split('/')[0] ?? '').toLowerCase();
  return DOCKER_HUB.has(host) ? 'registry-1.docker.io' : host;
}

/** Logins from a Docker `config.json` (`auths` only), by registry host. A `credsStore` (e.g.
 * Docker Desktop's) holds every login, so without it nothing works: that stops the app at
 * startup. Hosts behind `credHelpers` or with an empty entry only lose their login: `warnings`. */
export function parseDockerConfig(
  json: string,
  file: string,
): { logins: Map<string, Credentials>; warnings: string[] } {
  let config: {
    auths?: Record<string, { auth?: string; username?: string; password?: string }>;
    credsStore?: string;
    credHelpers?: Record<string, string>;
  };
  try {
    config = JSON.parse(json);
  } catch {
    throw new ConfigError(`${file} is not valid JSON`);
  }
  if (config.credsStore) {
    throw new ConfigError(
      `${file} keeps its logins in a credential store (credsStore), which isn't supported: ` +
        'put each login under "auths" as {"auth": "<base64 of user:password>"}',
    );
  }
  const warnings = Object.keys(config.credHelpers ?? {}).map(
    (host) =>
      `${file}: ${host} uses a credential helper, which isn't supported: accessed without login`,
  );
  const logins = new Map<string, Credentials>();
  for (const [key, entry] of Object.entries(config.auths ?? {})) {
    let { username, password } = entry;
    if (entry.auth) {
      const decoded = Buffer.from(entry.auth, 'base64').toString('utf-8');
      const colon = decoded.indexOf(':');
      if (colon < 1) {
        throw new ConfigError(`${file}: "auth" of ${key} is not the base64 of user:password`);
      }
      [username, password] = [decoded.slice(0, colon), decoded.slice(colon + 1)];
    }
    if (!username || !password) {
      warnings.push(
        `${file}: ${key} has no login ("auth" or "username" + "password"): accessed without login`,
      );
      continue;
    }
    logins.set(registryHost(key), { username, password });
  }
  return { logins, warnings };
}

export const basicAuth = ({ username, password }: Credentials) =>
  `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;

// Shorter passwords would mask unrelated text; they still go in base64 form and in URLs
const MIN_LITERAL_SECRET = 6;

/** Every form a configured secret could show up in: as is, and base64 of user:secret */
export function secretForms(logins: Credentials[]): string[] {
  return logins.flatMap((login) => [
    ...(login.password.length >= MIN_LITERAL_SECRET ? [login.password] : []),
    basicAuth(login).slice('Basic '.length),
  ]);
}

/** Masks credentials in text that gets stored or shown (scan warnings, errors): known secrets,
 * user:password in URLs, Authorization headers and `"auth": "…"` fields. helm, git and registry
 * clients sometimes echo a URL or header they were given. */
export function redact(text: string, secrets: string[]): string {
  let out = text
    .replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi, '$1***@')
    .replace(/\b(authorization\s*[:=]\s*)(basic|bearer|token)\s+[^\s"',]+/gi, '$1$2 ***')
    .replace(/("auth"\s*:\s*")[^"]*"/gi, '$1***"');
  for (const secret of secrets) out = out.replaceAll(secret, '***');
  return out;
}
