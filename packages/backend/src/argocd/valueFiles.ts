import { stringify } from 'yaml';
import type { ApplicationSource, ScanContext } from './types.js';

const REF_VALUE_FILE = /^\$([^/]+)\/+(.+)$/;

async function readRefValueFile(
  valueFile: string,
  source: ApplicationSource,
  siblings: ApplicationSource[],
  ctx: ScanContext,
): Promise<string | null> {
  const match = REF_VALUE_FILE.exec(valueFile);
  if (!match) {
    // Chart-relative files live inside the packaged chart; reading them would need it unpacked
    ctx.warn(`value file "${valueFile}" is relative to the chart, not supported, skipped`);
    return null;
  }
  const refSource = siblings.find((s) => s.ref === match[1]);
  if (!refSource) {
    ctx.warn(`value file "${valueFile}": no source with ref "${match[1]}", skipped`);
    return null;
  }

  try {
    const repo = await ctx.openRepo(refSource.repoURL, refSource.targetRevision);
    return await repo.read(match[2] as string);
  } catch (error) {
    if (!source.helm?.ignoreMissingValueFiles) {
      ctx.warn(`value file "${valueFile}" could not be read, skipped: ${(error as Error).message}`);
    }
    return null;
  }
}

/** Collects the Helm values an ArgoCD source would use, in ArgoCD's precedence order:
 * `valueFiles` (only `$ref/...` ones) < `values` < `valuesObject`. */
export async function collectValuesDocuments(
  source: ApplicationSource,
  siblings: ApplicationSource[],
  ctx: ScanContext,
): Promise<string[]> {
  const fromFiles = await Promise.all(
    (source.helm?.valueFiles ?? []).map((file) => readRefValueFile(file, source, siblings, ctx)),
  );

  return [
    ...fromFiles.filter((content): content is string => content !== null),
    ...(source.helm?.values ? [source.helm.values] : []),
    ...(source.helm?.valuesObject ? [stringify(source.helm.valuesObject)] : []),
  ];
}
