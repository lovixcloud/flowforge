// Central entitlement service — plan logic lives ONLY here.
import { PLANS, type PlanLimits, type PlanTier } from '@flowforge/shared';
import { prisma } from '@flowforge/database';
import { badRequest } from '../lib/http.js';

export async function workspacePlan(workspaceId: string): Promise<{ tier: PlanTier; limits: PlanLimits }> {
  const ws = await prisma.workspace.findUnique({ where: { id: workspaceId }, include: { organization: { include: { subscription: true } } } });
  if (!ws) throw badRequest('WORKSPACE_NOT_FOUND', 'Workspace not found.');
  const tier = ((ws.organization.subscription?.plan ?? ws.organization.plan) as PlanTier) || 'free';
  const plan = PLANS[tier] ?? PLANS.free;
  return { tier, limits: plan.limits };
}

export async function currentPeriod(): Promise<string> {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

async function usage(organizationId: string) {
  const period = await currentPeriod();
  return prisma.usageRecord.upsert({
    where: { organizationId_period: { organizationId, period } },
    update: {},
    create: { organizationId, period },
  });
}

export async function getUsage(workspaceId: string) {
  const ws = await prisma.workspace.findUnique({ where: { id: workspaceId }, include: { organization: true } });
  if (!ws) throw badRequest('WORKSPACE_NOT_FOUND', 'Workspace not found.');
  const record = await usage(ws.organizationId);
  const [{ limits, tier }] = [await workspacePlan(workspaceId)];
  const activeAutomations = await prisma.automation.count({ where: { workspaceId, status: 'active' } });
  const teamMembers = await prisma.membership.count({ where: { workspaceId } });
  const integrations = await prisma.integrationConnection.count({ where: { workspaceId, status: 'connected' } });
  return {
    period: record.period, tier,
    executions: record.executions, nodeRuns: record.nodeRuns, apiCalls: record.apiCalls,
    storageBytes: Number(record.storageBytes), activeAutomations, teamMembers, integrations,
    limits,
  };
}

/** Call before creating resources; throws PLAN_LIMIT_EXCEEDED when over quota. */
export async function assertCanCreateAutomation(workspaceId: string): Promise<void> {
  const { limits } = await workspacePlan(workspaceId);
  if (limits.maxWorkflows < 0) return;
  const count = await prisma.automation.count({ where: { workspaceId } });
  if (count >= limits.maxWorkflows) {
    throw badRequest('PLAN_LIMIT_EXCEEDED', `Your plan allows up to ${limits.maxWorkflows} workflows. Upgrade to add more.`);
  }
}

export async function assertWithinExecutionQuota(workspaceId: string): Promise<void> {
  const [{ limits }, u] = await Promise.all([workspacePlan(workspaceId), (async () => {
    const ws = await prisma.workspace.findUnique({ where: { id: workspaceId } });
    return ws ? usage(ws.organizationId) : null;
  })()]);
  if (limits.maxMonthlyExecutions < 0) return;
  if (u && u.executions >= limits.maxMonthlyExecutions) {
    throw badRequest('PLAN_LIMIT_EXCEEDED', `Monthly execution limit (${limits.maxMonthlyExecutions}) reached. Upgrade your plan to continue running automations.`);
  }
}

export async function assertAdvancedFeatures(workspaceId: string): Promise<void> {
  const { limits } = await workspacePlan(workspaceId);
  if (!limits.advancedWorkflows) {
    throw badRequest('PLAN_FEATURE_UNAVAILABLE', 'Branching and advanced nodes require the Pro plan or higher.');
  }
}

export async function recordExecution(workspaceId: string, nodeRuns: number): Promise<void> {
  const ws = await prisma.workspace.findUnique({ where: { id: workspaceId } });
  if (!ws) return;
  const record = await usage(ws.organizationId);
  await prisma.usageRecord.update({ where: { id: record.id }, data: { executions: { increment: 1 }, nodeRuns: { increment: nodeRuns } } });
  // usage warning at 90%
  const { limits } = await workspacePlan(workspaceId);
  if (limits.maxMonthlyExecutions > 0) {
    const updated = await usage(ws.organizationId);
    if (updated.executions === Math.floor(limits.maxMonthlyExecutions * 0.9)) {
      await notifyWorkspaceSafe(workspaceId, updated.executions, limits.maxMonthlyExecutions);
    }
  }
}

async function notifyWorkspaceSafe(workspaceId: string, used: number, max: number): Promise<void> {
  const { notifyWorkspace } = await import('./notifications.js');
  await notifyWorkspace(workspaceId, { type: 'usage.warning', title: 'Usage at 90%', body: `${used.toLocaleString()} of ${max.toLocaleString()} monthly executions used.`, link: '/app/billing' }).catch(() => undefined);
}
