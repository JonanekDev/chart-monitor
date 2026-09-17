import { minimatch } from 'minimatch';
import { parse } from 'yaml';
import type { Octokit } from '@octokit/rest';
import { fetchFileContent, getDefaultBranch, getRepoTree } from '../github/repoClient.js';
import type { ApplicationSetGenerator } from './types.js';

export type ResolveOctokit = (owner: string, repo: string) => Promise<Octokit>;

function parseOwnerRepo(repoUrl: string): { owner: string; repo: string } {
  const { pathname } = new URL(repoUrl);
  const [owner, repo] = pathname.replace(/^\//, '').replace(/\.git$/, '').split('/');
  return { owner: owner ?? '', repo: repo ?? '' };
}

// Flattens an arbitrary parsed-YAML object into string params
function toStringParams(obj: Record<string, unknown>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(obj)
      .filter(([, value]) => value !== null && typeof value !== 'object')
      .map(([key, value]) => [key, String(value)]),
  );
}

async function resolveRevision(
  octokit: Octokit,
  owner: string,
  repo: string,
  revision: string | undefined,
): Promise<string> {
  return !revision || revision === 'HEAD' ? getDefaultBranch(octokit, owner, repo) : revision;
}

async function expandGitDirectoryGenerator(
  generator: NonNullable<ApplicationSetGenerator['git']>,
  resolveOctokit: ResolveOctokit,
): Promise<Record<string, string>[]> {
  const { owner, repo } = parseOwnerRepo(generator.repoURL);
  if (!owner || !repo || !generator.directories?.length) return [];

  const octokit = await resolveOctokit(owner, repo);
  const revision = await resolveRevision(octokit, owner, repo, generator.revision);
  const tree = await getRepoTree(octokit, owner, repo, revision);

  const directoryPaths = tree.filter((entry) => entry.type === 'tree').map((entry) => entry.path);

  const includePatterns = generator.directories.filter((d) => !d.exclude).map((d) => d.path);
  const excludePatterns = generator.directories.filter((d) => d.exclude).map((d) => d.path);

  const matched = directoryPaths.filter(
    (path) =>
      includePatterns.some((pattern) => minimatch(path, pattern)) &&
      !excludePatterns.some((pattern) => minimatch(path, pattern)),
  );

  return matched.map((path) => ({
    path,
    'path.basename': path.split('/').pop() ?? path,
  }));
}

/** Expands a `git.files` generator: each matched file is parsed as YAML and must contain either a
 * list of param objects, or a single param object. */
async function expandGitFilesGenerator(
  generator: NonNullable<ApplicationSetGenerator['git']>,
  resolveOctokit: ResolveOctokit,
): Promise<Record<string, string>[]> {
  const { owner, repo } = parseOwnerRepo(generator.repoURL);
  if (!owner || !repo || !generator.files?.length) return [];

  const octokit = await resolveOctokit(owner, repo);
  const revision = await resolveRevision(octokit, owner, repo, generator.revision);
  const tree = await getRepoTree(octokit, owner, repo, revision);

  const filePaths = tree
    .filter((entry) => entry.type === 'blob')
    .map((entry) => entry.path)
    .filter((path) => generator.files!.some((f) => minimatch(path, f.path)));

  const paramSets = await Promise.all(
    filePaths.map(async (path) => {
      const content = await fetchFileContent(octokit, owner, repo, path, revision);
      const parsed: unknown = parse(content);
      const items = Array.isArray(parsed) ? parsed : [parsed];
      return items
        .filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null)
        .map(toStringParams);
    }),
  );

  return paramSets.flat();
}

/** Expands supported ApplicationSet generators into flat template-param sets. Unsupported generator
 * kinds (cluster, SCM provider, pull request, plugin, matrix) are silently skipped. */
export async function expandGenerators(
  generators: ApplicationSetGenerator[],
  resolveOctokit: ResolveOctokit,
): Promise<Record<string, string>[]> {
  const results = await Promise.all(
    generators.map(async (generator) => {
      if (generator.list) {
        return generator.list.elements ?? [];
      }
      if (generator.git?.files) {
        return expandGitFilesGenerator(generator.git, resolveOctokit);
      }
      if (generator.git?.directories) {
        return expandGitDirectoryGenerator(generator.git, resolveOctokit);
      }
      return [];
    }),
  );
  return results.flat();
}
