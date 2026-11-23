import { posix } from 'node:path';
import { minimatch } from 'minimatch';
import { parse } from 'yaml';
import { substituteTemplate } from './template.js';
import type { ApplicationSetGenerator, ScanContext } from './types.js';

/** Template params by dotted key (`aws.region`). Values keep their YAML type, lists included:
 * plain placeholders only use scalars, but a goTemplate templatePatch needs `range` and `if`. */
export type Params = Record<string, unknown>;

/** Flattens parsed YAML into params the way ArgoCD does: nested keys are joined with dots
 * (`{ aws: { region: x } }` → `aws.region`); lists stay whole. */
export function flattenParams(obj: Record<string, unknown>, prefix = ''): Params {
  return Object.fromEntries(
    Object.entries(obj).flatMap(([key, value]): [string, unknown][] => {
      const fullKey = prefix + key;
      if (value === null) return [];
      if (typeof value === 'object' && !Array.isArray(value)) {
        return Object.entries(flattenParams(value as Record<string, unknown>, `${fullKey}.`));
      }
      return [[fullKey, value]];
    }),
  );
}

async function expandGitDirectoryGenerator(
  generator: NonNullable<ApplicationSetGenerator['git']>,
  ctx: ScanContext,
): Promise<Params[]> {
  if (!generator.directories?.length) return [];
  const repo = await ctx.openRepo(generator.repoURL, generator.revision);

  const includePatterns = generator.directories.filter((d) => !d.exclude).map((d) => d.path);
  const excludePatterns = generator.directories.filter((d) => d.exclude).map((d) => d.path);

  const matched = repo.dirs.filter(
    (path) =>
      includePatterns.some((pattern) => minimatch(path, pattern)) &&
      !excludePatterns.some((pattern) => minimatch(path, pattern)),
  );

  return matched.map((path) => ({
    path,
    'path.path': path, // goTemplate mode name for the same value
    'path.basename': path.split('/').pop() ?? path,
  }));
}

const dir = (file: string) => posix.dirname(file).replace(/^\.$/, '');

/** Expands a `git.files` generator: each matched file is parsed as YAML and must contain either a
 * list of param objects, or a single param object. */
async function expandGitFilesGenerator(
  generator: NonNullable<ApplicationSetGenerator['git']>,
  ctx: ScanContext,
): Promise<Params[]> {
  if (!generator.files?.length) return [];
  const repo = await ctx.openRepo(generator.repoURL, generator.revision);

  const filePaths = repo.files.filter((path) =>
    generator.files!.some((f) => minimatch(path, f.path)),
  );

  const paramSets = await Promise.all(
    filePaths.map(async (path) => {
      const parsed: unknown = parse(await repo.read(path));
      const items = Array.isArray(parsed) ? parsed : [parsed];
      return items
        .filter(
          (item): item is Record<string, unknown> => typeof item === 'object' && item !== null,
        )
        .map((item) => ({
          ...flattenParams(item),
          // Where the file is, as ArgoCD adds it: `{{path}}` or, with goTemplate, `.path.path`
          path: dir(path),
          'path.path': dir(path),
          'path.basename': posix.basename(dir(path)),
          'path.filename': posix.basename(path),
        }));
    }),
  );

  return paramSets.flat();
}

async function expandGenerator(
  generator: ApplicationSetGenerator,
  ctx: ScanContext,
): Promise<Params[]> {
  if (generator.list) {
    return (generator.list.elements ?? []).map((element) => flattenParams(element));
  }
  if (generator.git?.files) {
    return expandGitFilesGenerator(generator.git, ctx);
  }
  if (generator.git?.directories) {
    return expandGitDirectoryGenerator(generator.git, ctx);
  }
  if (generator.matrix) {
    return expandMatrixGenerator(generator.matrix.generators, ctx);
  }
  if (generator.merge) {
    return expandMergeGenerator(generator.merge, ctx);
  }
  const kind = Object.keys(generator)[0] ?? 'unknown';
  ctx.warn(
    `generator "${kind}" is not supported (its parameters only exist inside a running ArgoCD), skipped`,
  );
  return [];
}

async function expandWithValues(
  generator: ApplicationSetGenerator,
  ctx: ScanContext,
): Promise<Params[]> {
  return applyGeneratorValues(generator, await expandGenerator(generator, ctx));
}

/** The second child may reference the first child's params (e.g. a git files path built from
 * `{{path}}`), so it is expanded once per distinct substituted form. */
async function expandMatrixGenerator(
  children: ApplicationSetGenerator[],
  ctx: ScanContext,
): Promise<Params[]> {
  const [first, second] = children;
  if (!first || !second || children.length > 2) {
    ctx.warn('matrix generator needs exactly two child generators, skipped');
    return [];
  }

  const firstSets = await expandWithValues(first, ctx);
  const secondCache = new Map<string, Promise<Params[]>>();
  const combined = await Promise.all(
    firstSets.map(async (firstParams) => {
      const substituted = substituteTemplate(second, firstParams).value;
      const key = JSON.stringify(substituted);
      if (!secondCache.has(key)) secondCache.set(key, expandWithValues(substituted, ctx));
      const secondSets = await secondCache.get(key)!;
      return secondSets.map((secondParams) => ({ ...firstParams, ...secondParams }));
    }),
  );
  return combined.flat();
}

async function expandMergeGenerator(
  { generators: children, mergeKeys }: NonNullable<ApplicationSetGenerator['merge']>,
  ctx: ScanContext,
): Promise<Params[]> {
  const [base = [], ...overrides] = await Promise.all(
    children.map((child) => expandWithValues(child, ctx)),
  );
  return base.map((row) =>
    overrides.reduce((merged, overrideSets) => {
      const match = overrideSets.find((o) => mergeKeys.every((k) => o[k] === merged[k]));
      return match ? { ...merged, ...match } : merged;
    }, row),
  );
}

/** Adds the generator's `values:` block as `values.<key>` params. Values may reference the
 * generator's own params (e.g. `{{path.basename}}`), same as in ArgoCD. */
function applyGeneratorValues(generator: ApplicationSetGenerator, paramSets: Params[]): Params[] {
  // Every generator is a single-key object ({ git: {...} }, { list: {...} }, ...)
  const values = (Object.values(generator)[0] as { values?: Record<string, unknown> } | undefined)
    ?.values;
  if (!values) return paramSets;
  return paramSets.map((params) => ({
    ...params,
    ...flattenParams(substituteTemplate(values, params).value, 'values.'),
  }));
}

/** Expands supported ApplicationSet generators into flat template-param sets. Unsupported generator
 * kinds and generators whose repo cannot be read are skipped with a warning. */
export async function expandGenerators(
  generators: ApplicationSetGenerator[],
  ctx: ScanContext,
): Promise<Params[]> {
  const results = await Promise.all(
    generators.map(async (generator) => {
      try {
        return await expandWithValues(generator, ctx);
      } catch (error) {
        const kind = Object.keys(generator)[0] ?? 'unknown';
        ctx.warn(`generator "${kind}" failed, skipped: ${(error as Error).message}`);
        return [];
      }
    }),
  );
  return results.flat();
}
