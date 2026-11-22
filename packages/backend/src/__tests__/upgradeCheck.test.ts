import { describe, expect, it } from 'vitest';
import { diffManifests, diffVulnerabilities, removedValueKeys } from '../helm/upgradeCheck.js';

describe('removedValueKeys', () => {
  it('reports keys the old defaults had and the new ones lack', () => {
    const oldDefaults = { ingress: { hosts: [], enabled: false }, podAnnotations: {} };
    const newDefaults = { ingress: { rules: [], enabled: false }, podAnnotations: {} };
    const values = `
ingress:
  enabled: true
  hosts: [a.example.com]
podAnnotations: { team: core }
notInDefaults: { anything: 1 }
`;
    expect(removedValueKeys([values], oldDefaults, newDefaults)).toEqual(['ingress.hosts']);
  });

  it('reports the removed parent once when a whole section is gone', () => {
    const values = 'metrics: { serviceMonitor: { enabled: true, interval: 30s } }';
    const oldDefaults = { metrics: { serviceMonitor: { enabled: false, interval: '' } } };
    expect(removedValueKeys([values], oldDefaults, {})).toEqual([
      'metrics.serviceMonitor.enabled',
      'metrics.serviceMonitor.interval',
    ]);
  });
});

const statefulSet = (version: string, app = 'db') => ({
  kind: 'StatefulSet',
  metadata: { name: 'db', namespace: 'data', labels: { 'helm.sh/chart': `db-${version}` } },
  spec: { selector: { matchLabels: { app } }, replicas: version === '1' ? 1 : 3 },
});

describe('diffManifests', () => {
  it('lists added and removed resources, not ordinary changes', () => {
    expect(
      diffManifests(
        [statefulSet('1'), { kind: 'Service', metadata: { name: 'old' } }, { Digest: 'sha256:1' }],
        [statefulSet('2'), { kind: 'Service', metadata: { name: 'new' } }],
      ),
    ).toEqual([
      { resource: 'Service new', change: 'added', immutableFields: [], rbacFields: [] },
      { resource: 'Service old', change: 'removed', immutableFields: [], rbacFields: [] },
    ]);
  });

  it('flags immutable fields that change', () => {
    expect(diffManifests([statefulSet('1')], [statefulSet('2', 'db2')])).toEqual([
      {
        resource: 'StatefulSet data/db',
        change: 'changed',
        immutableFields: ['spec.selector'],
        rbacFields: [],
      },
    ]);
  });
});

describe('diffManifests RBAC', () => {
  const role = (verbs: string[], version: string, resources = ['pods', 'secrets']) => ({
    kind: 'ClusterRole',
    metadata: { name: 'operator', labels: { 'helm.sh/chart': `operator-${version}` } },
    rules: [
      { apiGroups: [''], resources, verbs },
      { apiGroups: ['apps'], resources: ['deployments'], verbs: ['get'] },
    ],
  });
  const binding = (subject: string) => ({
    kind: 'ClusterRoleBinding',
    metadata: { name: 'operator' },
    roleRef: { kind: 'ClusterRole', name: 'operator' },
    subjects: [{ kind: 'ServiceAccount', name: subject, namespace: 'ops' }],
  });

  it('flags changed rules and subjects, not reordering or labels', () => {
    const before = [role(['get', 'list'], '1'), binding('operator')];
    // Same permissions: verbs, resources and the rules themselves in another order, new chart label
    const reordered = role(['list', 'get'], '2', ['secrets', 'pods']);
    reordered.rules.reverse();
    expect(diffManifests(before, [reordered, binding('operator')])).toEqual([]);

    expect(diffManifests(before, [role(['get', 'list', 'delete'], '2'), binding('ci')])).toEqual([
      {
        resource: 'ClusterRole operator',
        change: 'changed',
        immutableFields: [],
        rbacFields: ['rules'],
      },
      {
        resource: 'ClusterRoleBinding operator',
        change: 'changed',
        immutableFields: [],
        rbacFields: ['subjects'],
      },
    ]);
  });

  it('flags an added Role or Binding, not a removed one', () => {
    expect(diffManifests([role(['get'], '1')], [binding('ci')])).toEqual([
      { resource: 'ClusterRole operator', change: 'removed', immutableFields: [], rbacFields: [] },
      {
        resource: 'ClusterRoleBinding operator',
        change: 'added',
        immutableFields: [],
        rbacFields: ['subjects', 'roleRef'],
      },
    ]);
  });
});

describe('diffVulnerabilities', () => {
  const cve = (id: string, severity: 'LOW' | 'HIGH' | 'CRITICAL', image = 'operator') => ({
    vulnerabilityId: id,
    pkgName: 'openssl',
    severity,
    image,
    title: null,
  });

  it('compares by CVE and package across images, most severe first', () => {
    const result = diffVulnerabilities(
      [cve('CVE-1', 'LOW'), cve('CVE-2', 'CRITICAL'), cve('CVE-3', 'HIGH')],
      // CVE-3 is still there, just in a renamed image
      [cve('CVE-3', 'HIGH', 'operator-generic'), cve('CVE-4', 'HIGH', 'operator-generic')],
    );
    expect(result.fixed.map((v) => v.vulnerabilityId)).toEqual(['CVE-2', 'CVE-1']);
    expect(result.introduced.map((v) => v.vulnerabilityId)).toEqual(['CVE-4']);
  });
});
