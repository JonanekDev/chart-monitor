import { isDeepStrictEqual } from 'node:util';
import { parse } from 'yaml';
import {
  severityRank,
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
 * and are skipped. The defaults include the subcharts' (see pullChart).
 */
export function removedValueKeys(
  valuesDocuments: string[],
  parameterNames: string[],
  oldDefaults: unknown,
  newDefaults: unknown,
): string[] {
  const paths = [
    ...valuesDocuments.flatMap((document) => leafPaths(parse(document) as unknown, [], [])),
    ...parameterNames.map(parameterPath),
  ];
  const removed = new Set<string>();
  for (const path of paths) {
    const known = path.slice(0, existingDepth(oldDefaults, path));
    if (known.length > 0 && existingDepth(newDefaults, known) < known.length) {
      // --set notation, so a key with a dot in it (annotations) reads unambiguously
      removed.add(known.map((key) => key.replaceAll('.', '\\.')).join('.'));
    }
  }
  return [...removed].sort();
}

/** A `helm.parameters` name (`--set` syntax) as a values path: `a\.b.c[0].d` → a.b, c, d. List
 * indexes are dropped, lists count as a whole */
export function parameterPath(name: string): string[] {
  return name
    .split(/(?<!\\)\./)
    .map((key) => key.replace(/\\\./g, '.').replace(/\[\d+\]/g, ''))
    .filter(Boolean);
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

// Change with every chart version (or every render) without changing what gets deployed
const NOISY_METADATA = [
  'helm.sh/chart',
  'app.kubernetes.io/version',
  'controller-gen.kubebuilder.io/version',
];

// Versions and digests in any string (image tags, `chart: name-1.2.3` labels, `--image=…:v1.2`
// args) are masked: bumping them is what an upgrade does, and the image table already shows them.
// ponytail: also hides a changed plain decimal string like "1.5"; IPs are left alone
const VERSION = /(?<![\w.])v?\d+\.\d+(?:\.\d+)?(?![.\d])(?:[-+][\w.-]+)?/g;
const DIGEST = /@sha256:[0-9a-f]{64}/g;
const maskVersions = (text: string) => text.replace(DIGEST, '').replace(VERSION, '<version>');

function dropNoise(node: unknown): void {
  if (Array.isArray(node)) {
    node.forEach((item, i) => {
      if (typeof item === 'string') node[i] = maskVersions(item);
      else dropNoise(item);
    });
    return;
  }
  if (!isObject(node)) return;
  for (const [key, value] of Object.entries(node)) {
    if ((key === 'labels' || key === 'annotations') && isObject(value)) {
      for (const name of Object.keys(value)) {
        if (NOISY_METADATA.includes(name) || name.startsWith('checksum/')) delete value[name];
      }
    }
    // Generated certificates (genCA) differ on every render
    if (key === 'caBundle') node[key] = '';
    else if (typeof value === 'string') node[key] = maskVersions(value);
    else dropNoise(value);
  }
}

function normalize(manifest: Obj): Obj {
  const copy = structuredClone(manifest);
  dropNoise(copy);
  // Secret values are random (randAlphaNum) or sensitive: only compare which keys there are
  if (copy.kind === 'Secret') {
    for (const field of ['data', 'stringData']) {
      const data = copy[field];
      if (isObject(data)) for (const key of Object.keys(data)) data[key] = '***';
    }
  }
  return copy;
}

type Fields = ManifestChange['fields'];

const MAX_VALUE_LENGTH = 300;
const show = (value: unknown): string | null =>
  value === undefined ? null : JSON.stringify(value).slice(0, MAX_VALUE_LENGTH);

function keyed(list: unknown[], byName: boolean): Map<string, unknown> {
  return new Map(
    list.map((item, i) => [byName ? ((item as Obj).name as string) : String(i), item]),
  );
}

const isNamed = (list: unknown[]) =>
  list.every((item) => isObject(item) && typeof item.name === 'string');

/** Entries only one side has, ignoring order: `path[]` with null before (added) or after (removed) */
function diffUnordered(before: unknown[], after: unknown[], path: string, out: Fields): void {
  const remaining = [...after];
  for (const item of before) {
    const i = remaining.findIndex((other) => isDeepStrictEqual(other, item));
    if (i >= 0) remaining.splice(i, 1);
    else out.push({ path: `${path}[]`, before: show(item), after: null });
  }
  for (const item of remaining) out.push({ path: `${path}[]`, before: null, after: show(item) });
}

function diffFields(before: unknown, after: unknown, path: string, out: Fields): void {
  if (isDeepStrictEqual(before, after)) return;

  if (Array.isArray(before) && Array.isArray(after)) {
    // ponytail: a pure reorder counts as no change (rules, tolerations); the rare list whose order
    // matters (args) then hides a reorder
    if (canonical(before) === canonical(after)) return;
    // Lists like containers, env, ports and volumes are matched by name. Other lists by position
    // only while their length stays (rules, items edited in place); otherwise one inserted entry
    // (an extra arg or toleration) would shift and "change" every entry after it.
    const byName = isNamed(before) && isNamed(after);
    if (!byName && (before.length !== after.length || !before.every(isObject))) {
      return diffUnordered(before, after, path, out);
    }
    const [a, b] = [keyed(before, byName), keyed(after, byName)];
    for (const key of new Set([...a.keys(), ...b.keys()])) {
      diffFields(a.get(key), b.get(key), `${path}[${key}]`, out);
    }
    return;
  }
  if (isObject(before) && isObject(after)) {
    for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
      diffFields(before[key], after[key], path ? `${path}.${key}` : key, out);
    }
    return;
  }
  out.push({ path, before: show(before), after: show(after) });
}

// A CRD's schema changes in hundreds of fields that say little: those are only counted
const COUNT_ONLY_KINDS = ['CustomResourceDefinition'];
const MAX_FIELDS = 50;

// What a Role grants and whom a Binding grants it to
const RBAC_FIELDS: Record<string, string[]> = {
  Role: ['rules'],
  ClusterRole: ['rules', 'aggregationRule'],
  RoleBinding: ['subjects', 'roleRef'],
  ClusterRoleBinding: ['subjects', 'roleRef'],
};

/** Order-independent form: reordered rules, verbs or subjects grant the same */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).sort().join(',')}]`;
  if (isObject(value)) {
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'undefined';
}

/** Resource-level diff between two renders of a chart, keyed by kind + namespace + name. Changed
 * fields skip noise (version bumps, chart labels, checksums, generated certificates, Secret
 * values); immutable and RBAC fields are checked on the raw manifests, so a version in a selector
 * still counts. */
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
    const rbac = RBAC_FIELDS[String((a ?? b)!.kind)] ?? [];
    if (!a || !b) {
      // A new Role or Binding grants something; a removed one only takes away
      const rbacFields = b ? rbac.filter((field) => b[field] !== undefined) : [];
      changes.push({
        resource,
        change: a ? 'removed' : 'added',
        fields: [],
        fieldsNotListed: 0,
        immutableFields: [],
        rbacFields,
      });
      continue;
    }
    const immutableFields = (IMMUTABLE_FIELDS[String(a.kind)] ?? []).filter(
      (path) => !isDeepStrictEqual(at(a, path), at(b, path)),
    );
    const rbacFields = rbac.filter((field) => canonical(a[field]) !== canonical(b[field]));
    const fields: Fields = [];
    diffFields(normalize(a), normalize(b), '', fields);
    const listed = COUNT_ONLY_KINDS.includes(String(a.kind)) ? [] : fields.slice(0, MAX_FIELDS);
    if (fields.length || immutableFields.length || rbacFields.length) {
      changes.push({
        resource,
        change: 'changed',
        fields: listed,
        fieldsNotListed: fields.length - listed.length,
        immutableFields,
        rbacFields,
      });
    }
  }
  return changes.sort((x, y) => x.resource.localeCompare(y.resource));
}

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
      .sort((x, y) => severityRank(y.severity) - severityRank(x.severity));
  return { fixed: only(before, after), introduced: only(after, before) };
}
