// Automation CRUD + workflow persistence + execution orchestration.
// Business logic lives here — routes stay thin, the engine stays persistence-agnostic.

import { randomUUID } from 'node:crypto';
import { prisma } from '@flowforge/database';
import type { WorkflowDefinition } from '@flowforge/shared';
import {
  executeWorkflow, validateWorkflow, ensureBuiltinNodeTypes, sanitizeForLog,
  type NodeRunRecord, type WorkflowExecutionRepository, type ExecutionResult,
} from '@flowforge/workflow-engine';
import { notFound, badRequest, conflict } from '../lib/http.js';
import { logger } from '../lib/logger.js';
import { buildEngineServices } from './engine-services.js';
import { configuredIntegrationKeys } from './integrations.js';
import { assertCanCreateAutomation, assertWithinExecutionQuota, recordExecution } from './entitlements.js';
import { notifyWorkspace } from './notifications.js';
import { executionQueue } from './execution-queue.js';

ensureBuiltinNodeTypes();

export interface Actor { id: string; name: string; }

// ── Prisma-backed persistence for the engine ────────────────────────────────
async function saveNodeRecord(executionId: string, r: NodeRunRecord): Promise<void> {
  await prisma.executionNode.upsert({
    where: { id: `${executionId}:${r.nodeId}` },
    update: { status: r.status, output: (r.output ?? null) as never, error: r.error, durationMs: r.durationMs, attempts: r.attempts, startedAt: r.startedAt ? new Date(r.startedAt) : undefined, finishedAt: r.finishedAt ? new Date(r.finishedAt) : undefined },
    create: { id: `${executionId}:${r.nodeId}`, executionId, nodeId: r.nodeId, nodeType: r.nodeType, name: r.name, status: r.status, input: (r.input ?? null) as never, output: (r.output ?? null) as never, error: r.error, durationMs: r.durationMs, attempts: r.attempts, startedAt: r.startedAt ? new Date(r.startedAt) : undefined, finishedAt: r.finishedAt ? new Date(r.finishedAt) : undefined },
  });
}
async function appendLog(executionId: string, entry: { level: string; message: string; at: string; data?: unknown }): Promise<void> {
  await prisma.executionLog.create({ data: { executionId, level: entry.level, message: entry.message, data: (entry.data ?? null) as never } });
}

function scopedRepo(workspaceId: string, automationId: string): WorkflowExecutionRepository {
  return {
    async createExecution(input) {
      await prisma.execution.upsert({
        where: { id: input.id },
        update: { status: input.status },
        create: { id: input.id, workspaceId, automationId, status: input.status, triggerSource: input.triggerSource, startedAt: input.startedAt, input: (input.input ?? undefined) as never },
      });
    },
    async updateExecution(input) {
      const existing = await prisma.execution.findUnique({ where: { id: input.id } });
      await prisma.execution.update({
        where: { id: input.id },
        data: {
          status: input.status,
          finishedAt: input.finishedAt ?? existing?.finishedAt,
          error: input.error,
          durationMs: input.finishedAt && existing ? input.finishedAt.getTime() - existing.startedAt.getTime() : existing?.durationMs,
          nodeCount: input.nodeCount ?? existing?.nodeCount,
        },
      });
    },
    saveNodeRecord,
    appendLog,
  };
}

// ── CRUD ─────────────────────────────────────────────────────────────────────
export async function listAutomations(workspaceId: string) {
  return prisma.automation.findMany({
    where: { workspaceId },
    include: { currentVersion: true, publishedVersion: true, lastModifiedBy: { select: { id: true, name: true } }, triggers: true, _count: { select: { executions: true } } },
    orderBy: { updatedAt: 'desc' },
  });
}

function emptyDefinition(): WorkflowDefinition {
  return { nodes: [{ id: 'trigger', type: 'manual', name: 'Manual Trigger', position: { x: 120, y: 220 }, configuration: {} }], connections: [] };
}

export async function createAutomation(workspaceId: string, input: { name: string; description?: string }, actor: Actor) {
  await assertCanCreateAutomation(workspaceId);
  const definition = emptyDefinition();
  const versionId = randomUUID();
  const automationId = randomUUID();
  await prisma.automationVersion.create({ data: { id: versionId, automationId, version: 1, definition: definition as object, changeSummary: 'Created automation', createdById: actor.id } });
  const automation = await prisma.automation.create({
    data: { id: automationId, workspaceId, name: input.name, description: input.description ?? '', status: 'draft', currentVersionId: versionId, lastModifiedById: actor.id },
  });
  await audit(workspaceId, actor, 'automation.created', 'automation', automation.id, `${actor.name} created "${input.name}"`);
  return automation;
}

