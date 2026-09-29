import { resolveConfig, type ExpressionScopes } from '@flowforge/shared';

export const OPERATORS = [
  { value: 'equals', label: 'equals' },
  { value: 'notEquals', label: 'not equals' },
  { value: 'contains', label: 'contains' },
  { value: 'notContains', label: 'does not contain' },
  { value: 'gt', label: '>' },
  { value: 'gte', label: '>=' },
  { value: 'lt', label: '<' },
  { value: 'lte', label: '<=' },
  { value: 'exists', label: 'exists' },
  { value: 'notExists', label: 'is empty' },
  { value: 'isTrue', label: 'is true' },
  { value: 'isFalse', label: 'is false' },
] as const;

export type Operator = (typeof OPERATORS)[number]['value'];

function looseEq(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a == null || b == null) return false;
  if (typeof a === 'object' || typeof b === 'object') return JSON.stringify(a) === JSON.stringify(b);
  return String(a) === String(b);
}

export function evaluateCondition(left: unknown, operator: Operator, right: unknown): boolean {
  switch (operator) {
    case 'equals': return looseEq(left, right);
    case 'notEquals': return !looseEq(left, right);
    case 'contains': return left != null && String(left).includes(String(right ?? ''));
    case 'notContains': return !(left != null && String(left).includes(String(right ?? '')));
    case 'gt': return Number(left) > Number(right);
    case 'gte': return Number(left) >= Number(right);
    case 'lt': return Number(left) < Number(right);
    case 'lte': return Number(left) <= Number(right);
    case 'exists': return left !== undefined && left !== null && left !== '';
    case 'notExists': return left === undefined || left === null || left === '';
    case 'isTrue': return left === true || left === 'true' || left === 1;
    case 'isFalse': return left === false || left === 'false' || left === 0 || left == null || left === '';
    default: return false;
  }
}

/** Evaluate a {left, operator, right} condition object with expression resolution. */
export function evalConditionConfig(config: Record<string, unknown>, scopes: ExpressionScopes): boolean {
  const resolved = resolveConfig(config, scopes) as Record<string, unknown>;
  return evaluateCondition(resolved.left, (resolved.operator as Operator) ?? 'equals', resolved.right);
}
