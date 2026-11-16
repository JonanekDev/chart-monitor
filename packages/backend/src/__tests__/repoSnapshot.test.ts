import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { gitEnv, parseGitCredentials, snapshotFromDir, toCloneUrl } from '../git/repoSnapshot.js';

describe('toCloneUrl', () => {
  it.each([
    ['git@github.com:o/r.git', 'https://github.com/o/r.git'],
    ['ssh://git@gitlab.example.com/group/r.git', 'https://gitlab.example.com/group/r.git'],
    ['https://user:secret@github.com/o/r', 'https://github.com/o/r'],
    ['https://codeberg.org/o/r', 'https://codeberg.org/o/r'],
  ])('%s -> %s', (input, expected) => {
    expect(toCloneUrl(input)).toBe(expected);
  });

  it.each(['file:///etc', 'ext::sh -c id', '/local/path', '-upload-pack=x'])(
    'rejects %s',
    (input) => {
      expect(() => toCloneUrl(input)).toThrow();
    },
  );
});

describe('snapshotFromDir', () => {
  const dirs: string[] = [];
  afterAll(() => Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true }))));

  it('lists files and dirs, skips .git, and refuses reads that escape the checkout', async () => {
    const outside = await mkdtemp(path.join(tmpdir(), 'outside-'));
    const repo = await mkdtemp(path.join(tmpdir(), 'repo-'));
    dirs.push(outside, repo);
    await writeFile(path.join(outside, 'secret'), 'nope');
    await mkdir(path.join(repo, 'apps/a'), { recursive: true });
    await mkdir(path.join(repo, '.git'));
    await writeFile(path.join(repo, '.git/config'), 'x');
    await writeFile(path.join(repo, 'apps/a/values.yaml'), 'a: 1');
    await symlink(path.join(outside, 'secret'), path.join(repo, 'apps/link.yaml'));

    const snap = await snapshotFromDir(repo);
    expect(snap.files).toEqual(['apps/a/values.yaml']);
    expect(snap.dirs.sort()).toEqual(['apps', 'apps/a']);
    expect(await snap.read('apps/a/values.yaml')).toBe('a: 1');
    await expect(snap.read('apps/link.yaml')).rejects.toThrow('File not found');
    await expect(snap.read('../' + path.basename(outside) + '/secret')).rejects.toThrow(
      'File not found',
    );
    await expect(snap.read(path.join(outside, 'secret'))).rejects.toThrow('File not found');
  });
});

describe('gitEnv', () => {
  const headerFor = (url: string, token?: string) =>
    promisify(execFile)('git', ['config', '--get-urlmatch', 'http.extraheader', url], {
      env: gitEnv({ githubToken: token }),
    }).then(
      (r) => r.stdout.trim(),
      () => null,
    );

  it('sends the token to github.com only', async () => {
    const expected = `AUTHORIZATION: basic ${Buffer.from('x-access-token:tkn').toString('base64')}`;
    expect(await headerFor('https://github.com/o/r', 'tkn')).toBe(expected);
    expect(await headerFor('https://gitlab.com/o/r', 'tkn')).toBeNull();
    expect(await headerFor('https://github.com.evil.example/o/r', 'tkn')).toBeNull();
    expect(await headerFor('https://github.com/o/r')).toBeNull();
  });
});

describe('parseGitCredentials', () => {
  it('accepts newline, comma or space separated entries and normalizes them', () => {
    expect(
      parseGitCredentials(
        'https://oauth2:glpat-1@gitlab.com\n https://me:t2@gitea.local:3000/ignored/path,http://u:p@h',
      ),
    ).toEqual([
      'https://oauth2:glpat-1@gitlab.com',
      'https://me:t2@gitea.local:3000',
      'http://u:p@h',
    ]);
    expect(parseGitCredentials(undefined)).toEqual([]);
    expect(parseGitCredentials('  ')).toEqual([]);
  });

  it.each(['gitlab.com', 'https://gitlab.com', 'https://onlyuser@gitlab.com', 'ssh://git:pw@host'])(
    'rejects %s without echoing it',
    (entry) => {
      expect(() => parseGitCredentials(`https://ok:ok@a.b,${entry}`)).toThrow(
        'GIT_CREDENTIALS entry #2 is invalid',
      );
    },
  );
});

describe('gitEnv with a credentials file', () => {
  const dirs: string[] = [];
  afterAll(() => Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true }))));

  // `git credential fill` is exactly what git runs before an authenticated HTTPS request
  const fill = (credentialsFile: string, host: string) => {
    const child = execFile('git', ['credential', 'fill'], { env: gitEnv({ credentialsFile }) });
    child.stdin!.end(`protocol=https\nhost=${host}\n\n`);
    return new Promise<string | null>((resolve) => {
      let out = '';
      child.stdout!.on('data', (d) => (out += d));
      child.on('close', (code) => resolve(code === 0 ? out : null));
    });
  };

  it('hands each token only to its own host', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'cred-'));
    dirs.push(dir);
    const file = path.join(dir, 'credentials');
    await writeFile(
      file,
      'https://oauth2:glpat-1@gitlab.example.com\nhttps://me:t2@gitea.local:3000\n',
    );

    expect(await fill(file, 'gitlab.example.com')).toContain('password=glpat-1');
    expect(await fill(file, 'gitea.local:3000')).toContain('password=t2');
    expect(await fill(file, 'github.com')).toBeNull();
    expect(await fill(file, 'gitlab.example.com.evil.io')).toBeNull();
  });
});
