import { describe, expect, it } from 'vitest';
import { applyPatch, nestParams, renderTemplatePatches } from '../argocd/templatePatch.js';
import { resolveApplicationSets } from '../argocd/findApplicationSets.js';
import { testContext } from './helpers/memoryRepo.js';

describe('nestParams', () => {
  it('nests dotted keys, a nested key winning over a plain one of the same name', () => {
    expect(
      nestParams({ path: 'a/b', 'path.path': 'a/b', 'path.basename': 'b', tags: ['x'] }),
    ).toEqual({ path: { path: 'a/b', basename: 'b' }, tags: ['x'] });
  });
});

describe('applyPatch', () => {
  it('merges maps, replaces lists, and removes keys set to null', () => {
    expect(
      applyPatch(
        { spec: { source: { path: 'x' }, list: [1, 2], keep: true } },
        { spec: { source: null, sources: [{ chart: 'c' }], list: [3] } },
      ),
    ).toEqual({ spec: { sources: [{ chart: 'c' }], list: [3], keep: true } });
  });
});

// Like kyleseneker/homelab: the chart comes in only through the patch
const PATCH = `spec:
  {{- if eq .sourceType "helm" }}
  source:
  sources:
    - repoURL: {{ .chartRepo | quote }}
      chart: {{ .chartName | quote }}
      targetRevision: {{ .chartVersion | quote }}
      helm:
        valueFiles:
          - "$values/{{ .path.path }}/values.yml"
    - repoURL: https://github.com/o/gitops.git
      ref: values
    {{- if .hasResources }}
    - repoURL: https://github.com/o/gitops.git
      path: {{ .path.path | quote }}
    {{- end }}
  {{- else }}
  source:
    repoURL: https://github.com/o/gitops.git
    path: {{ .gitPath | quote }}
  {{- end }}
`;

describe('renderTemplatePatches', () => {
  it('renders Go templates with Sprig functions, typed params and lists', async () => {
    const [helm, git] = await renderTemplatePatches(PATCH, [
      {
        sourceType: 'helm',
        chartRepo: 'https://charts.example.com',
        chartName: 'vpa',
        chartVersion: '0.11.0',
        hasResources: false,
        'path.path': 'apps/vpa',
      },
      { sourceType: 'git', gitPath: 'apps/backup' },
    ]);
    expect(helm).toEqual({
      spec: {
        source: null,
        sources: [
          {
            repoURL: 'https://charts.example.com',
            chart: 'vpa',
            targetRevision: '0.11.0',
            helm: { valueFiles: ['$values/apps/vpa/values.yml'] },
          },
          { repoURL: 'https://github.com/o/gitops.git', ref: 'values' },
        ],
      },
    });
    expect(git).toEqual({
      spec: { source: { repoURL: 'https://github.com/o/gitops.git', path: 'apps/backup' } },
    });
  });

  it('reports a template error', async () => {
    await expect(renderTemplatePatches('{{ .x | nosuchfunction }}', [{}])).rejects.toThrow(
      /nosuchfunction/,
    );
  });
});

describe('resolveApplicationSets with a templatePatch', () => {
  const appSet = (patch: string, goTemplate = true) => `
apiVersion: argoproj.io/v1alpha1
kind: ApplicationSet
metadata: { name: cluster-apps }
spec:
  goTemplate: ${goTemplate}
  generators:
    - git:
        repoURL: https://github.com/o/gitops.git
        revision: HEAD
        files: [{ path: 'apps/**/config.yml' }]
  template:
    metadata: { name: '{{ .appName }}' }
    spec:
      source: { repoURL: https://github.com/o/gitops.git, targetRevision: HEAD }
  templatePatch: |
${patch.replace(/^/gm, '    ')}
`;
  const repos = {
    'https://github.com/o/gitops.git': {
      'apps/vpa/config.yml':
        'appName: vpa\nsourceType: helm\nchartRepo: https://charts.example.com\nchartName: vpa\nchartVersion: 0.11.0\nhasResources: false',
      'apps/backup/config.yml': 'appName: backup\nsourceType: git\ngitPath: apps/backup',
    },
  };

  it('takes the chart from the patch, which replaces the template source', async () => {
    const { ctx, warnings } = testContext(repos);
    const apps = await resolveApplicationSets(
      [{ path: 'appset.yml', content: appSet(PATCH) }],
      ctx,
    );
    expect(warnings).toEqual([]);
    const vpa = apps.find((a) => a.applicationName === 'vpa')!;
    expect(vpa.sources.map((s) => s.chart ?? s.ref)).toEqual(['vpa', 'values']);
    expect(apps.find((a) => a.applicationName === 'backup')!.sources).toEqual([
      // Maps merge: the template's targetRevision stays
      { repoURL: 'https://github.com/o/gitops.git', targetRevision: 'HEAD', path: 'apps/backup' },
    ]);
  });

  it('warns instead of silently ignoring a patch it cannot use', async () => {
    const { ctx, warnings } = testContext(repos);
    await resolveApplicationSets([{ path: 'a.yml', content: appSet(PATCH, false) }], ctx);
    await resolveApplicationSets([{ path: 'b.yml', content: appSet('{{ .x | nope }}') }], ctx);
    expect(warnings).toEqual([
      expect.stringContaining('templatePatch only works with goTemplate'),
      expect.stringContaining('templatePatch could not be rendered'),
    ]);
  });
});
