export interface HelmParameter {
  name: string;
  value: string;
}

export interface ApplicationSource {
  repoURL: string;
  chart?: string;
  targetRevision?: string;
  path?: string;
  helm?: {
    parameters?: HelmParameter[];
    values?: string;
  };
}

export interface GitDirectoryGenerator {
  path: string;
  exclude?: boolean;
}

export interface GitFileGenerator {
  path: string;
}

export interface ApplicationSetGenerator {
  list?: {
    elements?: Record<string, string>[];
  };
  git?: {
    repoURL: string;
    revision: string;
    directories?: GitDirectoryGenerator[];
    files?: GitFileGenerator[];
  };
}

export interface ApplicationSetManifest {
  apiVersion: string;
  kind: 'ApplicationSet';
  metadata: { name: string };
  spec: {
    generators?: ApplicationSetGenerator[];
    template: {
      metadata?: { name?: string };
      spec?: {
        source?: ApplicationSource;
        sources?: ApplicationSource[];
      };
    };
  };
}

export function isApplicationSetManifest(doc: unknown): doc is ApplicationSetManifest {
  return (
    typeof doc === 'object' &&
    doc !== null &&
    (doc as Record<string, unknown>).kind === 'ApplicationSet' &&
    typeof (doc as Record<string, unknown>).spec === 'object'
  );
}

export interface ResolvedApplication {
  applicationSetName: string;
  applicationName: string;
  sources: ApplicationSource[];
  unresolvedTemplateKeys: string[];
}
