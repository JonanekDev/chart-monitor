import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { parse, parseAllDocuments } from 'yaml';
import type { Params } from './generators.js';

const execFileAsync = promisify(execFile);

type Obj = Record<string, unknown>;
const isObject = (value: unknown): value is Obj =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Dotted params back into the nested shape a goTemplate sees (`path.path` → `.path.path`). A
 * nested key wins over a plain one of the same name (`path` vs `path.path`), as in ArgoCD. */
export function nestParams(params: Params): Obj {
  const root: Obj = {};
  const byDepth = Object.entries(params).sort(
    ([a], [b]) => a.split('.').length - b.split('.').length,
  );
  for (const [key, value] of byDepth) {
    const parts = key.split('.');
    let node = root;
    for (const part of parts.slice(0, -1)) {
      if (!isObject(node[part])) node[part] = {};
      node = node[part] as Obj;
    }
    const last = parts[parts.length - 1]!;
    if (!isObject(node[last])) node[last] = value;
  }
  return root;
}

// `tpl` renders the patch with each param set as its context; base64 keeps the rendered YAML
// intact inside the document that carries it
const PATCHES_TEMPLATE = `{{- range $i, $item := .Values.items }}
---
index: {{ $i }}
patch: {{ tpl $.Values.patch $item | b64enc | quote }}
{{- end }}
`;

/**
 * Renders a goTemplate `templatePatch` for every param set. Helm's template engine is Go's
 * text/template with the Sprig functions, like ArgoCD's, so `if`, `range`, `quote`, `hasKey`… work.
 * One `helm template` run per ApplicationSet, no network.
 * ponytail: ArgoCD-only functions (normalize, slugify) fail the whole render; `$` is the chart
 * root instead of the params
 */
export async function renderTemplatePatches(patch: string, paramSets: Params[]): Promise<Obj[]> {
  const dir = await mkdtemp(path.join(tmpdir(), 'chart-monitor-patch-'));
  try {
    await mkdir(path.join(dir, 'templates'));
    await writeFile(path.join(dir, 'Chart.yaml'), 'apiVersion: v2\nname: patch\nversion: 0.0.0\n');
    await writeFile(path.join(dir, 'templates', 'patches.yaml'), PATCHES_TEMPLATE);
    // JSON is YAML, and keeps every param's type
    const values = path.join(dir, 'values.json');
    await writeFile(values, JSON.stringify({ patch, items: paramSets.map(nestParams) }));

    const { stdout } = await execFileAsync('helm', ['template', 'patch', dir, '-f', values], {
      maxBuffer: 1024 * 1024 * 20,
    });
    const rendered = new Map<number, Obj>();
    for (const doc of parseAllDocuments(stdout)) {
      const item = doc.toJS() as { index?: number; patch?: string } | null;
      if (typeof item?.index !== 'number' || typeof item.patch !== 'string') continue;
      const parsed = parse(Buffer.from(item.patch, 'base64').toString('utf-8')) as unknown;
      rendered.set(item.index, isObject(parsed) ? parsed : {});
    }
    return paramSets.map((_, i) => rendered.get(i) ?? {});
  } catch (error) {
    const stderr = (error as { stderr?: string }).stderr ?? '';
    const detail =
      stderr.split('\n').find((line) => /error/i.test(line)) ?? (error as Error).message;
    throw new Error(detail.replace(/^Error: /, '').slice(0, 300));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Applies a rendered patch the way ArgoCD does for Applications: maps merge, lists are replaced,
 * and a key set to null is removed (e.g. `source:` when the patch moves to `sources`). */
export function applyPatch(target: unknown, patch: unknown): unknown {
  if (!isObject(patch)) return patch === undefined ? target : patch;
  const merged: Obj = isObject(target) ? { ...target } : {};
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete merged[key];
    else merged[key] = applyPatch(merged[key], value);
  }
  return merged;
}
