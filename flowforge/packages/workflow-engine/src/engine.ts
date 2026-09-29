// The workflow execution engine: dependency-ordered, branching-aware, retry-capable.
// Persistence-agnostic — the API/worker inject a WorkflowExecutionRepository.

import { randomUUID } from 'node:crypto';
import type { ExecutionContext, ExecutionStatus, NodeStatus, WorkflowConnection, WorkflowDefinition, WorkflowNodeData } from '@flowforge/shared';
import { getNodeType, type EngineServices } from './node-registry.js';
import { validateWorkflow, type ValidationResult } from './validation.js';
import { ensureBuiltinNodeTypes } from './node-types.js';

ensureBuiltinNodeTypes();

export interface NodeRunRecord {
  nodeId: string;
  nodeType: string;
  name: string;
  status: NodeStatus;
  input: unknown;
  output: unknown;
  error?: string;
  startedAt?: string;
  finishedAt?: string;
  durationMs: number;
  attempts: number;
}

export interface ExecutionResult {
  executionId: string;
  workflowId: string;
  status: ExecutionStatus;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  nodes: NodeRunRecord[];
  logs: { level: string; message: string; at: string; data?: unknown }[];
  error?: string;
  context: ExecutionContext;
}

export interface WorkflowExecutionRepository {
  createExecution(input: { id: string; status: ExecutionStatus; triggerSource: string; startedAt: Date; input: unknown }): Promise<void>;
  updateExecution(input: { id: string; status: ExecutionStatus; finishedAt?: Date; error?: string; nodeCount?: number }): Promise<void>;
  saveNodeRecord(executionId: string, record: NodeRunRecord): Promise<void>;
  appendLog(executionId: string, entry: { level: string; message: string; at: string; data?: unknown }): Promise<void>;
}

export const noopExecutionRepository: WorkflowExecutionRepository = {
  async createExecution() {}, async updateExecution() {}, async saveNodeRecord() {}, async appendLog() {},
};

export interface ExecuteOptions {
  definition: WorkflowDefinition;
  workflowId: string;
  triggerData: unknown;
  triggerSource: string;              // manual | webhook | schedule | test | api
  services: EngineServices;
  repository?: WorkflowExecutionRepository;
  variables?: Record<string, unknown>;
  configuredIntegrations?: string[];
  executionId?: string;
  maxWallClockMs?: number;            // cap for delays / runaway protection
}

interface RetryPolicy { retries: number; delayMs: number; backoff: 'fixed' | 'exponential'; onError: 'stop' | 'continue'; }

function readRetryPolicy(node: WorkflowNodeData): RetryPolicy {
  const m = node.metadata ?? {};
  return {
    retries: Math.min(Math.max(Number(m.retries ?? 0), 0), 10),
    delayMs: Math.min(Math.max(Number(m.retryDelayMs ?? 500), 0), 60_000),
    backoff: m.retryBackoff === 'fixed' ? 'fixed' : 'exponential',
    onError: m.onError === 'continue' ? 'continue' : 'stop',
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Mask obvious secret material so it never reaches logs or persisted traces. */
export function sanitizeForLog(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[truncated]';
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => sanitizeForLog(v, depth + 1));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (/secret|token|password|authorization|apikey|api_key|credential/i.test(k)) out[k] = '••••••';
      else out[k] = sanitizeForLog(v, depth + 1);
    }
    return out;
  }
  if (typeof value === 'string' && value.length > 4000) return value.slice(0, 4000) + '…[truncated]';
  return value;
}

export class WorkflowExecutionError extends Error {
  constructor(message: string, readonly validation?: ValidationResult) { super(message); }
}

