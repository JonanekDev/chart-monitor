import { execFile } from 'node:child_process';
import { lstat, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { parse, parseAllDocuments } from 'yaml';
import type { ApplicationSource } from '../argocd/types.js';
import { helmRepoCredentials } from '../config/auth.js';
import type { Credentials } from '../config/credentials.js';
import { env } from '../config/env.js';
import { HelmResolutionError } from '../errors.js';

const execFileAsync = promisify(execFile);

// helm reads OCI registry logins from a config.json in Docker's format: the same file as trivy
const HELM_ENV = env.DOCKER_CONFIG
  ? { ...process.env, HELM_REGISTRY_CONFIG: env.DOCKER_CONFIG.file }
  : process.env;

/** `helm repo add` with the password on stdin, so it never shows up in a process list */
function repoAdd(args: string[], password: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = execFile('helm', args, { env: HELM_ENV }, (error, _stdout, stderr) =>
      error ? reject(Object.assign(error, { stderr })) : resolve(),
    );
    child.stdin?.end(password);
  });
}

/** One per scan. Private classic repos (HELM_REPO_CREDENTIALS) can't take a login with `--repo`
 * without putting the password on the command line, so they're added under an alias to a
 * repositories.yaml, with its own cache, in the scan's temp dir; `cleanup` removes both. */
export class HelmSession {
  private readonly aliases = new Map<string, Promise<string>>();
  // One `helm repo add` at a time: they all rewrite the same repositories.yaml
  private adding: Promise<unknown> = Promise.resolve();

  private constructor(private readonly dir: string) {}

  static async create(): Promise<HelmSession> {
    return new HelmSession(await mkdtemp(path.join(tmpdir(), 'chart-monitor-helm-')));
  }

  cleanup(): Promise<void> {
    return rm(this.dir, { recursive: true, force: true });
  }

  private get repoConfigArgs(): string[] {
    return [
      '--repository-config',
      path.join(this.dir, 'repositories.yaml'),
      '--repository-cache',
      path.join(this.dir, 'cache'),
    ];
  }

  /** What selects the chart at `source.targetRevision` in `helm template` / `helm show` */
  async chartArgs(source: ApplicationSource): Promise<string[]> {
    const version = ['--version', source.targetRevision as string];
    if (source.repoURL.startsWith('oci://')) {
      return [`${source.repoURL}/${source.chart}`, ...version];
    }
    const login = helmRepoCredentials(source.repoURL);
    if (!login) return [source.chart as string, ...version, '--repo', source.repoURL];
    return [
      `${await this.alias(source.repoURL, login)}/${source.chart}`,
      ...version,
      ...this.repoConfigArgs,
    ];
  }

  private alias(repoUrl: string, login: Credentials): Promise<string> {
    let alias = this.aliases.get(repoUrl);
    if (!alias) {
      const name = `private-${this.aliases.size}`;
      const args = ['repo', 'add', name, repoUrl, '--username', login.username, '--password-stdin'];
      alias = this.adding
        .catch(() => {})
        .then(() => repoAdd([...args, ...this.repoConfigArgs], login.password))
        .then(() => name);
      this.adding = alias;
      this.aliases.set(repoUrl, alias);
    }
    return alias;
  }
}

// ArgoCD passes the cluster's real API versions; we don't have a cluster, so assume the CRDs charts
// most often gate on (e.g. cilium refuses to render serviceMonitor.enabled without them).
// ponytail: guessed list, extend when a chart fails validation on another CRD
const ASSUMED_API_VERSIONS = [
  'monitoring.coreos.com/v1',
  'monitoring.coreos.com/v1/ServiceMonitor',
  'monitoring.coreos.com/v1/PodMonitor',
  'monitoring.coreos.com/v1/PrometheusRule',
];

function buildHelmArgs(
  source: ApplicationSource,
  chartArgs: string[],
  valuesFilePaths: string[],
): string[] {
  const args = ['template', 'release', ...chartArgs];
  for (const apiVersion of [...ASSUMED_API_VERSIONS, ...(source.helm?.apiVersions ?? [])]) {
    args.push('--api-versions', apiVersion);
  }
  if (source.helm?.kubeVersion) args.push('--kube-version', source.helm.kubeVersion);
  for (const filePath of valuesFilePaths) args.push('-f', filePath);
  for (const param of source.helm?.parameters ?? []) {
    args.push('--set', `${param.name}=${param.value}`);
  }
  return args;
}

// Recursively collects every string value found under an image key in the rendered manifests.
function collectImages(node: unknown, images: Set<string>): void {
  if (Array.isArray(node)) {
    for (const item of node) collectImages(item, images);
    return;
  }
  if (node !== null && typeof node === 'object') {
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      if (key === 'image' && typeof value === 'string' && value.length > 0) {
        images.add(value);
      } else {
        collectImages(value, images);
      }
    }
  }
}

/** Every container image reference in rendered manifests */
export function findImages(manifests: unknown[]): string[] {
  const images = new Set<string>();
  collectImages(manifests, images);
  return [...images];
}

