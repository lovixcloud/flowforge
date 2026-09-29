// Core domain types shared across web, api, worker and engine packages.

export const EXECUTION_STATUSES = ['queued', 'running', 'waiting', 'completed', 'failed', 'cancelled'] as const;
export type ExecutionStatus = (typeof EXECUTION_STATUSES)[number];

export const NODE_STATUSES = ['pending', 'running', 'completed', 'failed', 'skipped', 'waiting'] as const;
export type NodeStatus = (typeof NODE_STATUSES)[number];

export type NodeTypeCategory = 'trigger' | 'logic' | 'data' | 'action';

export interface WorkflowNodePosition { x: number; y: number; }

export interface WorkflowNodeData {
  id: string;
  type: string;            // node kind e.g. "webhook", "ifElse"
  name: string;
  position: WorkflowNodePosition;
  configuration: Record<string, unknown>;
  inputSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

export interface WorkflowConnection {
  id: string;
  sourceNodeId: string;
  sourceHandle: string;    // "out" | "true" | "false" | "case:<n>" | ...
  targetNodeId: string;
  targetHandle: string;    // usually "in"
}

export interface WorkflowDefinition {
  nodes: WorkflowNodeData[];
  connections: WorkflowConnection[];
}

export type TriggerType = 'manual' | 'schedule' | 'webhook' | 'form' | 'database';

export interface ExecutionContext {
  executionId: string;
  workflowId: string;
  triggerData: unknown;
  variables: Record<string, unknown>;
  nodeOutputs: Record<string, unknown>;
  metadata: Record<string, unknown>;
}

export const ROLES = ['owner', 'admin', 'builder', 'operator', 'viewer'] as const;
export type Role = (typeof ROLES)[number];

export const PERMISSIONS = [
  'workspace.read', 'workspace.update',
  'automation.create', 'automation.read', 'automation.update', 'automation.delete',
  'automation.execute', 'automation.publish',
  'execution.read', 'integration.manage', 'team.manage', 'billing.manage',
] as const;
export type Permission = (typeof PERMISSIONS)[number];

export type PlanTier = 'free' | 'pro' | 'business' | 'enterprise';

export interface ApiErrorBody {
  success: false;
  error: { code: string; message: string; details?: unknown[] };
}
export interface ApiSuccessBody<T> { success: true; data: T; }
