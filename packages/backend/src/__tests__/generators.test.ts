import { describe, expect, it } from 'vitest';
import { expandGenerators, flattenParams } from '../argocd/generators.js';
import { testContext } from './helpers/memoryRepo.js';

describe('flattenParams', () => {
  it('joins nested keys with dots, keeping types and lists, skipping nulls', () => {
    expect(flattenParams({ a: 1, b: { c: true, d: { e: 'x' } }, f: [1], g: null })).toEqual({
      a: 1,
      'b.c': true,
      'b.d.e': 'x',
      f: [1],
    });
  });
});

describe('expandGenerators', () => {
  it('adds generator values as values.* params, templated with the generator params', async () => {
    const result = await expandGenerators(
      [
        {
          list: {
            elements: [{ name: 'a', nested: { x: '1' } }],
            values: { infraRepo: 'git@github.com:o/r.git', release: '{{name}}-rel' },
          },
        },
      ],
      testContext().ctx,
    );
    expect(result).toEqual([
      {
        name: 'a',
        'nested.x': '1',
        'values.infraRepo': 'git@github.com:o/r.git',
        'values.release': 'a-rel',
      },
    ]);
  });

  it('matrix: combines both children, letting the second reference params of the first', async () => {
    const { ctx } = testContext({
      'https://github.com/o/r': {
        'apps/a/config.yaml': 'version: 1.0.0',
        'apps/b/config.yaml': 'version: 2.0.0',
      },
    });
    const git = { repoURL: 'https://github.com/o/r', revision: 'HEAD' };

    const result = await expandGenerators(
      [
        {
          matrix: {
            generators: [
              { git: { ...git, directories: [{ path: 'apps/*' }] } },
              { git: { ...git, files: [{ path: '{{path}}/config.yaml' }] } },
            ],
          },
        },
      ],
      ctx,
    );
    expect(result.map((r) => [r['path.basename'], r.version])).toEqual([
      ['a', '1.0.0'],
      ['b', '2.0.0'],
    ]);
  });

  it('git files: adds where each file is, like ArgoCD (path, path.path, basename, filename)', async () => {
    const { ctx } = testContext({
      'https://github.com/o/r': {
        'clusters/a/apps/vpa/config.yml': 'appName: vpa',
        'top.yml': 'appName: top',
      },
    });
    const result = await expandGenerators(
      [
        {
          git: {
            repoURL: 'https://github.com/o/r',
            revision: 'HEAD',
            files: [{ path: '**/*.yml' }],
          },
        },
      ],
      ctx,
    );
    expect(result).toEqual(
      expect.arrayContaining([
        {
          appName: 'vpa',
          path: 'clusters/a/apps/vpa',
          'path.path': 'clusters/a/apps/vpa',
          'path.basename': 'vpa',
          'path.filename': 'config.yml',
        },
        {
          appName: 'top',
          path: '',
          'path.path': '',
          'path.basename': '',
          'path.filename': 'top.yml',
        },
      ]),
    );
  });

  it('merge: overrides base rows matching on mergeKeys and drops unmatched overrides', async () => {
    const result = await expandGenerators(
      [
        {
          merge: {
            mergeKeys: ['name'],
            generators: [
              {
                list: {
                  elements: [
                    { name: 'a', version: '1' },
                    { name: 'b', version: '1' },
                  ],
                },
              },
              {
                list: {
                  elements: [
                    { name: 'b', version: '2' },
                    { name: 'zzz', version: '9' },
                  ],
                },
              },
            ],
          },
        },
      ],
      testContext().ctx,
    );
    expect(result).toEqual([
      { name: 'a', version: '1' },
      { name: 'b', version: '2' },
    ]);
  });

  it('warns about generators that need a live cluster', async () => {
    const { ctx, warnings } = testContext();
    expect(await expandGenerators([{ scmProvider: {} } as never], ctx)).toEqual([]);
    expect(warnings).toEqual([
      'generator "scmProvider" is not supported (its parameters only exist inside a running ArgoCD), skipped',
    ]);
  });
});
