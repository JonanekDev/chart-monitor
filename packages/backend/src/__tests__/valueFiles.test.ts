import { describe, expect, it } from 'vitest';
import { collectValuesDocuments } from '../argocd/valueFiles.js';
import type { ApplicationSource } from '../argocd/types.js';
import { testContext } from './helpers/memoryRepo.js';

describe('collectValuesDocuments', () => {
  const infra: ApplicationSource = {
    repoURL: 'git@github.com:o/r.git',
    targetRevision: 'HEAD',
    ref: 'infra',
  };
  const chart = (helm: ApplicationSource['helm']): ApplicationSource => ({
    repoURL: 'https://helm.cilium.io/',
    chart: 'cilium',
    targetRevision: '1.0.0',
    helm,
  });
  const repos = { 'git@github.com:o/r.git': { 'apps/cilium/values.yaml': 'from: file\n' } };

  it('resolves $ref value files from a sibling source, then values, then valuesObject', async () => {
    const { ctx, warnings } = testContext(repos);
    const source = chart({
      valueFiles: [
        '$infra/apps/cilium/values.yaml',
        '$infra/missing.yaml',
        'chart-relative.yaml',
        '$nope/x.yaml',
      ],
      values: 'from: values\n',
      valuesObject: { from: 'object' },
    });

    const docs = await collectValuesDocuments(source, [source, infra], ctx);
    expect(docs).toEqual(['from: file\n', 'from: values\n', 'from: object\n']);
    expect([...warnings].sort()).toEqual(
      [
        'value file "$infra/missing.yaml" could not be read, skipped: File not found in repo: missing.yaml',
        'value file "chart-relative.yaml" is relative to the chart, not supported, skipped',
        'value file "$nope/x.yaml": no source with ref "nope", skipped',
      ].sort(),
    );
  });

  it('stays quiet about missing files when ignoreMissingValueFiles is set', async () => {
    const { ctx, warnings } = testContext(repos);
    const source = chart({ valueFiles: ['$infra/missing.yaml'], ignoreMissingValueFiles: true });
    expect(await collectValuesDocuments(source, [source, infra], ctx)).toEqual([]);
    expect(warnings).toEqual([]);
  });
});