export async function getAutomation(workspaceId: string, id: string) {
  const automation = await prisma.automation.findFirst({
    where: { id, workspaceId },
    include: {
      currentVersion: true, publishedVersion: true, lastModifiedBy: { select: { id: true, name: true } },
      triggers: true, schedules: true, webhooks: { select: { id: true, path: true, name: true, active: true } },
      comments: { include: { author: { select: { id: true, name: true } } }, orderBy: { createdAt: 'asc' } },
    },
  });
  if (!automation) throw notFound('Automation');
  return automation;
}

export async function updateAutomation(workspaceId: string, id: string, input: { name?: string; description?: string }, actor: Actor) {
  const existing = await prisma.automation.findFirst({ where: { id, workspaceId } });
  if (!existing) throw notFound('Automation');
  const updated = await prisma.automation.update({
    where: { id },
    data: { ...(input.name !== undefined ? { name: input.name } : {}), ...(input.description !== undefined ? { description: input.description } : {}), lastModifiedById: actor.id },
  });
  await audit(workspaceId, actor, 'automation.updated', 'automation', id, `${actor.name} updated "${updated.name}"`);
  return updated;
}

export async function deleteAutomation(workspaceId: string, id: string, actor: Actor) {
  const existing = await prisma.automation.findFirst({ where: { id, workspaceId } });
  if (!existing) throw notFound('Automation');
  await prisma.automation.delete({ where: { id } });
  await audit(workspaceId, actor, 'automation.deleted', 'automation', id, `${actor.name} deleted "${existing.name}"`);
}

export async function saveWorkflow(workspaceId: string, automationId: string, definition: WorkflowDefinition, actor: Actor) {
  const automation = await prisma.automation.findFirst({ where: { id: automationId, workspaceId }, include: { currentVersion: true } });
  if (!automation) throw notFound('Automation');
  const ids = new Set(definition.nodes.map((n) => n.id));
  if (ids.size !== definition.nodes.length) throw badRequest('DUPLICATE_NODE_ID', 'Duplicate node ids in workflow.');
  for (const c of definition.connections) if (!ids.has(c.sourceNodeId) || !ids.has(c.targetNodeId)) throw badRequest('INVALID_CONNECTION', 'Connection references a missing node.');

  const nextVersion = automation.currentVersion.version + 1;
  const versionId = randomUUID();
  await prisma.automationVersion.create({ data: { id: versionId, automationId, version: nextVersion, definition: definition as object, changeSummary: 'Saved draft', createdById: actor.id } });

  // Sync denormalized node/connection rows inside a transaction.
  await prisma.$transaction(async (tx) => {
    await tx.workflowConnection.deleteMany({ where: { automationId } });
    await tx.workflowNode.deleteMany({ where: { automationId } });
    const nodeRowIds = new Map<string, string>();
    for (const nd of definition.nodes) {
      const rowId = randomUUID();
      nodeRowIds.set(nd.id, rowId);
      await tx.workflowNode.create({ data: { id: rowId, automationId, externalId: nd.id, type: nd.type, name: nd.name, positionX: nd.position.x, positionY: nd.position.y, configuration: nd.configuration as object, metadata: (nd.metadata ?? {}) as object } });
    }
    for (const cn of definition.connections) {
      const src = nodeRowIds.get(cn.sourceNodeId); const tgt = nodeRowIds.get(cn.targetNodeId);
      if (src && tgt) await tx.workflowConnection.create({ data: { id: randomUUID(), automationId, externalId: cn.id, sourceNodeId: src, sourceHandle: cn.sourceHandle, targetNodeId: tgt, targetHandle: cn.targetHandle } });
    }
    const trig = definition.nodes.find((nd) => ['manual', 'schedule', 'webhook', 'formSubmission', 'database'].includes(nd.type));
    if (trig) {
      await tx.workflowTrigger.upsert({
        where: { automationId_nodeExternalId: { automationId, nodeExternalId: trig.id } },
        update: { type: trig.type === 'formSubmission' ? 'form' : trig.type, config: trig.configuration as object },
        create: { automationId, nodeExternalId: trig.id, type: trig.type === 'formSubmission' ? 'form' : trig.type, config: trig.configuration as object },
      });
      const isScheduled = trig.type === 'schedule';
      await tx.workflowSchedule.updateMany({
        where: { automationId },
        data: { enabled: isScheduled, nextRunAt: isScheduled ? new Date(Date.now() + 60_000) : null, ...(isScheduled ? { cron: String(trig.configuration.cron ?? '0 8 * * *') } : {}) },
      });
    }
    await tx.automation.update({ where: { id: automationId }, data: { currentVersionId: versionId, lastModifiedById: actor.id } });
  });
  await audit(workspaceId, actor, 'automation.saved', 'automation', automationId, `${actor.name} saved "${automation.name}" v${nextVersion}`);
  return { version: nextVersion, id: versionId };
}

