// Plugin-based node architecture: every node type registers a definition here.
// Adding a new trigger/action = one registerNodeType() call; the engine never changes.

import type { NodeTypeCategory, WorkflowNodeData } from '@flowforge/shared';

export interface NodeFieldDef {
  key: string;
  label: string;
  type: 'text' | 'textarea' | 'number' | 'select' | 'boolean' | 'keyvalue' | 'code' | 'cron';
  required?: boolean;
  options?: { value: string; label: string }[];
  placeholder?: string;
  help?: string;
}

export interface NodePortDef { id: string; label: string; }

export interface NodeRunResult {
  output: Record<string, unknown>;
  /** For branch nodes: which out-handle fired ("true"/"false"/"case:0"...). Default "out". */
  branch?: string;
  /** For delay/loop nodes: pause execution for N ms before continuing. */
  waitMs?: number;
  skipped?: boolean;
}

export interface NodeExecutionContext {
  node: WorkflowNodeData;
  config: Record<string, unknown>;   // expressions already resolved
  rawConfig: Record<string, unknown>;
  context: {
    executionId: string; workflowId: string; triggerData: unknown;
    variables: Record<string, unknown>; nodeOutputs: Record<string, unknown>;
    metadata: Record<string, unknown>;
  };
  services: EngineServices;
  log: (level: 'info' | 'warn' | 'error', message: string, data?: unknown) => void;
  attempt: number;                    // 0-based retry attempt
}

export interface NodeExecutor {
  run(ctx: NodeExecutionContext): Promise<NodeRunResult>;
}

export interface NodeTypeDef {
  type: string;
  category: NodeTypeCategory;
  label: string;
  description: string;
  icon: string;                       // lucide icon name
  color: string;                      // tailwind-ish accent key: indigo|amber|sky|emerald|rose
  fields: NodeFieldDef[];
  inputs: NodePortDef[];
  outputs: NodePortDef[];             // [{id:'out'}] or [{id:'true'},{id:'false'}]
  defaultConfig?: Record<string, unknown>;
  /** integration key required in settings.configuredIntegrations, if any */
  requiresIntegration?: string;
  executor: NodeExecutor;
}

export interface EngineServices {
  httpRequest: (opts: { method: string; url: string; headers?: Record<string, string>; body?: unknown; timeoutMs?: number }) => Promise<{ status: number; body: unknown; headers: Record<string, string> }>;
  sendEmail: (opts: { to: string; subject: string; body: string }) => Promise<{ delivered: boolean; messageId: string }>;
  dbOperation: (opts: { operation: 'insert' | 'update' | 'delete' | 'findMany' | 'findOne'; table: string; fields?: Record<string, unknown>; where?: Record<string, unknown> }) => Promise<{ rows: unknown[]; count: number }>;
  createTask: (opts: { title: string; assignee?: string; dueDate?: string }) => Promise<{ taskId: string }>;
  notify: (opts: { level: string; message: string }) => Promise<{ notificationId: string }>;
  runWorkflow: (opts: { workflowKey: string; payload: Record<string, unknown> }) => Promise<{ executionId: string }>;
  getSecret: (integrationKey: string, secretName: string) => Promise<string | undefined>;
}

const registry = new Map<string, NodeTypeDef>();

export function registerNodeType(def: NodeTypeDef): void {
  registry.set(def.type, def);
}

export function getNodeType(type: string): NodeTypeDef | undefined {
  return registry.get(type);
}

export function listNodeTypes(): NodeTypeDef[] {
  return [...registry.values()];
}

export function clearNodeTypes(): void {
  registry.clear();
}
