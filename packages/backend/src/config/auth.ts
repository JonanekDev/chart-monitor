import { env } from './env.js';
import {
  matchHelmRepo,
  redact,
  registryHost,
  secretForms,
  type Credentials,
} from './credentials.js';

export const helmRepoCredentials = (repoUrl: string): Credentials | null =>
  matchHelmRepo(repoUrl, env.HELM_REPO_CREDENTIALS);

export const registryCredentials = (host: string): Credentials | null =>
  env.DOCKER_CONFIG?.logins.get(registryHost(host)) ?? null;

const gitLogins = env.GIT_CREDENTIALS.map((entry) => {
  const url = new URL(entry);
  return { username: url.username, password: decodeURIComponent(url.password) };
});
// gitEnv sends GITHUB_TOKEN as basic auth for x-access-token
const githubLogin = env.GITHUB_TOKEN
  ? [{ username: 'x-access-token', password: env.GITHUB_TOKEN }]
  : [];
const SECRETS = secretForms([
  ...env.HELM_REPO_CREDENTIALS,
  ...(env.DOCKER_CONFIG?.logins.values() ?? []),
  ...gitLogins,
  ...githubLogin,
]);

/** Masks configured credentials (and anything credential-shaped) in text that gets stored */
export const redactSecrets = (text: string) => redact(text, SECRETS);