export async function publishAutomation(workspaceId: string, automationId: string, actor: Actor) {
  const automation = await prisma.automation.findFirst({ where: { id: automationId, workspaceId }, include: { currentVersion: true } });
  if (!automation) throw notFound('Automation');
  const definition = automation.currentVersion.definition as unknown as WorkflowDefinition;
  const integrations = await configuredIntegrationKeys(workspaceId);
  const result = validateWorkflow(definition, { configuredIntegrations: integrations });
  if (!result.valid) {
    throw badRequest('WORKFLOW_VALIDATION_ERROR', 'The workflow contains invalid configuration.', result.issues.filter((i) => i.severity === 'error'));
  }
  await prisma.automation.update({ where: { id: automationId }, data: { status: 'active', publishedVersionId: automation.currentVersionId, lastModifiedById: actor.id } });
  await audit(workspaceId, actor, 'automation.published', 'automation', automationId, `${actor.name} published "${automation.name}"`);
  await notifyWorkspace(workspaceId, { type: 'deployment.success', title: `"${automation.name}" published`, body: `Version ${automation.currentVersion.version} is now live.`, link: `/app/automations/${automationId}` });
  return { published: true, version: automation.currentVersion.version };
}

export async function disableAutomation(workspaceId: string, automationId: string, actor: Actor) {
  const automation = await prisma.automation.findFirst({ where: { id: automationId, workspaceId } });
  if (!automation) throw notFound('Automation');
  await prisma.automation.update({ where: { id: automationId }, data: { status: 'disabled', lastModifiedById: actor.id } });
  await prisma.webhook.updateMany({ where: { automationId }, data: { active: false } });
  await prisma.workflowSchedule.updateMany({ where: { automationId }, data: { enabled: false } });
  await audit(workspaceId, actor, 'automation.disabled', 'automation', automationId, `${actor.name} disabled "${automation.name}"`);
  return { disabled: true };
}

// ── Execution ────────────────────────────────────────────────────────────────
interface RunParams { automationId: string; workspaceId: string; triggerSource: string; payload: unknown; usePublished: boolean; executionId?: string; }

async function runSync(params: RunParams): Promise<ExecutionResult> {
  const automation = await prisma.automation.findFirst({ where: { id: params.automationId, workspaceId: params.workspaceId } });
  if (!automation) throw notFound('Automation');
  const versionId = params.usePublished ? automation.publishedVersionId : automation.currentVersionId;
  const ver = await prisma.automationVersion.findUnique({ where: { id: versionId ?? automation.currentVersionId } });
  if (!ver) throw conflict('Automation has no saved version to run.');
  const definition = ver.definition as unknown as WorkflowDefinition;
  const integrations = await configuredIntegrationKeys(params.workspaceId);
  const result = await executeWorkflow({
    definition,
    workflowId: params.automationId,
    triggerData: params.payload,
    triggerSource: params.triggerSource,
    services: buildEngineServices({ workspaceId: params.workspaceId, automationId: params.automationId }),
    repository: scopedRepo(params.workspaceId, params.automationId),
    configuredIntegrations: integrations,
    executionId: params.executionId,
    variables: { today: new Date().toISOString().slice(0, 10) },
    maxWallClockMs: params.triggerSource === 'test' ? 30_000 : 120_000,
  });
  await recordExecution(params.workspaceId, result.nodes.filter((n) => n.status === 'completed').length);
  await prisma.automation.update({ where: { id: params.automationId }, data: { lastRunAt: new Date() } });
  if (result.status === 'failed') {
    await notifyWorkspace(params.workspaceId, { type: 'execution.failed', title: `"${automation.name}" failed`, body: result.error ?? 'Unknown error', link: `/app/executions/${result.executionId}` });
  }
  return result;
}

