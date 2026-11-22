import { describe, expect, it } from 'vitest';
import {
  basicAuth,
  matchHelmRepo,
  parseDockerConfig,
  parseHelmRepoCredentials,
  redact,
  secretForms,
} from '../config/credentials.js';

const b64 = (text: string) => Buffer.from(text).toString('base64');

describe('parseDockerConfig', () => {
  it('reads auth and username/password entries, with Docker Hub under its API host', () => {
    const { logins } = parseDockerConfig(
      JSON.stringify({
        auths: {
          'https://index.docker.io/v1/': { auth: b64('hub:p:with:colons') },
          'harbor.example.com:8443': { username: 'robot$ci', password: 'secret' },
        },
      }),
      'config.json',
    );
    expect(logins.get('registry-1.docker.io')).toEqual({
      username: 'hub',
      password: 'p:with:colons',
    });
    expect(logins.get('harbor.example.com:8443')).toEqual({
      username: 'robot$ci',
      password: 'secret',
    });
  });

  it.each(['docker.io', 'index.docker.io', 'https://registry-1.docker.io'])(
    'treats %s as Docker Hub',
    (key) => {
      const { logins } = parseDockerConfig(
        JSON.stringify({ auths: { [key]: { auth: b64('a:b') } } }),
        'c',
      );
      expect([...logins.keys()]).toEqual(['registry-1.docker.io']);
    },
  );

  it.each([
    ['not json', '{', 'not valid JSON'],
    [
      'a credential store',
      JSON.stringify({ credsStore: 'desktop', auths: {} }),
      'credential store',
    ],
    [
      'a bad auth',
      JSON.stringify({ auths: { h: { auth: b64('nocolon') } } }),
      'base64 of user:password',
    ],
  ])('refuses %s, without echoing secrets', (_, json, message) => {
    expect(() => parseDockerConfig(json, 'config.json')).toThrow(message);
  });

  it('only warns about credential helpers and entries without a login, keeping the rest', () => {
    const { logins, warnings } = parseDockerConfig(
      JSON.stringify({
        credHelpers: { '123.dkr.ecr.eu-west-1.amazonaws.com': 'ecr-login' },
        auths: { 'ghcr.io': {}, 'quay.io': { identitytoken: 'x' }, 'h.io': { auth: b64('a:b') } },
      }),
      'config.json',
    );
    expect([...logins.keys()]).toEqual(['h.io']);
    expect(warnings).toEqual([
      expect.stringContaining('123.dkr.ecr.eu-west-1.amazonaws.com uses a credential helper'),
      expect.stringContaining('ghcr.io has no login'),
      expect.stringContaining('quay.io has no login'),
    ]);
  });
});

describe('matchHelmRepo', () => {
  const logins = parseHelmRepoCredentials(
    'https://all:a1@nexus.example.com,https://team:t%40m@nexus.example.com/repository/helm-team/',
  );

  it('picks the longest URL prefix, on path boundaries, on the same host only', () => {
    expect(matchHelmRepo('https://nexus.example.com/repository/helm-team', logins)).toEqual({
      username: 'team',
      password: 't@m',
    });
    expect(
      matchHelmRepo('https://nexus.example.com/repository/helm-team-2/', logins)?.username,
    ).toBe('all');
    expect(matchHelmRepo('https://nexus.example.com.evil.io/x', logins)).toBeNull();
    expect(matchHelmRepo('http://nexus.example.com/x', logins)).toBeNull();
  });
});

describe('redact', () => {
  const login = { username: 'robot', password: 'hunter22' };
  const secrets = secretForms([login]);

  it('masks known secrets, also base64-encoded, and credential-shaped text', () => {
    const text = [
      'failed to fetch https://robot:hunter22@charts.example.com/index.yaml',
      `Authorization: ${basicAuth(login)}`,
      'authorization=Bearer eyJhbGciOi.abc',
      '{"auths":{"h":{"auth": "c29tZTpvdGhlcg=="}}}',
      `token ${b64('robot:hunter22')} and hunter22`,
    ].join('\n');
    const out = redact(text, secrets);

    expect(out).not.toMatch(/hunter22|eyJhbGciOi|c29tZTpvdGhlcg|cm9ib3Q6aHVudGVyMjI/);
    expect(out).toContain('https://***@charts.example.com/index.yaml');
    expect(out).toContain('Authorization: Basic ***');
  });

  it('masks short passwords only in base64 and URLs, not as plain words', () => {
    const short = { username: 'ci', password: 'build' };
    const out = redact(
      `build failed: ${b64('ci:build')} https://ci:build@h.io`,
      secretForms([short]),
    );
    expect(out).toBe('build failed: *** https://***@h.io');
  });
});
