import { describe, expect, it } from 'vitest';
import {
  diffManifests,
  diffVulnerabilities,
  parameterPath,
  removedValueKeys,
} from '../helm/upgradeCheck.js';

describe('removedValueKeys', () => {
  it('checks helm.parameters too', () => {
    const oldDefaults = { image: { tag: '' }, 'a.b': { c: 1 } };
    expect(
      removedValueKeys([], ['image.tag', 'a\\.b.c', 'extra.x'], oldDefaults, { image: {} }),
    ).toEqual(['a\\.b.c', 'image.tag']);
  });

  it('parses --set names: escaped dots, list indexes', () => {
    expect(parameterPath('ingress.hosts[0].host')).toEqual(['ingress', 'hosts', 'host']);
    expect(parameterPath('podAnnotations.prometheus\\.io/scrape')).toEqual([
      'podAnnotations',
      'prometheus.io/scrape',
    ]);
  });

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
    expect(removedValueKeys([values], [], oldDefaults, newDefaults)).toEqual(['ingress.hosts']);
  });

  it('reports the removed parent once when a whole section is gone', () => {
    const values = 'metrics: { serviceMonitor: { enabled: true, interval: 30s } }';
    const oldDefaults = { metrics: { serviceMonitor: { enabled: false, interval: '' } } };
    expect(removedValueKeys([values], [], oldDefaults, {})).toEqual([
      'metrics.serviceMonitor.enabled',
      'metrics.serviceMonitor.interval',
    ]);
  });
});

const statefulSet = (version: string, app = 'db') => ({
  kind: 'StatefulSet',
  metadata: { name: 'db', namespace: 'data', labels: { 'helm.sh/chart': `db-${version}` } },
  spec: { selector: { matchLabels: { app } }, replicas: 1 },
});
const resource = (fields: object) => ({
  fields: [],
  fieldsNotListed: 0,
  immutableFields: [],
  rbacFields: [],
  ...fields,
});

describe('diffManifests', () => {
  it('lists added and removed resources, and skips non-resources', () => {
    expect(
      diffManifests(
        [statefulSet('1'), { kind: 'Service', metadata: { name: 'old' } }, { Digest: 'sha256:1' }],
        [statefulSet('2'), { kind: 'Service', metadata: { name: 'new' } }],
      ),
    ).toEqual([
      resource({ resource: 'Service new', change: 'added' }),
      resource({ resource: 'Service old', change: 'removed' }),
    ]);
  });

  it('flags immutable fields that change', () => {
    expect(diffManifests([statefulSet('1')], [statefulSet('2', 'db2')])).toEqual([
      resource({
        resource: 'StatefulSet data/db',
        change: 'changed',
        fields: [{ path: 'spec.selector.matchLabels.app', before: '"db"', after: '"db2"' }],
        immutableFields: ['spec.selector'],
      }),
    ]);
  });

  const deployment = (version: string, spec: object) => ({
    kind: 'Deployment',
    metadata: {
      name: 'app',
      labels: { chart: `app-${version}`, 'app.kubernetes.io/version': version },
      annotations: { 'checksum/config': version },
    },
    spec: {
      template: {
        spec: {
          containers: [
            { name: 'app', image: `ghcr.io/o/app:v${version}@sha256:${'a'.repeat(64)}`, ...spec },
          ],
        },
      },
    },
  });

  it('leaves out version bumps, chart labels, checksums and Secret values', () => {
    const secret = (password: string) => ({
      kind: 'Secret',
      metadata: { name: 's' },
      data: { password },
    });
    expect(
      diffManifests(
        [deployment('1.2.3', { args: ['--a'] }), secret('YQ==')],
        [deployment('1.3.0', { args: ['--a'] }), secret('Yg==')],
      ),
    ).toEqual([]);
  });

  it('diffs fields like dyff: lists by name, args as a set, IPs as values', () => {
    const [change] = diffManifests(
      [deployment('1.0.0', { args: ['--b', '--ip=10.0.0.1'], env: [{ name: 'B', value: '1' }] })],
      [
        deployment('2.0.0', {
          args: ['--a', '--b', '--ip=10.0.0.2'],
          env: [
            { name: 'A', value: '0' },
            { name: 'B', value: '2' },
          ],
          resources: { limits: { memory: '256Mi' } },
        }),
      ],
    );
    const at = 'spec.template.spec.containers[app]';
    expect(change).toEqual(
      resource({
        resource: 'Deployment app',
        change: 'changed',
        fields: [
          { path: `${at}.args[]`, before: '"--ip=10.0.0.1"', after: null },
          { path: `${at}.args[]`, before: null, after: '"--a"' },
          { path: `${at}.args[]`, before: null, after: '"--ip=10.0.0.2"' },
          { path: `${at}.env[B].value`, before: '"1"', after: '"2"' },
          { path: `${at}.env[A]`, before: null, after: '{"name":"A","value":"0"}' },
          { path: `${at}.resources`, before: null, after: '{"limits":{"memory":"256Mi"}}' },
        ],
      }),
    );
  });

  it('only counts CRD fields, and caps the rest', () => {
    const crd = (n: number) => ({
      kind: 'CustomResourceDefinition',
      metadata: { name: 'x.example.com' },
      spec: { props: Object.fromEntries(Array.from({ length: n }, (_, i) => [`p${i}`, i])) },
    });
    const many = (n: number) => ({
      kind: 'ConfigMap',
      metadata: { name: 'big' },
      data: Object.fromEntries(Array.from({ length: n }, (_, i) => [`k${i}`, String(i)])),
    });
    const [big, schema] = diffManifests([crd(0), many(0)], [crd(3), many(60)]);
    expect(schema).toMatchObject({ fields: [], fieldsNotListed: 3 });
    expect(big!.fields).toHaveLength(50);
    expect(big!.fieldsNotListed).toBe(10);
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
      expect.objectContaining({ resource: 'ClusterRole operator', rbacFields: ['rules'] }),
      expect.objectContaining({
        resource: 'ClusterRoleBinding operator',
        rbacFields: ['subjects'],
      }),
    ]);
  });

  it('flags an added Role or Binding, not a removed one', () => {
    expect(diffManifests([role(['get'], '1')], [binding('ci')])).toEqual([
      resource({ resource: 'ClusterRole operator', change: 'removed' }),
      resource({
        resource: 'ClusterRoleBinding operator',
        change: 'added',
        rbacFields: ['subjects', 'roleRef'],
      }),
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
