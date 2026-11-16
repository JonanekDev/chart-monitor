import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';
import { expandUmbrellaChart } from '../argocd/umbrellaChart.js';
import { testContext } from './helpers/memoryRepo.js';

const files: Record<string, string> = {
  'apps/db/Chart.yaml': `
apiVersion: v2
name: db
version: 1.0.0
dependencies:
  - name: mysql
    version: 9.2.0
    repository: https://charts.bitnami.com/bitnami
  - name: redis
    alias: cache
    version: 1.0.0
    repository: oci://registry-1.docker.io/bitnamicharts
  - name: local
    version: 1.0.0
    repository: file://local
`,
  'apps/db/values.yaml':
    'global: { storageClass: ceph }\nmysql: { image: { tag: "8.0" } }\ncache: { replicas: 1 }\n',
  'apps/db/values-prod.yaml': 'cache: { replicas: 3 }\n',
};
const repoUrl = 'https://github.com/o/r';

describe('expandUmbrellaChart', () => {
  it('turns remote dependencies into charts with their values subtree plus global', async () => {
    const { ctx, warnings } = testContext({ [repoUrl]: files });
    const source = {
      repoURL: repoUrl,
      path: 'apps/db/',
      targetRevision: 'HEAD',
      helm: { valueFiles: ['values-prod.yaml'] },
    };
    const charts = await expandUmbrellaChart(source, [source], ctx);

    expect(charts.map((c) => c.source)).toEqual([
      { repoURL: 'https://charts.bitnami.com/bitnami', chart: 'mysql', targetRevision: '9.2.0' },
      {
        repoURL: 'oci://registry-1.docker.io/bitnamicharts',
        chart: 'redis',
        targetRevision: '1.0.0',
      },
    ]);
    expect(charts[0]!.valuesDocuments.map((d) => parse(d))).toEqual([
      { image: { tag: '8.0' }, global: { storageClass: 'ceph' } },
      {},
    ]);
    expect(charts[1]!.valuesDocuments.map((d) => parse(d))).toEqual([
      { replicas: 1, global: { storageClass: 'ceph' } },
      { replicas: 3 },
    ]);
    expect(warnings).toEqual([
      'umbrella chart apps/db: dependency "local" (repository "file://local") is local or uses a repo alias, not scanned',
    ]);
  });

  it('returns nothing, without warnings, for a plain manifests directory', async () => {
    const { ctx, warnings } = testContext({
      [repoUrl]: { ...files, 'manifests/deploy.yaml': 'kind: Deployment' },
    });
    const source = { repoURL: repoUrl, path: 'manifests', targetRevision: 'main' };
    expect(await expandUmbrellaChart(source, [source], ctx)).toEqual([]);
    expect(warnings).toEqual([]);
  });
});
