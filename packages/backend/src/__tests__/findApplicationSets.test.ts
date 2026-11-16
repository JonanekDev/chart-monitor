import { describe, expect, it } from 'vitest';
import { resolveApplicationSets } from '../argocd/findApplicationSets.js';
import { testContext } from './helpers/memoryRepo.js';

const yaml = `
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: mysql
spec:
  source:
    repoURL: https://charts.bitnami.com/bitnami
    chart: mysql
    targetRevision: 9.2.0
---
apiVersion: argoproj.io/v1alpha1
kind: ApplicationSet
metadata:
  name: broken
spec:
  generators:
    - git:
        repoURL: https://github.com/other-org/inaccessible
        revision: HEAD
        directories: [{ path: apps/* }]
    - list:
        elements: [{ name: redis, version: 1.0.0 }]
    - clusters: {}
  template:
    metadata:
      name: '{{ .name }}'
    spec:
      source:
        repoURL: https://charts.example.com
        chart: '{{name}}'
        targetRevision: '{{version}}'
        path: '{{missing}}'
`;

describe('resolveApplicationSets', () => {
  it('includes plain Applications, survives failing generators and reports what was skipped', async () => {
    const { ctx, warnings } = testContext();
    const apps = await resolveApplicationSets([{ path: 'apps.yaml', content: yaml }], ctx);

    expect(apps.map((a) => [a.applicationSetName, a.applicationName, a.sources[0]?.chart])).toEqual(
      [
        ['', 'mysql', 'mysql'],
        ['broken', 'redis', 'redis'],
      ],
    );
    expect([...warnings].sort()).toEqual(
      [
        'ApplicationSet "broken": generator "git" failed, skipped: Could not clone https://github.com/other-org/inaccessible',
        'ApplicationSet "broken": generator "clusters" is not supported (its parameters only exist inside a running ArgoCD), skipped',
        'ApplicationSet "broken": template placeholders could not be resolved: missing (unsupported generator or Go template function); affected sources may be skipped',
      ].sort(),
    );
  });
});
