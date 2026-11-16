import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { parseAllDocuments } from 'yaml';
import type { ApplicationSource } from '../argocd/types.js';
import { HelmResolutionError } from '../errors.js';

const execFileAsync = promisify(execFile);

// ArgoCD passes the cluster's real API versions; we don't have a cluster, so assume the CRDs charts
// most often gate on (e.g. cilium refuses to render serviceMonitor.enabled without them).
// ponytail: guessed list, extend when a chart fails validation on another CRD
const ASSUMED_API_VERSIONS = [
  'monitoring.coreos.com/v1',
  'monitoring.coreos.com/v1/ServiceMonitor',
  'monitoring.coreos.com/v1/PodMonitor',
  'monitoring.coreos.com/v1/PrometheusRule',
];

function buildHelmArgs(source: ApplicationSource, valuesFilePaths: string[]): string[] {
  const isOci = source.repoURL.startsWith('oci://');
  const chartRef = isOci ? `${source.repoURL}/${source.chart}` : (source.chart as string);

  const args = ['template', 'release', chartRef, '--version', source.targetRevision as string];
  if (!isOci) args.push('--repo', source.repoURL);
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

/** Shells out to `helm template` to render the chart at its currently deployed version and
 * extracts every container image reference from the rendered manifests. `valuesDocuments` are
 * YAML values passed as `-f` in order, later ones overriding earlier ones. */
export async function renderChartImages(
  source: ApplicationSource,
  valuesDocuments: string[] = [],
): Promise<string[]> {
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

    const { stdout } = await execFileAsync('helm', buildHelmArgs(source, valuesFilePaths), {
      maxBuffer: 1024 * 1024 * 20,
    });

    const images = new Set<string>();
    for (const doc of parseAllDocuments(stdout)) {
      collectImages(doc.toJS(), images);
    }
    return [...images];
  } catch (cause) {
    throw new HelmResolutionError(
      `helm template failed for chart "${source.chart}" @ ${source.targetRevision}`,
      cause,
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}
