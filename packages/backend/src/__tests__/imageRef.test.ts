import { describe, expect, it } from 'vitest';
import { parseImageRef } from '../registry/imageRef.js';

describe('parseImageRef', () => {
  it('defaults official images to the docker.io library namespace', () => {
    expect(parseImageRef('nginx:1.25.3')).toEqual({
      registryHost: 'registry-1.docker.io',
      repoPath: 'library/nginx',
      tag: '1.25.3',
    });
  });

  it('resolves a namespaced docker hub image without an explicit tag', () => {
    expect(parseImageRef('bitnami/redis')).toEqual({
      registryHost: 'registry-1.docker.io',
      repoPath: 'bitnami/redis',
      tag: 'latest',
    });
  });

  it('resolves a fully-qualified third-party registry image', () => {
    expect(parseImageRef('ghcr.io/org/app:1.0.0')).toEqual({
      registryHost: 'ghcr.io',
      repoPath: 'org/app',
      tag: '1.0.0',
    });
  });

  it('defaults to latest for a bare digest pin with no tag', () => {
    expect(parseImageRef('nginx@sha256:abcd1234')).toEqual({
      registryHost: 'registry-1.docker.io',
      repoPath: 'library/nginx',
      tag: 'latest',
    });
  });

  it('extracts the tag even when a digest is also pinned (tag@digest)', () => {
    expect(
      parseImageRef('quay.io/cilium/cilium:v1.19.5@sha256:20fbbc14ac20b55a292c0dcda5571bf'),
    ).toEqual({
      registryHost: 'quay.io',
      repoPath: 'cilium/cilium',
      tag: 'v1.19.5',
    });
  });
});
