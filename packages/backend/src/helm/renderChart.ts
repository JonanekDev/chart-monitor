import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { parseAllDocuments } from 'yaml';
import type { ApplicationSource } from '../argocd/types.js';
import { HelmResolutionError } from '../errors.js';

const execFileAsync = promisify(execFile);

function buildHelmArgs(source: ApplicationSource, valuesFilePath: string | null): string[] {
  const isOci = source.repoURL.startsWith('oci://');
  const chartRef = isOci ? `${source.repoURL}/${source.chart}` : (source.chart as string);

  const args = ['template', 'release', chartRef, '--version', source.targetRevision as string];
  if (!isOci) args.push('--repo', source.repoURL);
  if (valuesFilePath) args.push('-f', valuesFilePath);
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
 * extracts every container image reference from the rendered manifests. */
export async function renderChartImages(source: ApplicationSource): Promise<string[]> {
  if (!source.chart || !source.targetRevision) return [];

  let valuesFilePath: string | null = null;
  let tempDir: string | null = null;
  if (source.helm?.values) {
    tempDir = await mkdtemp(path.join(tmpdir(), 'chart-monitor-'));
    valuesFilePath = path.join(tempDir, 'values.yaml');
    await writeFile(valuesFilePath, source.helm.values, 'utf-8');
  }

  try {
    const { stdout } = await execFileAsync('helm', buildHelmArgs(source, valuesFilePath), {
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
    if (tempDir) await rm(tempDir, { recursive: true, force: true });
  }
}
