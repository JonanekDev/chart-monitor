import type { Octokit } from '@octokit/rest';

export interface RepoFile {
  path: string;
  content: string;
}

export interface RepoTreeEntry {
  path: string;
  type: 'blob' | 'tree';
}

// Fetches the full recursive file/directory tree of a repo
export async function getRepoTree(
  octokit: Octokit,
  owner: string,
  repo: string,
  ref: string,
): Promise<RepoTreeEntry[]> {
  const { data: refData } = await octokit.git.getRef({ owner, repo, ref: `heads/${ref}` });
  const { data: tree } = await octokit.git.getTree({
    owner,
    repo,
    tree_sha: refData.object.sha,
    recursive: 'true',
  });

  return tree.tree
    .filter(
      (entry): entry is typeof entry & { path: string; type: 'blob' | 'tree' } =>
        Boolean(entry.path) && (entry.type === 'blob' || entry.type === 'tree'),
    )
    .map((entry) => ({ path: entry.path, type: entry.type }));
}

// Fetches every YAML file under `searchPath` (or the whole repo)
export async function fetchYamlFiles(
  octokit: Octokit,
  owner: string,
  repo: string,
  ref: string,
  searchPath?: string,
): Promise<RepoFile[]> {
  const tree = await getRepoTree(octokit, owner, repo, ref);

  const yamlPaths = tree
    .filter((entry) => entry.type === 'blob' && /\.(ya?ml)$/i.test(entry.path))
    .filter((entry) => !searchPath || entry.path.startsWith(searchPath))
    .map((entry) => entry.path);

  return Promise.all(
    yamlPaths.map(async (path) => ({
      path,
      content: await fetchFileContent(octokit, owner, repo, path, ref),
    })),
  );
}

export async function fetchFileContent(
  octokit: Octokit,
  owner: string,
  repo: string,
  path: string,
  ref: string,
): Promise<string> {
  const { data } = await octokit.repos.getContent({ owner, repo, path, ref });
  if (Array.isArray(data) || data.type !== 'file' || !data.content) {
    throw new Error(`${path} is not a readable file at ref ${ref}`);
  }
  return Buffer.from(data.content, 'base64').toString('utf-8');
}

export async function getDefaultBranch(
  octokit: Octokit,
  owner: string,
  repo: string,
): Promise<string> {
  const { data } = await octokit.repos.get({ owner, repo });
  return data.default_branch;
}
