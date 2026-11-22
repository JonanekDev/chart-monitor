import { isDeepStrictEqual } from 'node:util';
import { parse } from 'yaml';
import {
  CveSeverity,
  type ChartUpgrade,
  type ManifestChange,
  type VulnerabilityChange,
} from '@chart-monitor/shared';

type Obj = Record<string, unknown>;

const isObject = (value: unknown): value is Obj =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function leafPaths(node: unknown, prefix: string[], out: string[][]): string[][] {
  if (isObject(node) && Object.keys(node).length > 0) {
    for (const [key, value] of Object.entries(node)) leafPaths(value, [...prefix, key], out);
  } else if (prefix.length > 0) {
    out.push(prefix);
  }
  return out;
}

/** Length of the longest prefix of `path` that exists in `node` */
function existingDepth(node: unknown, path: string[]): number {
  let depth = 0;
  for (const key of path) {
    if (!isObject(node) || !Object.hasOwn(node, key)) break;
    node = node[key];
    depth++;
  }
  return depth;
}

/**
 * Keys the app sets that existed in the old chart's defaults but are gone from the new ones.
 * Helm ignores unknown keys without a word, so a renamed key silently drops the setting.
 * Keys the old defaults didn't have either (free-form maps, commented-out examples) can't be judged
 * and are skipped.
 * ponytail: only the parent chart's values.yaml; keys moved into a subchart's defaults show up as
 * removed
 */
export function removedValueKeys(
  valuesDocuments: string[],
  oldDefaults: unknown,
  newDefaults: unknown,
): string[] {
  const removed = new Set<string>();
  for (const document of valuesDocuments) {
    for (const path of leafPaths(parse(document) as unknown, [], [])) {
      const known = path.slice(0, existingDepth(oldDefaults, path));
      if (known.length > 0 && existingDepth(newDefaults, known) < known.length) {
        removed.add(known.join('.'));
      }
    }
  }
  return [...removed].sort();
}

function resourceName(manifest: Obj): string {
  const metadata = isObject(manifest.metadata) ? manifest.metadata : {};
  const namespace = typeof metadata.namespace === 'string' ? `${metadata.namespace}/` : '';
  return `${String(manifest.kind)} ${namespace}${String(metadata.name)}`;
}

const at = (node: unknown, path: string) =>
  path.split('.').reduce((value, key) => (isObject(value) ? value[key] : undefined), node);

const IMMUTABLE_FIELDS: Record<string, string[]> = {
  Deployment: ['spec.selector'],
  DaemonSet: ['spec.selector'],
  ReplicaSet: ['spec.selector'],
  StatefulSet: [
    'spec.selector',
    'spec.serviceName',
    'spec.podManagementPolicy',
    'spec.volumeClaimTemplates',
  ],
};

/** Resources the new version adds or removes, plus those whose immutable fields change. Other
 * changes are left out: mostly version bumps and chart internals, and ArgoCD shows the full diff
 * at sync time anyway. */
export function diffManifests(before: unknown[], after: unknown[]): ManifestChange[] {
  const index = (manifests: unknown[]) =>
    new Map(
      manifests
        // helm also prints non-resource documents, e.g. `Digest: sha256:…` when pulling OCI charts
        .filter(
          (manifest): manifest is Obj => isObject(manifest) && typeof manifest.kind === 'string',
        )
        .map((manifest) => [resourceName(manifest), manifest]),
    );
  const [old, next] = [index(before), index(after)];

  const changes: ManifestChange[] = [];
  for (const resource of new Set([...old.keys(), ...next.keys()])) {
    const [a, b] = [old.get(resource), next.get(resource)];
    if (!a || !b) {
      changes.push({ resource, change: a ? 'removed' : 'added', immutableFields: [] });
      continue;
    }
    const immutableFields = (IMMUTABLE_FIELDS[String(a.kind)] ?? []).filter(
      (path) => !isDeepStrictEqual(at(a, path), at(b, path)),
    );
    if (immutableFields.length) changes.push({ resource, change: 'changed', immutableFields });
  }
  return changes.sort((x, y) => x.resource.localeCompare(y.resource));
}

// UNKNOWN … CRITICAL, so a higher index is more severe
const severityRank = (v: VulnerabilityChange) => Object.values(CveSeverity).indexOf(v.severity);

/** CVEs (by id + package, across all of the app's images) only the current or only the upgraded
 * images have. By package rather than image: a chart may swap or rename an image. */
export function diffVulnerabilities(
  current: VulnerabilityChange[],
  latest: VulnerabilityChange[],
): NonNullable<ChartUpgrade['vulnerabilities']> {
  const byKey = (list: VulnerabilityChange[]) =>
    new Map(list.map((v) => [`${v.vulnerabilityId}|${v.pkgName}`, v]));
  const [before, after] = [byKey(current), byKey(latest)];
  const only = (a: typeof before, b: typeof before) =>
    [...a]
      .filter(([key]) => !b.has(key))
      .map(([, v]) => v)
      .sort((x, y) => severityRank(y) - severityRank(x));
  return { fixed: only(before, after), introduced: only(after, before) };
}