export async function executeWorkflow(options: ExecuteOptions): Promise<ExecutionResult> {
  const repo = options.repository ?? noopExecutionRepository;
  const executionId = options.executionId ?? randomUUID();
  const startedAt = new Date();
  const context: ExecutionContext = {
    executionId,
    workflowId: options.workflowId,
    triggerData: options.triggerData,
    variables: { ...(options.variables ?? {}) },
    nodeOutputs: {},
    metadata: { triggerSource: options.triggerSource },
  };

  // Validate before running — invalid workflows never execute.
  const validation = validateWorkflow(options.definition, { configuredIntegrations: options.configuredIntegrations });
  if (!validation.valid) {
    throw new WorkflowExecutionError('Workflow failed validation and cannot be executed.', validation);
  }

  await repo.createExecution({ id: executionId, status: 'running', triggerSource: options.triggerSource, startedAt, input: sanitizeForLog(options.triggerData) });
  await repo.updateExecution({ id: executionId, status: 'running' });

  const logs: ExecutionResult['logs'] = [];
  const log = async (level: string, message: string, data?: unknown) => {
    const entry = { level, message, at: new Date().toISOString(), data: data === undefined ? undefined : sanitizeForLog(data) };
    logs.push(entry);
    await repo.appendLog(executionId, entry);
  };
  await log('info', `Execution started (${options.triggerSource})`);

  const { nodes, connections } = options.definition;
  const nodeById = new Map(nodes.map((nd) => [nd.id, nd]));
  const records = new Map<string, NodeRunRecord>();
  const firedHandles = new Map<string, Set<string>>();
  const visitedCount = new Map<string, number>();

  const outgoing = new Map<string, WorkflowConnection[]>();
  for (const conn of connections) outgoing.set(conn.sourceNodeId, [...(outgoing.get(conn.sourceNodeId) ?? []), conn]);

  const triggers = nodes.filter((nd) => getNodeType(nd.type)?.category === 'trigger');
  const startNodes = triggers.length > 0 ? [triggers[0]!] : nodes.filter((nd) => !connections.some((c) => c.targetNodeId === nd.id));

  const deadline = Date.now() + (options.maxWallClockMs ?? 120_000);
  let wallClockExceeded = false;

  const runNode = async (node: WorkflowNodeData): Promise<void> => {
    const def = getNodeType(node.type)!;
    const policy = readRetryPolicy(node);
    const inputSnapshot = sanitizeForLog({ configuration: node.configuration });

    let attempt = 0;
    let lastError: Error | null = null;
    while (attempt <= policy.retries) {
      if (Date.now() > deadline) { wallClockExceeded = true; break; }
      const started = Date.now();
      const rec: NodeRunRecord = records.get(node.id) ?? { nodeId: node.id, nodeType: node.type, name: node.name, status: 'running', input: inputSnapshot, output: null, durationMs: 0, attempts: 0 };
      rec.status = 'running'; rec.startedAt = new Date().toISOString(); rec.attempts = attempt + 1;
      records.set(node.id, rec);
      try {
        const result = await def.executor({
          node, config: node.configuration, rawConfig: node.configuration, context, services: options.services,
          log: (lvl, msg, data) => { void log(lvl, `[${node.name}] ${msg}`, data); }, attempt,
        });
        rec.status = result.skipped ? 'skipped' : 'completed';
        rec.output = sanitizeForLog(result.output);
        rec.durationMs = Date.now() - started;
        rec.finishedAt = new Date().toISOString();
        context.nodeOutputs[node.id] = result.output;
        firedHandles.set(node.id, new Set([result.branch ?? 'out']));
        await repo.saveNodeRecord(executionId, rec);
        await log('info', `Node "${node.name}" ${rec.status} in ${rec.durationMs}ms`);
        if (result.waitMs && result.waitMs > 0) {
          rec.status = 'waiting'; await repo.saveNodeRecord(executionId, rec);
          await log('info', `Node "${node.name}" waiting ${result.waitMs}ms`);
          await sleep(Math.min(result.waitMs, Math.max(0, deadline - Date.now())));
          rec.status = 'completed'; await repo.saveNodeRecord(executionId, rec);
        }
        lastError = null;
        break;
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        rec.durationMs = Date.now() - started;
        rec.error = lastError.message;
        await log('warn', `Node "${node.name}" attempt ${attempt + 1}/${policy.retries + 1} failed: ${lastError.message}`);
        attempt++;
        if (attempt <= policy.retries) {
          const wait = policy.backoff === 'exponential' ? policy.delayMs * 2 ** (attempt - 1) : policy.delayMs;
          rec.status = 'waiting'; records.set(node.id, rec);
          await sleep(Math.min(wait, Math.max(0, deadline - Date.now())));
        }
      }
    }

    if (lastError) {
      const rec = records.get(node.id)!;
      rec.status = 'failed'; rec.finishedAt = new Date().toISOString();
      await repo.saveNodeRecord(executionId, rec);
      await log('error', `Node "${node.name}" failed permanently: ${lastError.message}`);
      if (policy.onError === 'continue') {
        firedHandles.set(node.id, new Set(['out']));   // continue downstream with error payload
        context.nodeOutputs[node.id] = { error: lastError.message };
      } else {
        throw lastError;
      }
    }
  };

  let failure: Error | null = null;
  if (startNodes.length === 0) {
    failure = new Error('No start node found in workflow.');
    await log('error', failure.message);
  } else {
    // BFS through fired handles → dependency order along edges, branch-aware.
    const queue: WorkflowNodeData[] = [...startNodes];
    while (queue.length > 0) {
      if (Date.now() > deadline) { wallClockExceeded = true; break; }
      const node = queue.shift()!;
      const visits = (visitedCount.get(node.id) ?? 0) + 1;
      visitedCount.set(node.id, visits);
      if (visits > 20) continue; // runaway guard per node
      try {
        await runNode(node);
      } catch (err) {
        failure = err instanceof Error ? err : new Error(String(err));
        break;
      }
      const handles = firedHandles.get(node.id) ?? new Set(['out']);
      for (const conn of outgoing.get(node.id) ?? []) {
        if (handles.has(conn.sourceHandle)) {
          const target = nodeById.get(conn.targetNodeId);
          if (target) queue.push(target);
        }
      }
    }
  }

  const finishedAt = new Date();
  const status: ExecutionStatus = failure || wallClockExceeded ? 'failed' : 'completed';
  const nodeRecords = [...records.values()];
  const errorMessage = failure?.message ?? (wallClockExceeded ? 'Execution exceeded time budget' : undefined);
  await repo.updateExecution({ id: executionId, status, finishedAt, error: errorMessage, nodeCount: nodeRecords.filter((r) => r.status === 'completed').length });
  await log(status === 'completed' ? 'info' : 'error', `Execution ${status}`);

  return {
    executionId, workflowId: options.workflowId, status,
    startedAt: startedAt.toISOString(), finishedAt: finishedAt.toISOString(),
    durationMs: finishedAt.getTime() - startedAt.getTime(),
    nodes: nodeRecords, logs, error: errorMessage, context,
  };
}
