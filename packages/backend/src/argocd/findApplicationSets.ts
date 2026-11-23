import { parseAllDocuments } from 'yaml';
import { expandGenerators, type Params } from './generators.js';
import { applyPatch, renderTemplatePatches } from './templatePatch.js';
import { substituteTemplate } from './template.js';
import {
  isApplicationManifest,
  isApplicationSetManifest,
  withWarningPrefix,
  type ApplicationManifest,
  type ApplicationSource,
  type ApplicationSetManifest,
  type ResolvedApplication,
  type ScanContext,
} from './types.js';

export interface ManifestFile {
  path: string;
  content: string;
}

function parseDocuments(files: ManifestFile[], ctx: ScanContext): unknown[] {
  return files.flatMap((file) => {
    try {
      return parseAllDocuments(file.content).map((doc) => doc.toJS());
    } catch (error) {
      ctx.warn(`${file.path}: could not parse YAML, skipped (${(error as Error).message})`);
      return [];
    }
  });
}

function resolvePlainApplication(manifest: ApplicationManifest): ResolvedApplication {
  const { source, sources } = manifest.spec;
  return {
    applicationSetName: '',
    applicationName: manifest.metadata?.name ?? '',
    sources: sources ?? (source ? [source] : []),
  };
}

interface PatchedApplication {
  metadata?: { name?: string };
  spec?: { source?: ApplicationSource; sources?: ApplicationSource[] };
}

/** The rendered templatePatch per param set, or null without one (or when it can't be rendered) */
async function renderPatches(
  manifest: ApplicationSetManifest,
  paramSets: Params[],
  ctx: ScanContext,
): Promise<Record<string, unknown>[] | null> {
  const { templatePatch, goTemplate } = manifest.spec;
  if (!templatePatch) return null;
  if (!goTemplate) {
    ctx.warn('templatePatch only works with goTemplate: true (as in ArgoCD), ignored');
    return null;
  }
  try {
    return await renderTemplatePatches(templatePatch, paramSets);
  } catch (error) {
    ctx.warn(`templatePatch could not be rendered, ignored: ${(error as Error).message}`);
    return null;
  }
}

async function resolveApplicationSet(
  manifest: ApplicationSetManifest,
  ctx: ScanContext,
): Promise<ResolvedApplication[]> {
  const paramSets = manifest.spec.generators?.length
    ? await expandGenerators(manifest.spec.generators, ctx)
    : [{}];

  const patches = await renderPatches(manifest, paramSets, ctx);
  if (!manifest.spec.template?.spec && !patches) {
    ctx.warn('has no template.spec, skipped');
    return [];
  }

  const unresolvedKeys = new Set<string>();
  const applications = paramSets.map((params, i): ResolvedApplication => {
    const { metadata, spec = {} } = manifest.spec.template ?? {};
    const nameResult = substituteTemplate(metadata?.name ?? '', params);
    const sourceResult = substituteTemplate({ source: spec.source, sources: spec.sources }, params);
    for (const key of [...nameResult.unresolvedKeys, ...sourceResult.unresolvedKeys]) {
      unresolvedKeys.add(key);
    }
    const application = applyPatch(
      { metadata: { name: nameResult.value }, spec: sourceResult.value },
      patches?.[i],
    ) as PatchedApplication;
    const { source, sources } = application.spec ?? {};

    return {
      applicationSetName: manifest.metadata.name,
      applicationName: application.metadata?.name || manifest.metadata.name,
      sources: sources ?? (source ? [source] : []),
    };
  });

  if (unresolvedKeys.size > 0) {
    ctx.warn(
      `template placeholders could not be resolved: ${[...unresolvedKeys].join(', ')} ` +
        '(unsupported generator or Go template function); affected sources may be skipped',
    );
  }
  return applications;
}

export async function resolveApplicationSets(
  files: ManifestFile[],
  ctx: ScanContext,
): Promise<ResolvedApplication[]> {
  const docs = parseDocuments(files, ctx);
  const plainApplications = docs.filter(isApplicationManifest).map(resolvePlainApplication);

  const resolved = await Promise.all(
    docs
      .filter(isApplicationSetManifest)
      .map((manifest) =>
        resolveApplicationSet(
          manifest,
          withWarningPrefix(ctx, `ApplicationSet "${manifest.metadata?.name}"`),
        ),
      ),
  );

  return [...plainApplications, ...resolved.flat()];
}
