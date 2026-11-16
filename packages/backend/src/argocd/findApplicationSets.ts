import { parseAllDocuments } from 'yaml';
import { expandGenerators } from './generators.js';
import { substituteTemplate } from './template.js';
import {
  isApplicationManifest,
  isApplicationSetManifest,
  withWarningPrefix,
  type ApplicationManifest,
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

async function resolveApplicationSet(
  manifest: ApplicationSetManifest,
  ctx: ScanContext,
): Promise<ResolvedApplication[]> {
  const paramSets = manifest.spec.generators?.length
    ? await expandGenerators(manifest.spec.generators, ctx)
    : [{}];

  if (!manifest.spec.template?.spec) {
    ctx.warn('has no template.spec (only templatePatch?), skipped');
    return [];
  }

  const unresolvedKeys = new Set<string>();
  const applications = paramSets.map((params): ResolvedApplication => {
    const templateSpec = manifest.spec.template.spec ?? {};
    const rawSources = templateSpec.sources ?? (templateSpec.source ? [templateSpec.source] : []);

    const nameResult = substituteTemplate(manifest.spec.template.metadata?.name ?? '', params);
    const sourcesResult = substituteTemplate(rawSources, params);
    for (const key of [...nameResult.unresolvedKeys, ...sourcesResult.unresolvedKeys]) {
      unresolvedKeys.add(key);
    }

    return {
      applicationSetName: manifest.metadata.name,
      applicationName: nameResult.value || manifest.metadata.name,
      sources: sourcesResult.value,
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
