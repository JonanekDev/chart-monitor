// Leading dot is optional so `goTemplate: true` syntax ({{ .path.basename }}) resolves too
const PLACEHOLDER_PATTERN = /\{\{\s*\.?([\w.-]+)\s*\}\}/g;

export interface SubstitutionResult<T> {
  value: T;
  unresolvedKeys: string[];
}

/** Deep-substitutes `{{ key }}` placeholders in every string field using a flat param record. */
export function substituteTemplate<T>(
  input: T,
  params: Record<string, string>,
): SubstitutionResult<T> {
  const unresolvedKeys = new Set<string>();

  const substitute = (node: unknown): unknown => {
    if (typeof node === 'string') {
      return node.replace(PLACEHOLDER_PATTERN, (match, key: string) => {
        if (key in params) return params[key] as string;
        unresolvedKeys.add(key);
        return match;
      });
    }
    if (Array.isArray(node)) {
      return node.map(substitute);
    }
    if (node !== null && typeof node === 'object') {
      return Object.fromEntries(
        Object.entries(node as Record<string, unknown>).map(([k, v]) => [k, substitute(v)]),
      );
    }
    return node;
  };

  return { value: substitute(input) as T, unresolvedKeys: [...unresolvedKeys] };
}
