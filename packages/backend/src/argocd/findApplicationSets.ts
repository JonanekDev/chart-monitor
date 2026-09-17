import { parseAllDocuments } from 'yaml';
import type { RepoFile } from '../github/repoClient.js';
import type { ResolveOctokit } from './generators.js';
import { expandGenerators } from './generators.js';
import { substituteTemplate } from './template.js';
import { isApplicationSetManifest, type ResolvedApplication } from './types.js';

function extractManifests(files: RepoFile[]) {
  return files.flatMap((file) => {
    let docs: unknown[];
    try {
      docs = parseAllDocuments(file.content).map((doc) => doc.toJS());
    } catch {
      return [];
    }
    return docs.filter(isApplicationSetManifest);
  });
}

export async function resolveApplicationSets(
  files: RepoFile[],
  resolveOctokit: ResolveOctokit,
): Promise<ResolvedApplication[]> {
  const manifests = extractManifests(files);

  const resolved = await Promise.all(
    manifests.map(async (manifest) => {
      const paramSets = manifest.spec.generators?.length
        ? await expandGenerators(manifest.spec.generators, resolveOctokit)
        : [{}];

      return paramSets.map((params): ResolvedApplication => {
        const templateSpec = manifest.spec.template.spec ?? {};
        const rawSources = templateSpec.sources ?? (templateSpec.source ? [templateSpec.source] : []);

        const nameResult = substituteTemplate(manifest.spec.template.metadata?.name ?? '', params);
        const sourcesResult = substituteTemplate(rawSources, params);

        return {
          applicationSetName: manifest.metadata.name,
          applicationName: nameResult.value || manifest.metadata.name,
          sources: sourcesResult.value,
          unresolvedTemplateKeys: [...nameResult.unresolvedKeys, ...sourcesResult.unresolvedKeys],
        };
      });
    }),
  );

  return resolved.flat();
}
