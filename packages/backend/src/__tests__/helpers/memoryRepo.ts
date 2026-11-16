import type { ScanContext } from '../../argocd/types.js';
import type { RepoSnapshot } from '../../git/repoSnapshot.js';

export function memoryRepo(files: Record<string, string>): RepoSnapshot {
  const dirs = new Set<string>();
  for (const file of Object.keys(files)) {
    const parts = file.split('/');
    for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join('/'));
  }
  return {
    files: Object.keys(files),
    dirs: [...dirs],
    read: async (path) => {
      if (!(path in files)) throw new Error(`File not found in repo: ${path}`);
      return files[path]!;
    },
  };
}

/** ScanContext over in-memory repos keyed by URL; unknown URLs fail like an inaccessible repo. */
export function testContext(repos: Record<string, Record<string, string>> = {}) {
  const warnings: string[] = [];
  const ctx: ScanContext = {
    openRepo: async (url) => {
      if (!(url in repos)) throw new Error(`Could not clone ${url}`);
      return memoryRepo(repos[url]!);
    },
    warn: (message) => warnings.push(message),
  };
  return { ctx, warnings };
}
