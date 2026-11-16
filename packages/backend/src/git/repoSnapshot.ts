import { execFile } from 'node:child_process';
import { mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { ConfigError, RepoAccessError } from '../errors.js';

const execFileAsync = promisify(execFile);
const GIT_TIMEOUT_MS = 120_000;

/** Read-only view of one repo at one revision. Paths are POSIX, relative to the repo root. */
export interface RepoSnapshot {
  files: string[];
  dirs: string[];
  read(filePath: string): Promise<string>;
}

export type OpenRepo = (repoUrl: string, revision?: string) => Promise<RepoSnapshot>;

/** Normalizes any git URL ArgoCD accepts to the HTTPS URL we clone. SSH forms (`git@host:o/r`,
 * `ssh://git@host/o/r`) become HTTPS on the same host, since the container has no SSH keys. */
export function toCloneUrl(repoUrl: string): string {
  const trimmed = repoUrl.trim();
  const scp = /^[\w.-]+@([\w.-]+):(?!\/\/)(.+)$/.exec(trimmed);
  if (scp) return `https://${scp[1]}/${scp[2]!.replace(/^\/+/, '')}`;

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new RepoAccessError(`Not a git URL: ${repoUrl}`);
  }
  if (url.protocol === 'ssh:') return `https://${url.hostname}${url.pathname}`;
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new RepoAccessError(`Unsupported git URL scheme "${url.protocol}" in ${repoUrl}`);
  }
  url.username = '';
  url.password = '';
  return url.toString();
}

/** Parses `GIT_CREDENTIALS`: entries in git-credential-store format (`https://user:token@host`),
 * separated by newlines, commas or spaces. Error messages never include the entry itself. */
export function parseGitCredentials(raw: string | undefined): string[] {
  const entries = (raw ?? '').split(/[\s,]+/).filter(Boolean);
  return entries.map((entry, i) => {
    let url: URL | null = null;
    try {
      url = new URL(entry);
    } catch {
      // reported below
    }
    if (!url || !['https:', 'http:'].includes(url.protocol) || !url.username || !url.password) {
      throw new ConfigError(
        `GIT_CREDENTIALS entry #${i + 1} is invalid, expected https://user:token@host`,
      );
    }
    return `${url.protocol}//${url.username}:${url.password}@${url.host}`;
  });
}

export interface GitAuth {
  /** Sent preemptively to github.com only */
  githubToken?: string;
  /** git-credential-store file; git itself matches entries to the requested host */
  credentialsFile?: string;
}

/** Credentials go through git config env vars (never the URL), so tokens don't show up in error
 * messages or process lists, and each one is only ever sent to its own host. */
export function gitEnv({ githubToken, credentialsFile }: GitAuth = {}): NodeJS.ProcessEnv {
  // Empty helper first resets helpers from the user's own git config (e.g. a desktop keyring)
  const config: [string, string][] = [['credential.helper', '']];
  if (githubToken) {
    const basic = Buffer.from(`x-access-token:${githubToken}`).toString('base64');
    config.push(['http.https://github.com/.extraheader', `AUTHORIZATION: basic ${basic}`]);
  }
  if (credentialsFile) {
    config.push(['credential.helper', `store --file=${credentialsFile}`]);
  }
  // Only the credentials configured for this app: no askpass helpers inherited from the
  // environment (e.g. an IDE's), which would otherwise answer with the developer's own login
  const { GIT_ASKPASS: _askpass, SSH_ASKPASS: _sshAskpass, ...inherited } = process.env;
  return {
    ...inherited,
    GIT_TERMINAL_PROMPT: '0', // fail instead of hanging on a password prompt for private repos
    GIT_ALLOW_PROTOCOL: 'https:http', // repo URLs come from user input / manifests: no file://, ext::
    GIT_CONFIG_COUNT: String(config.length),
    ...Object.fromEntries(
      config.flatMap(([key, value], i) => [
        [`GIT_CONFIG_KEY_${i}`, key],
        [`GIT_CONFIG_VALUE_${i}`, value],
      ]),
    ),
  };
}

async function git(args: string[], cwd: string, auth: GitAuth): Promise<void> {
  await execFileAsync('git', args, { cwd, env: gitEnv(auth), timeout: GIT_TIMEOUT_MS });
}

