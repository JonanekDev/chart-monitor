import { posix } from 'node:path';
import { parse, stringify } from 'yaml';
import type { ApplicationSource, ScanContext } from './types.js';
import { collectValuesDocuments } from './valueFiles.js';

interface ChartDependency {
  name?: string;
  alias?: string;
  version?: string;
  repository?: string;
}

export interface ChartToScan {
  source: ApplicationSource;
  valuesDocuments: string[];
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** A git `path` source pointing at a Helm chart whose Chart.yaml pulls external charts as
 * dependencies (the "umbrella chart" pattern). Each remote dependency becomes its own chart to
 * scan, with the umbrella's values for it (`<alias|name>:` subtree plus `global:`). A path without
 * Chart.yaml (plain manifests, kustomize) yields nothing.
 * ponytail: the umbrella's own templates are not rendered */
export async function expandUmbrellaChart(
  source: ApplicationSource,
  siblings: ApplicationSource[],
  ctx: ScanContext,
): Promise<ChartToScan[]> {
  if (source.chart || source.path === undefined) return [];

  const repo = await ctx.openRepo(source.repoURL, source.targetRevision);
  const dir = posix.normalize(source.path).replace(/^\.?\/+|\/+$/g, '').replace(/^\.$/, '');
  const inDir = (file: string) => (dir ? `${dir}/${file}` : file);
  if (!repo.files.includes(inDir('Chart.yaml'))) return [];

  const chart: unknown = parse(await repo.read(inDir('Chart.yaml')));
  const dependencies = ((isObject(chart) && chart.dependencies) || []) as ChartDependency[];
  const remote = dependencies.filter((dep) => {
    const ok = dep.name && dep.version && /^(https?|oci):\/\//.test(dep.repository ?? '');
    if (!ok) {
      ctx.warn(
        `umbrella chart ${dir || '.'}: dependency "${dep.name}" (repository "${dep.repository}") ` +
          'is local or uses a repo alias, not scanned',
      );
    }
    return ok;
  });
  if (remote.length === 0) return [];

  // Same precedence as ArgoCD: chart values.yaml < valueFiles < values < valuesObject.
  // ponytail: chart-relative valueFiles are all applied before `$ref/` ones, regardless of listed order
  const readOptional = (file: string) => repo.read(inDir(file)).catch(() => '');
  const chartRelativeFiles = (source.helm?.valueFiles ?? []).filter((f) => !f.startsWith('$'));
  const refSource = {
    ...source,
    helm: { ...source.helm, valueFiles: source.helm?.valueFiles?.filter((f) => f.startsWith('$')) },
  };
  const umbrellaDocuments = [
    await readOptional('values.yaml'),
    ...(await Promise.all(chartRelativeFiles.map(readOptional))),
    ...(await collectValuesDocuments(refSource, siblings, ctx)),
  ]
    .map((content) => parse(content) as unknown)
    .filter(isObject);

  return remote.map((dep) => {
    const key = (dep.alias ?? dep.name) as string;
    return {
      source: { repoURL: dep.repository as string, chart: dep.name, targetRevision: dep.version },
      valuesDocuments: umbrellaDocuments.map((doc) =>
        stringify({
          ...(isObject(doc[key]) ? doc[key] : {}),
          ...(doc.global !== undefined ? { global: doc.global } : {}),
        }),
      ),
    };
  });
}