/** Shells out to `helm template` to render the chart at `source.targetRevision` and returns the
 * parsed manifests. `valuesDocuments` are YAML values passed as `-f` in order, later ones
 * overriding earlier ones. */
export async function renderChart(
  helm: HelmSession,
  source: ApplicationSource,
  valuesDocuments: string[] = [],
): Promise<unknown[]> {
  if (!source.chart || !source.targetRevision) return [];

  const tempDir = await mkdtemp(path.join(tmpdir(), 'chart-monitor-'));
  try {
    const valuesFilePaths = await Promise.all(
      valuesDocuments.map(async (content, i) => {
        const filePath = path.join(tempDir, `values-${i}.yaml`);
        await writeFile(filePath, content, 'utf-8');
        return filePath;
      }),
    );

    const args = buildHelmArgs(source, await helm.chartArgs(source), valuesFilePaths);
    const { stdout } = await execFileAsync('helm', args, {
      env: HELM_ENV,
      maxBuffer: 1024 * 1024 * 20,
    });
    return parseAllDocuments(stdout)
      .map((doc) => doc.toJS() as unknown)
      .filter((manifest) => manifest != null);
  } catch (cause) {
    throw new HelmResolutionError(
      `helm template failed for chart "${source.chart}" @ ${source.targetRevision}`,
      cause,
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

/** What `Chart.yaml` says about a chart version (the fields used here) */
export interface ChartMetadata {
  name?: string;
  home?: string;
  sources?: string[];
  annotations?: Record<string, string>;
  dependencies?: { name: string; alias?: string }[];
}

export interface PulledChart {
  /** values.yaml with each subchart's defaults under its alias or name, as Helm merges them */
  defaults: Record<string, unknown>;
  metadata: ChartMetadata;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** `override` wins; maps merge key by key, anything else replaces */
function mergeValues(base: unknown, override: unknown): unknown {
  if (!isObject(base) || !isObject(override)) return override === undefined ? base : override;
  const merged = { ...base };
  for (const [key, value] of Object.entries(override)) merged[key] = mergeValues(base[key], value);
  return merged;
}

/** A regular file's content; null for a missing file or a symlink (charts are untrusted) */
async function readChartFile(file: string): Promise<string | null> {
  const info = await lstat(file).catch(() => null);
  return info?.isFile() ? readFile(file, 'utf-8') : null;
}

/** Packaged subcharts are tarballs inside the chart; refuses entries that would land outside */
async function untar(archive: string, into: string): Promise<string> {
  const { stdout } = await execFileAsync('tar', ['-tzf', archive]);
  if (
    stdout.split('\n').some((entry) => entry.startsWith('/') || entry.split('/').includes('..'))
  ) {
    throw new Error(`${path.basename(archive)} has paths outside the chart`);
  }
  const dir = await mkdtemp(path.join(into, 'subchart-'));
  await execFileAsync('tar', ['-xzf', archive, '-C', dir]);
  const [chartDir] = await readdir(dir);
  return path.join(dir, chartDir ?? '');
}

async function chartDefaults(dir: string): Promise<PulledChart> {
  const metadata = (parse((await readChartFile(path.join(dir, 'Chart.yaml'))) ?? '') ??
    {}) as ChartMetadata;
  const parsed = parse((await readChartFile(path.join(dir, 'values.yaml'))) ?? '') as unknown;
  const defaults = isObject(parsed) ? parsed : {};

  const subchartsDir = path.join(dir, 'charts');
  for (const entry of await readdir(subchartsDir, { withFileTypes: true }).catch(() => [])) {
    const entryPath = path.join(subchartsDir, entry.name);
    const subDir = entry.name.endsWith('.tgz')
      ? await untar(entryPath, dir)
      : entry.isDirectory()
        ? entryPath
        : null;
    if (!subDir) continue;
    const sub = await chartDefaults(subDir);
    // The same chart can be a dependency twice, under different aliases
    const deps = (metadata.dependencies ?? []).filter((d) => d.name === sub.metadata.name);
    const keys = deps.length
      ? deps.map((d) => d.alias ?? d.name)
      : [sub.metadata.name ?? entry.name];
    for (const key of keys) defaults[key] = mergeValues(sub.defaults, defaults[key]);
  }
  return { defaults, metadata };
}

/** Downloads the chart at `source.targetRevision` (`helm pull --untar`): its default values,
 * including the subcharts' (which `helm show values` leaves out), and its Chart.yaml */
export async function pullChart(
  helm: HelmSession,
  source: ApplicationSource,
): Promise<PulledChart> {
  const dir = await mkdtemp(path.join(tmpdir(), 'chart-monitor-pull-'));
  try {
    const args = ['pull', ...(await helm.chartArgs(source)), '--untar', '--untardir', dir];
    await execFileAsync('helm', args, { env: HELM_ENV, maxBuffer: 1024 * 1024 * 20 });
    const [chartDir] = await readdir(dir);
    return await chartDefaults(path.join(dir, chartDir ?? ''));
  } catch (cause) {
    throw new HelmResolutionError(
      `helm pull failed for chart "${source.chart}" @ ${source.targetRevision}`,
      cause,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