/** Shallow-fetches exactly one revision. `fetch <rev>` (unlike `clone --branch`) works for
 * branches, tags, commit SHAs and HEAD alike. */
async function cloneInto(
  dir: string,
  cloneUrl: string,
  revision: string,
  auth: GitAuth,
): Promise<void> {
  if (revision.startsWith('-')) throw new RepoAccessError(`Invalid revision "${revision}"`);
  try {
    await git(['init', '--quiet'], dir, auth);
    await git(['remote', 'add', 'origin', cloneUrl], dir, auth);
    await git(['fetch', '--quiet', '--depth', '1', 'origin', revision], dir, auth);
    await git(['checkout', '--quiet', 'FETCH_HEAD'], dir, auth);
  } catch (cause) {
    const stderr = (cause as { stderr?: string }).stderr?.trim().split('\n').pop() ?? '';
    // A private repo looks like "not found" / a refused credential prompt to an anonymous client
    const looksPrivate =
      /repository .*not found|could not read username|authentication|access denied|error: 40[13]/i.test(
        stderr,
      );
    throw new RepoAccessError(
      `Could not clone ${cloneUrl} @ ${revision}${stderr ? `: ${stderr}` : ''}` +
        (looksPrivate
          ? ' (private repo? check that GITHUB_TOKEN / GIT_CREDENTIALS has read access to it)'
          : ''),
      cause,
    );
  }
}

/** Lists a checked-out directory. Symlinks are neither followed nor listed. */
export async function snapshotFromDir(dir: string): Promise<RepoSnapshot> {
  const root = await realpath(dir);
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  const files: string[] = [];
  const dirs: string[] = [];
  for (const entry of entries) {
    const rel = path
      .relative(root, path.join(entry.parentPath, entry.name))
      .split(path.sep)
      .join('/');
    if (rel === '.git' || rel.startsWith('.git/')) continue;
    if (entry.isFile()) files.push(rel);
    else if (entry.isDirectory()) dirs.push(rel);
  }

  return {
    files,
    dirs,
    async read(filePath) {
      // Paths come from manifests (`$values/../../etc/passwd`) and the repo may contain symlinks:
      // resolve fully and refuse anything that ends up outside the checkout.
      const resolved = await realpath(path.resolve(root, filePath)).catch(() => null);
      if (!resolved || !resolved.startsWith(root + path.sep)) {
        throw new RepoAccessError(`File not found in repo: ${filePath}`);
      }
      return readFile(resolved, 'utf-8');
    },
  };
}

/** One opener per scan: each repo@revision is cloned once and shared, `cleanup` removes clones
 * and the temporary credentials file. */
export function createRepoOpener(options: { githubToken?: string; credentials?: string[] } = {}): {
  openRepo: OpenRepo;
  cleanup: () => Promise<void>;
} {
  const cache = new Map<string, Promise<RepoSnapshot>>();
  const tempDirs: string[] = [];

  let authPromise: Promise<GitAuth> | undefined;
  const auth = () =>
    (authPromise ??= (async () => {
      if (!options.credentials?.length) return { githubToken: options.githubToken };
      const dir = await mkdtemp(path.join(tmpdir(), 'chart-monitor-cred-'));
      tempDirs.push(dir);
      const credentialsFile = path.join(dir, 'credentials');
      await writeFile(credentialsFile, options.credentials.join('\n') + '\n', { mode: 0o600 });
      return { githubToken: options.githubToken, credentialsFile };
    })());

  const openRepo: OpenRepo = (repoUrl, revision) => {
    const cloneUrl = toCloneUrl(repoUrl);
    const rev = revision || 'HEAD';
    const key = `${cloneUrl.toLowerCase().replace(/(\.git)?\/?$/, '')}@${rev}`;
    if (!cache.has(key)) {
      cache.set(
        key,
        (async () => {
          const dir = await mkdtemp(path.join(tmpdir(), 'chart-monitor-repo-'));
          tempDirs.push(dir);
          await cloneInto(dir, cloneUrl, rev, await auth());
          return snapshotFromDir(dir);
        })(),
      );
    }
    return cache.get(key)!;
  };

  const cleanup = async () => {
    await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  };

  return { openRepo, cleanup };
}