/** Enqueue an execution through the queue abstraction (in-process now, BullMQ later). */
export async function enqueueExecution(params: { automationId: string; triggerSource: string; payload: unknown }): Promise<{ executionId: string }> {
  const automation = await prisma.automation.findUnique({ where: { id: params.automationId } });
  if (!automation) throw notFound('Automation');
  await assertWithinExecutionQuota(automation.workspaceId);
  const executionId = randomUUID();
  await prisma.execution.create({ data: { id: executionId, workspaceId: automation.workspaceId, automationId: automation.id, status: 'queued', triggerSource: params.triggerSource, input: sanitizeForLog(params.payload) as never } });
  executionQueue.register(async (job) => {
    const meta = job.payload as Record<string, unknown>;
    try {
      await runSync({
        automationId: job.workflowId,
        workspaceId: String(meta.__workspaceId ?? ''),
        triggerSource: job.triggerSource,
        payload: meta.__payload ?? {},
        usePublished: true,
        executionId: job.executionId,
      });
    } catch (err) {
      logger.error('execution.job_failed', { executionId: job.executionId, error: err instanceof Error ? err.message : String(err) });
      await prisma.execution.update({ where: { id: job.executionId }, data: { status: 'failed', finishedAt: new Date(), error: err instanceof Error ? err.message : 'Execution failed' } }).catch(() => undefined);
    }
  });
  void executionQueue.enqueue({
    executionId,
    workflowId: automation.id,
    triggerSource: params.triggerSource,
    payload: { __workspaceId: automation.workspaceId, __payload: params.payload },
  });
  return { executionId };
}

/** Test-run the *draft* version synchronously and return the full trace. */
export async function testAutomation(workspaceId: string, automationId: string, payload: unknown): Promise<ExecutionResult> {
  await assertWithinExecutionQuota(workspaceId);
  return runSync({ automationId, workspaceId, triggerSource: 'test', payload, usePublished: false });
}

/** Retry a failed execution (failure recovery interface). */
export async function retryExecution(workspaceId: string, executionId: string, actor: Actor): Promise<{ executionId: string }> {
  const original = await prisma.execution.findFirst({ where: { id: executionId, workspaceId } });
  if (!original) throw notFound('Execution');
  if (original.status !== 'failed') throw badRequest('NOT_RETRYABLE', 'Only failed executions can be retried.');
  const newExec = await enqueueExecution({ automationId: original.automationId, triggerSource: original.triggerSource, payload: original.input ?? {} });
  await prisma.execution.update({ where: { id: newExec.executionId }, data: { retriedFromId: original.id } });
  await audit(workspaceId, actor, 'execution.retried', 'execution', original.id, `${actor.name} retried execution ${original.id.slice(0, 8)}…`);
  return newExec;
}

export async function validateDraft(workspaceId: string, automationId: string) {
  const automation = await prisma.automation.findFirst({ where: { id: automationId, workspaceId }, include: { currentVersion: true } });
  if (!automation) throw notFound('Automation');
  const integrations = await configuredIntegrationKeys(workspaceId);
  return validateWorkflow(automation.currentVersion.definition as unknown as WorkflowDefinition, { configuredIntegrations: integrations });
}

export async function addComment(workspaceId: string, automationId: string, body: string, actor: Actor) {
  const automation = await prisma.automation.findFirst({ where: { id: automationId, workspaceId } });
  if (!automation) throw notFound('Automation');
  return prisma.comment.create({ data: { automationId, authorId: actor.id, body }, include: { author: { select: { id: true, name: true } } } });
}

export async function listVersions(workspaceId: string, automationId: string) {
  const automation = await prisma.automation.findFirst({ where: { id: automationId, workspaceId } });
  if (!automation) throw notFound('Automation');
  return prisma.automationVersion.findMany({ where: { automationId }, orderBy: { version: 'desc' }, take: 25 });
}

export async function audit(workspaceId: string, actor: Actor, action: string, entityType: string, entityId: string | undefined, summary: string, metadata?: unknown): Promise<void> {
  await prisma.auditLog.create({ data: { workspaceId, userId: actor.id, action, entityType, entityId, summary, metadata: (metadata ?? undefined) as never } });
  logger.info('audit', { workspaceId, action, summary });
}
