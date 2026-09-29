import type { WorkflowDefinition, WorkflowNodeData } from '@flowforge/shared';
import { getNodeType } from './node-registry.js';

export interface ValidationIssue {
  code: string;
  message: string;
  nodeId?: string;
  severity: 'error' | 'warning';
}

export interface ValidationResult {
  valid: boolean;                 // no errors
  issues: ValidationIssue[];
}

/** Full workflow validation used before publish/test. Pure + engine-level. */
export function validateWorkflow(definition: WorkflowDefinition, options: { configuredIntegrations?: string[] } = {}): ValidationResult {
  const issues: ValidationIssue[] = [];
  const { nodes, connections } = definition;
  const nodeById = new Map<string, WorkflowNodeData>();

  if (nodes.length === 0) {
    issues.push({ code: 'EMPTY_WORKFLOW', message: 'The workflow has no nodes.', severity: 'error' });
    return { valid: false, issues };
  }

  for (const node of nodes) {
    if (nodeById.has(node.id)) issues.push({ code: 'DUPLICATE_NODE_ID', message: `Duplicate node id "${node.id}".`, nodeId: node.id, severity: 'error' });
    nodeById.set(node.id, node);
  }

  // At least one trigger
  const triggers = nodes.filter((nd) => getNodeType(nd.type)?.category === 'trigger');
  if (triggers.length === 0) issues.push({ code: 'NO_TRIGGER', message: 'Add at least one trigger node to start your automation.', severity: 'error' });
  if (triggers.length > 1) issues.push({ code: 'MULTIPLE_TRIGGERS', message: 'Multiple triggers found — the first one will be used as the entry point.', severity: 'warning' });

  const configuredIntegrations = options.configuredIntegrations ?? [];

  for (const node of nodes) {
    const def = getNodeType(node.type);
    if (!def) {
      issues.push({ code: 'UNKNOWN_NODE_TYPE', message: `Unknown node type "${node.type}" (${node.name}).`, nodeId: node.id, severity: 'error' });
      continue;
    }
    for (const field of def.fields) {
      if (!field.required) continue;
      const v = node.configuration[field.key];
      if (v === undefined || v === null || v === '' || (typeof v === 'string' && v.trim() === '')) {
        issues.push({ code: 'MISSING_REQUIRED_FIELD', message: `"${node.name}" is missing required configuration: ${field.label}.`, nodeId: node.id, severity: 'error' });
      }
    }
    if (def.requiresIntegration && !configuredIntegrations.includes(def.requiresIntegration)) {
      issues.push({ code: 'INTEGRATION_NOT_CONFIGURED', message: `"${node.name}" requires the "${def.requiresIntegration}" integration to be connected.`, nodeId: node.id, severity: 'warning' });
    }
  }

  // Connection integrity
  for (const conn of connections) {
    const src = nodeById.get(conn.sourceNodeId);
    const tgt = nodeById.get(conn.targetNodeId);
    if (!src) issues.push({ code: 'INVALID_CONNECTION', message: `Connection references missing source node "${conn.sourceNodeId}".`, severity: 'error' });
    if (!tgt) issues.push({ code: 'INVALID_CONNECTION', message: `Connection references missing target node "${conn.targetNodeId}".`, severity: 'error' });
    if (src && tgt) {
      if (getNodeType(tgt.type)?.category === 'trigger') {
        issues.push({ code: 'CONNECTION_TO_TRIGGER', message: `A connection targets trigger "${tgt.name}" which cannot receive input.`, nodeId: tgt.id, severity: 'error' });
      }
      const srcDef = getNodeType(src.type);
      if (srcDef && !srcDef.outputs.some((o) => o.id === conn.sourceHandle)) {
        issues.push({ code: 'INVALID_SOURCE_HANDLE', message: `"${src.name}" has no output handle "${conn.sourceHandle}".`, nodeId: src.id, severity: 'error' });
      }
    }
  }

  // Cycle detection (DFS on directed graph)
  const adjacency = new Map<string, string[]>();
  for (const conn of connections) {
    const list = adjacency.get(conn.sourceNodeId) ?? [];
    list.push(conn.targetNodeId);
    adjacency.set(conn.sourceNodeId, list);
  }
  const state = new Map<string, number>(); // 0 unvisited 1 visiting 2 done
  const cycleNodes = new Set<string>();
  const dfs = (id: string): boolean => {
    state.set(id, 1);
    for (const next of adjacency.get(id) ?? []) {
      const s = state.get(next) ?? 0;
      if (s === 1) { cycleNodes.add(id); cycleNodes.add(next); return true; }
      if (s === 0 && dfs(next)) { cycleNodes.add(id); return true; }
    }
    state.set(id, 2);
    return false;
  };
  for (const node of nodes) if ((state.get(node.id) ?? 0) === 0) dfs(node.id);
  if (cycleNodes.size > 0) {
    issues.push({ code: 'CYCLE_DETECTED', message: 'The workflow contains a cycle. Loops must use the Loop node instead of back-connections.', nodeId: [...cycleNodes][0], severity: 'error' });
  }

  // Referenced node outputs exist and precede usage (expression scope check)
  const incoming = new Map<string, string[]>();
  for (const conn of connections) incoming.set(conn.targetNodeId, [...(incoming.get(conn.targetNodeId) ?? []), conn.sourceNodeId]);
  const ancestorsCache = new Map<string, Set<string>>();
  const ancestors = (id: string): Set<string> => {
    const cached = ancestorsCache.get(id);
    if (cached) return cached;
    const set = new Set<string>();
    ancestorsCache.set(id, set); // pre-set to break cycles
    for (const p of incoming.get(id) ?? []) {
      set.add(p);
      for (const a of ancestors(p)) set.add(a);
    }
    return set;
  };

  const EXPR_RE = /\{\{\s*(nodes|variables)\.([A-Za-z0-9_-]+)/g;
  for (const node of nodes) {
    const raw = JSON.stringify(node.configuration ?? {});
    let m: RegExpExecArray | null;
    while ((m = EXPR_RE.exec(raw)) !== null) {
      const [, scope, ref] = m;
      if (scope === 'nodes' && ref) {
        if (!nodeById.has(ref)) {
          issues.push({ code: 'UNKNOWN_NODE_REFERENCE', message: `"${node.name}" references output of unknown node "${ref}".`, nodeId: node.id, severity: 'error' });
        } else if (ref !== node.id && !ancestors(node.id).has(ref)) {
          issues.push({ code: 'UNREACHABLE_NODE_REFERENCE', message: `"${node.name}" references "{{nodes.${ref}...}}" but that node never runs before it.`, nodeId: node.id, severity: 'error' });
        }
      }
      if (scope === 'variables' && ref) {
        const setters = nodes.filter((nd) => nd.type === 'setVariable' && String(nd.configuration.name ?? '') === ref);
        if (setters.length === 0) {
          issues.push({ code: 'UNKNOWN_VARIABLE', message: `"${node.name}" uses variable "{{variables.${ref}}}" which is never set by a Set Variable node.`, nodeId: node.id, severity: 'warning' });
        }
      }
    }
  }

  // Orphan non-trigger nodes (warning)
  const hasIncoming = new Set(connections.map((c) => c.targetNodeId));
  for (const node of nodes) {
    if (getNodeType(node.type)?.category !== 'trigger' && !hasIncoming.has(node.id)) {
      issues.push({ code: 'ORPHAN_NODE', message: `"${node.name}" is not connected to any upstream node and will never run.`, nodeId: node.id, severity: 'warning' });
    }
  }

  return { valid: issues.every((i) => i.severity !== 'error'), issues };
}
