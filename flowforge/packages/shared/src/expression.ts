// Safe template-expression resolver. Supports {{trigger.a.b}}, {{nodes.id.field}},
// {{variables.name}}, {{metadata.x}} with dot/index paths. No eval(), no function calls.

const TOKEN_RE = /\{\{\s*([^{}]+?)\s*\}\}/g;
const MAX_PATH_DEPTH = 24;

function parsePath(path: string): (string | number)[] {
  return path
    .replace(/\[(\d+)\]/g, '.$1')
    .split('.')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .slice(0, MAX_PATH_DEPTH)
    .map((seg) => (/^\d+$/.test(seg) ? Number(seg) : seg));
}

export interface ExpressionScopes {
  trigger?: unknown;
  nodes?: Record<string, unknown>;
  variables?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

export function resolvePath(scopes: ExpressionScopes, path: string): unknown {
  const segments = parsePath(path);
  if (segments.length === 0) return undefined;
  const root = segments[0];
  let current: unknown = scopes[root as keyof ExpressionScopes];
  if (current === undefined) return undefined;
  for (let i = 1; i < segments.length; i++) {
    const seg = segments[i]!;
    if (current == null || typeof current !== 'object') return undefined;
    current = (current as Record<string | number, unknown>)[seg];
  }
  return current;
}

function stringify(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

/** Resolve a whole string of mixed text + expressions. */
export function resolveString(input: string, scopes: ExpressionScopes): string {
  return input.replace(TOKEN_RE, (_match, expr: string) => stringify(resolvePath(scopes, expr)));
}

/** Returns true when the raw value is exactly one expression (so we can preserve types). */
export function isSingleExpression(value: string): boolean {
  const trimmed = value.trim();
  return /^\{\{[^{}]+\}\}$/.test(trimmed);
}

/** Deep-resolve every string inside a config object, preserving non-string types. */
export function resolveConfig<T>(config: T, scopes: ExpressionScopes): T {
  if (typeof config === 'string') {
    if (isSingleExpression(config)) {
      const v = resolvePath(scopes, config.slice(2, -2));
      return (v === undefined ? '' : v) as unknown as T;
    }
    return resolveString(config, scopes) as unknown as T;
  }
  if (Array.isArray(config)) return config.map((item) => resolveConfig(item, scopes)) as unknown as T;
  if (config !== null && typeof config === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(config as Record<string, unknown>)) out[k] = resolveConfig(v, scopes);
    return out as unknown as T;
  }
  return config;
}
