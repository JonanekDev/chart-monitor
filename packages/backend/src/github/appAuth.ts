import { createAppAuth } from '@octokit/auth-app';
import { Octokit } from '@octokit/rest';
import { env } from '../config/env.js';
import { GithubAccessError } from '../errors.js';

const appOctokit = new Octokit({
  authStrategy: createAppAuth,
  auth: {
    appId: env.GITHUB_APP_ID,
    privateKey: env.GITHUB_APP_PRIVATE_KEY,
  },
});

export async function getInstallationOctokit(owner: string, repo: string): Promise<Octokit> {
  const installation = await appOctokit.apps
    .getRepoInstallation({ owner, repo })
    .catch((cause: unknown) => {
      throw new GithubAccessError(
        `GitHub App is not installed on ${owner}/${repo}, or the repo does not exist`,
        cause,
      );
    });

  return new Octokit({
    authStrategy: createAppAuth,
    auth: {
      appId: env.GITHUB_APP_ID,
      privateKey: env.GITHUB_APP_PRIVATE_KEY,
      installationId: installation.data.id,
    },
  });
}

export function parseGithubRepoUrl(repoUrl: string): { owner: string; repo: string } {
  const url = new URL(repoUrl);
  const [owner, repo] = url.pathname.replace(/^\//, '').replace(/\.git$/, '').split('/');
  if (!owner || !repo) {
    throw new GithubAccessError(`Could not parse owner/repo from URL: ${repoUrl}`);
  }
  return { owner, repo };
}
