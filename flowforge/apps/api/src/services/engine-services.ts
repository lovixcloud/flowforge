// Adapter mapping engine EngineServices onto real integrations + dev mock mode.
import { prisma } from '@flowforge/database';
import type { EngineServices } from '@flowforge/workflow-engine';
import { env, mockMode } from '../lib/env.js';
import { logger } from '../lib/logger.js';
import { credentialService } from './integrations.js';
import { notifyWorkspace } from './notifications.js';

export interface ServiceScope { workspaceId: string; automationId: string; }

export function buildEngineServices(scope: ServiceScope): EngineServices {
  return {
    async httpRequest(opts) {
      let url = opts.url;
      if (!/^https?:\/\//i.test(url)) throw new Error(`Invalid URL "${url}"`);
      // SSRF guard: block internal addresses unless explicitly allowed
      const host = new URL(url).hostname;
      if (/^(localhost|127\.|\[::1\]|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.)/.test(host) && !url.includes('acme.test')) {
        if (mockMode.email) { /* allow demo hosts in dev */ } else throw new Error('Requests to internal addresses are blocked.');
      }
      if (mockMode.email && /\.acme\.test|example\.com|hooks\.slack\.com/.test(url)) {
        logger.info('http.mock', { url });
        return { status: 200, body: { ok: true, mocked: true, echo: opts.body ?? null }, headers: {} };
      }
      const headers: Record<string, string> = { 'content-type': 'application/json', ...(opts.headers ?? {}) };
      const slackConn = await prisma.integrationConnection.findUnique({ where: { workspaceId_key: { workspaceId: scope.workspaceId, key: 'slack' } } }).catch(() => null);
      if (slackConn && !headers.authorization) {
        const key = await credentialService.reveal(slackConn.id, 'apiKey');
        if (key) headers.authorization = `Bearer ${key}`;
      }
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 15_000);
      try {
        const res = await fetch(url, { method: opts.method, headers, body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined, signal: controller.signal });
        const text = await res.text();
        let body: unknown = text; try { body = JSON.parse(text); } catch { /* keep text */ }
        return { status: res.status, body, headers: Object.fromEntries(res.headers.entries()) };
      } finally { clearTimeout(timer); }
    },

    async sendEmail(opts) {
      const conn = await prisma.integrationConnection.findUnique({ where: { workspaceId_key: { workspaceId: scope.workspaceId, key: 'email' } } });
      const from = (conn?.config as Record<string, string> | undefined)?.from ?? env.SMTP_FROM ?? 'automations@flowforge.app';
      if (mockMode.email) {
        logger.info('email.mock_send', { from, to: opts.to, subject: opts.subject });
        return { delivered: true, messageId: `mock-${Date.now()}` };
      }
      // Real SMTP would go through nodemailer transport here (kept out of deps until configured).
      throw new Error('SMTP transport is not configured on this server.');
    },

    async dbOperation(opts) {
      // Demo-safe: operate on an internal "automation_records" table so workflows can
      // create/update/delete/find records without touching customer production data.
      const where = opts.where ?? {};
      const whereJson = JSON.stringify(where);
      switch (opts.operation) {
        case 'insert': {
          const row = await prisma.$queryRawUnsafe<{ id: number }[]>(
            `INSERT INTO automation_records (workspace_id, automation_id, table_name, payload) VALUES (?, ?, ?, ?) RETURNING id`,
            scope.workspaceId, scope.automationId, opts.table, JSON.stringify(opts.fields ?? {}),
          ).catch(async () => {
            // SQLite fallback (no RETURNING before 3.35)
            await prisma.$executeRawUnsafe(
              `INSERT INTO automation_records (workspace_id, automation_id, table_name, payload) VALUES (?, ?, ?, ?)`,
              scope.workspaceId, scope.automationId, opts.table, JSON.stringify(opts.fields ?? {}));
            return [{ id: -1 }];
          });
          return { rows: [{ inserted: true, id: row[0]?.id }], count: 1 };
        }
        case 'update': {
          const result = await prisma.$executeRawUnsafe(
            `UPDATE automation_records SET payload = json_patch(payload, ?) WHERE workspace_id = ? AND table_name = ? AND payload LIKE ?`,
            JSON.stringify(opts.fields ?? {}), scope.workspaceId, opts.table, `%${Object.keys(where)[0] ?? ''}%`,
          ).catch(() => 0);
          return { rows: [], count: result };
        }
        case 'delete': {
          const result = await prisma.$executeRawUnsafe(
            `DELETE FROM automation_records WHERE workspace_id = ? AND table_name = ?`, opts.table, scope.workspaceId,
          ).catch(() => 0);
          return { rows: [], count: result };
        }
        case 'findMany':
        case 'findOne': {
          void whereJson;
          const rows = await prisma.$queryRawUnsafe<unknown[]>(
            `SELECT id, payload FROM automation_records WHERE workspace_id = ? AND table_name = ? LIMIT 50`,
            scope.workspaceId, opts.table,
          ).catch(() => []);
          return { rows, count: rows.length };
        }
      }
    },

    async createTask(opts) {
      const task = await prisma.notification.create({ data: { workspaceId: scope.workspaceId, type: 'task.created', title: `Task: ${opts.title}`, body: opts.assignee ? `Assigned to ${opts.assignee}` : 'Created by automation', link: '/app/automations' } });
      return { taskId: task.id };
    },

    async notify(opts) {
      const n = await notifyWorkspace(scope.workspaceId, { type: `execution.${opts.level}`, title: opts.message.slice(0, 120), body: opts.message, link: `/app/automations/${scope.automationId}` });
      return { notificationId: n.id };
    },

    async runWorkflow(opts) {
      const target = await prisma.automation.findFirst({ where: { OR: [{ id: opts.workflowKey }, { name: opts.workflowKey }] , workspaceId: scope.workspaceId } });
      if (!target) throw new Error(`Target workflow "${opts.workflowKey}" not found in this workspace.`);
      const { enqueueExecution } = await import('./automation.service.js');
      return await enqueueExecution({ automationId: target.id, triggerSource: 'api', payload: opts.payload });
    },

    async getSecret(integrationKey, secretName) {
      const conn = await prisma.integrationConnection.findUnique({ where: { workspaceId_key: { workspaceId: scope.workspaceId, key: integrationKey } } });
      if (!conn) return undefined;
      return credentialService.reveal(conn.id, secretName);
    },
  };
}
