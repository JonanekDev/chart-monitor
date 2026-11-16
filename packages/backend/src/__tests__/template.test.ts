import { describe, expect, it } from 'vitest';
import { substituteTemplate } from '../argocd/template.js';

describe('substituteTemplate', () => {
  it('replaces known placeholders across nested objects and arrays', () => {
    const result = substituteTemplate(
      { name: 'app-{{path.basename}}', sources: [{ targetRevision: '{{version}}' }] },
      { 'path.basename': 'foo', version: '1.2.3' },
    );

    expect(result.value).toEqual({
      name: 'app-foo',
      sources: [{ targetRevision: '1.2.3' }],
    });
    expect(result.unresolvedKeys).toEqual([]);
  });

  it('leaves unresolved placeholders untouched and reports them', () => {
    const result = substituteTemplate('{{missing}}', {});
    expect(result.value).toBe('{{missing}}');
    expect(result.unresolvedKeys).toEqual(['missing']);
  });

  it('resolves goTemplate-style placeholders with a leading dot', () => {
    const result = substituteTemplate('app-{{ .path.basename }}', { 'path.basename': 'foo' });
    expect(result.value).toBe('app-foo');
    expect(result.unresolvedKeys).toEqual([]);
  });
});
