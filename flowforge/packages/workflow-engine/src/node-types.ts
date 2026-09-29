// Built-in node type catalogue. Plugin architecture: registerNodeType() is the only
// way node types enter the system, so new nodes never require engine changes.

import { registerNodeType, type NodeRunResult } from './node-registry.js';
import { evalConditionConfig, OPERATORS } from './conditions.js';
import { resolveConfig } from '@flowforge/shared';

const out = (output: Record<string, unknown>, extra: Partial<NodeRunResult> = {}): NodeRunResult => ({ output, ...extra });

const operatorOptions = OPERATORS.map((o) => ({ value: o.value, label: o.label }));

export function registerBuiltinNodeTypes(): void {
  // ── Triggers ────────────────────────────────────────────────────────────────
  registerNodeType({
    type: 'manual', category: 'trigger', label: 'Manual Trigger', color: 'indigo', icon: 'Play',
    description: 'Start the workflow manually or via API.',
    fields: [], inputs: [], outputs: [{ id: 'out', label: 'Run' }],
    executor: async ({ context }) => out({ startedAt: new Date().toISOString(), ...(context.triggerData as object) }),
  });
  registerNodeType({
    type: 'schedule', category: 'trigger', label: 'Schedule Trigger', color: 'indigo', icon: 'Clock',
    description: 'Run on a cron schedule.',
    fields: [{ key: 'cron', label: 'Cron expression', type: 'cron', required: true, help: 'e.g. 0 8 * * * (daily 8:00 AM)' }],
    inputs: [], outputs: [{ id: 'out', label: 'Fire' }], defaultConfig: { cron: '0 8 * * *' },
    executor: async () => out({ firedAt: new Date().toISOString() }),
  });
  registerNodeType({
    type: 'webhook', category: 'trigger', label: 'Webhook Trigger', color: 'indigo', icon: 'Webhook',
    description: 'Start from an inbound HTTP webhook call.',
    fields: [{ key: 'path', label: 'Webhook path suffix', type: 'text', placeholder: 'new-customer', help: 'Documentation hint; create the endpoint in the Webhooks page.' }],
    inputs: [], outputs: [{ id: 'out', label: 'Event' }],
    executor: async ({ context }) => out({ received: true, body: context.triggerData }),
  });
  registerNodeType({
    type: 'formSubmission', category: 'trigger', label: 'Form Submission Trigger', color: 'indigo', icon: 'FileInput',
    description: 'Start when a connected form is submitted.',
    fields: [{ key: 'formId', label: 'Form ID', type: 'text', required: true }],
    inputs: [], outputs: [{ id: 'out', label: 'Submission' }], defaultConfig: { formId: 'contact' },
    executor: async ({ context }) => out({ values: context.triggerData }),
  });
  registerNodeType({
    type: 'database', category: 'trigger', label: 'Database Trigger', color: 'indigo', icon: 'Database',
    description: 'Start when rows change in a table (poll-based).',
    fields: [
      { key: 'table', label: 'Table', type: 'text', required: true },
      { key: 'event', label: 'Event', type: 'select', options: [{ value: 'insert', label: 'On insert' }, { value: 'update', label: 'On update' }, { value: 'delete', label: 'On delete' }] },
    ],
    inputs: [], outputs: [{ id: 'out', label: 'Change' }], requiresIntegration: 'postgresql', defaultConfig: { event: 'insert' },
    executor: async ({ config, context }) => out({ table: config.table, event: config.event, row: context.triggerData }),
  });

  // ── Logic ───────────────────────────────────────────────────────────────────
  const conditionFields = [
    { key: 'left', label: 'Value', type: 'text' as const, required: true, placeholder: '{{nodes.parse.email}}' },
    { key: 'operator', label: 'Operator', type: 'select' as const, required: true, options: operatorOptions },
    { key: 'right', label: 'Compare to', type: 'text' as const, placeholder: 'value or {{expression}}' },
  ];
  registerNodeType({
    type: 'ifElse', category: 'logic', label: 'If / Else', color: 'amber', icon: 'GitBranch',
    description: 'Branch the workflow into true/false paths.',
    fields: conditionFields,
    inputs: [{ id: 'in', label: 'In' }], outputs: [{ id: 'true', label: 'True' }, { id: 'false', label: 'False' }],
    defaultConfig: { operator: 'equals' },
    executor: async ({ config, context }) => {
      const result = evalConditionConfig(config, context);
      return out({ condition: result }, { branch: result ? 'true' : 'false' });
    },
  });
  registerNodeType({
    type: 'switch', category: 'logic', label: 'Switch', color: 'amber', icon: 'Shuffle',
    description: 'Route to one of several cases based on a value.',
    fields: [
      { key: 'value', label: 'Value', type: 'text', required: true, placeholder: '{{trigger.body.plan}}' },
      { key: 'cases', label: 'Case values (comma separated)', type: 'text', required: true, placeholder: 'starter,pro,enterprise' },
    ],
    inputs: [{ id: 'in', label: 'In' }],
    outputs: [{ id: 'case:0', label: 'Case 1' }, { id: 'case:1', label: 'Case 2' }, { id: 'case:2', label: 'Case 3' }, { id: 'default', label: 'Default' }],
    defaultConfig: { cases: 'a,b,c' },
    executor: async ({ config, context }) => {
      const resolved = resolveConfig(config, context) as Record<string, unknown>;
      const cases = String(resolved.cases ?? '').split(',').map((s) => s.trim());
      const idx = cases.findIndex((cval) => String(cval) === String(resolved.value));
      return out({ matched: idx }, { branch: idx >= 0 ? `case:${Math.min(idx, 2)}` : 'default' });
    },
  });
  registerNodeType({
    type: 'filter', category: 'logic', label: 'Filter', color: 'amber', icon: 'Filter',
    description: 'Continue only when data matches; otherwise take the filtered path.',
    fields: conditionFields,
    inputs: [{ id: 'in', label: 'In' }], outputs: [{ id: 'true', label: 'Passes' }, { id: 'false', label: 'Filtered' }],
    defaultConfig: { operator: 'exists' },
    executor: async ({ config, context }) => {
      const passes = evalConditionConfig(config, context);
      return out({ passes }, { branch: passes ? 'true' : 'false' });
    },
  });
  registerNodeType({
    type: 'loop', category: 'logic', label: 'Loop', color: 'amber', icon: 'Repeat',
    description: 'Iterate over an array; downstream runs per item.',
    fields: [{ key: 'items', label: 'Array to iterate', type: 'text', required: true, placeholder: '{{nodes.fetch.rows}}' }, { key: 'maxIterations', label: 'Max iterations', type: 'number' }],
    inputs: [{ id: 'in', label: 'In' }], outputs: [{ id: 'body', label: 'Each item' }, { id: 'done', label: 'Done' }],
    defaultConfig: { maxIterations: 50 },
    executor: async ({ config, context }) => {
      const resolved = resolveConfig(config, context) as Record<string, unknown>;
      const items = Array.isArray(resolved.items) ? resolved.items : [];
      const max = Number(resolved.maxIterations ?? 50);
      const slice = items.slice(0, Math.max(0, max));
      context.variables.loopItem = slice[0];
      context.variables.loopItems = slice;
      context.variables.loopIndex = 0;
      return out({ count: slice.length, items: slice }, { branch: slice.length > 0 ? 'body' : 'done' });
    },
  });
  registerNodeType({
    type: 'delay', category: 'logic', label: 'Delay', color: 'amber', icon: 'Timer',
    description: 'Wait for a fixed duration before continuing.',
    fields: [{ key: 'seconds', label: 'Seconds', type: 'number', required: true }],
    inputs: [{ id: 'in', label: 'In' }], outputs: [{ id: 'out', label: 'Resume' }], defaultConfig: { seconds: 5 },
    executor: async ({ config }) => {
      const seconds = Math.min(Math.max(Number(config.seconds ?? 0), 0), 3600);
      return out({ delayedSeconds: seconds }, { waitMs: seconds * 1000 });
    },
  });
  registerNodeType({
    type: 'merge', category: 'logic', label: 'Merge', color: 'amber', icon: 'GitMerge',
    description: 'Combine outputs of parallel branches into one stream.',
    fields: [], inputs: [{ id: 'in', label: 'A' }, { id: 'in2', label: 'B' }], outputs: [{ id: 'out', label: 'Merged' }],
    executor: async ({ context }) => out({ merged: Object.values(context.nodeOutputs).slice(-4) }),
  });

  // ── Data ────────────────────────────────────────────────────────────────────
  registerNodeType({
    type: 'parseJson', category: 'data', label: 'Parse JSON', color: 'sky', icon: 'Braces',
    description: 'Parse a JSON string or pass through an object.',
    fields: [{ key: 'source', label: 'Source', type: 'textarea', required: true, placeholder: '{{trigger.body.data}}' }],
    inputs: [{ id: 'in', label: 'In' }], outputs: [{ id: 'out', label: 'Parsed' }],
    executor: async ({ config }) => {
      const src = config.source;
      let parsed: unknown;
      if (typeof src === 'string') { try { parsed = JSON.parse(src); } catch { throw new Error('Source is not valid JSON'); } }
      else parsed = src;
      const flat = typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : { value: parsed };
      return out({ ...flat, parsed });
    },
  });
  registerNodeType({
    type: 'transformData', category: 'data', label: 'Transform Data', color: 'sky', icon: 'Wand2',
    description: 'Wrap and reshape data for downstream nodes.',
    fields: [
      { key: 'source', label: 'Source', type: 'text', required: true, placeholder: '{{nodes.fetch.rows}}' },
      { key: 'wrapKey', label: 'Wrap result under key', type: 'text', placeholder: 'result' },
    ],
    inputs: [{ id: 'in', label: 'In' }], outputs: [{ id: 'out', label: 'Transformed' }], defaultConfig: { wrapKey: 'result' },
    executor: async ({ config, context }) => {
      const resolved = resolveConfig(config, context) as Record<string, unknown>;
      const wrapKey = String(resolved.wrapKey || 'result');
      return out({ [wrapKey]: resolved.source, rowCount: Array.isArray(resolved.source) ? resolved.source.length : 1 });
    },
  });
  registerNodeType({
    type: 'mapFields', category: 'data', label: 'Map Fields', color: 'sky', icon: 'ArrowLeftRight',
    description: 'Build a new object by mapping target fields to expressions.',
    fields: [{ key: 'mappings', label: 'Mappings (target ← source)', type: 'keyvalue', required: true }],
    inputs: [{ id: 'in', label: 'In' }], outputs: [{ id: 'out', label: 'Mapped' }],
    executor: async ({ config, context }) => {
      const mappings = config.mappings as Record<string, unknown>;
      const result = resolveConfig(mappings ?? {}, context) as Record<string, unknown>;
      return out({ result, ...result });
    },
  });
  registerNodeType({
    type: 'setVariable', category: 'data', label: 'Set Variable', color: 'sky', icon: 'Variable',
    description: 'Store a value in execution variables for later use.',
    fields: [
      { key: 'name', label: 'Variable name', type: 'text', required: true, placeholder: 'companyName' },
      { key: 'value', label: 'Value', type: 'text', required: true, placeholder: '{{trigger.body.company}}' },
    ],
    inputs: [{ id: 'in', label: 'In' }], outputs: [{ id: 'out', label: 'Set' }],
    executor: async ({ config, context }) => {
      const resolved = resolveConfig(config, context) as Record<string, unknown>;
      const name = String(resolved.name);
      context.variables[name] = resolved.value;
      return out({ name, value: resolved.value });
    },
  });
  registerNodeType({
    type: 'formatData', category: 'data', label: 'Format Data', color: 'sky', icon: 'Type',
    description: 'Format dates, numbers and strings for display.',
    fields: [
      { key: 'value', label: 'Value', type: 'text', required: true, placeholder: '{{variables.today}}' },
      { key: 'format', label: 'Format', type: 'select', required: true, options: [{ value: 'date', label: 'Date (YYYY-MM-DD)' }, { value: 'datetime', label: 'Date + time' }, { value: 'currency', label: 'Currency USD' }, { value: 'uppercase', label: 'UPPERCASE' }, { value: 'lowercase', label: 'lowercase' }] },
    ],
    inputs: [{ id: 'in', label: 'In' }], outputs: [{ id: 'out', label: 'Formatted' }], defaultConfig: { format: 'date' },
    executor: async ({ config, context }) => {
      const resolved = resolveConfig(config, context) as Record<string, unknown>;
      const v = resolved.value;
      let formatted: string;
      switch (resolved.format) {
        case 'date': formatted = new Date(String(v) || Date.now()).toISOString().slice(0, 10); break;
        case 'datetime': formatted = new Date(String(v) || Date.now()).toISOString(); break;
        case 'currency': formatted = `$${Number(v).toFixed(2)}`; break;
        case 'uppercase': formatted = String(v).toUpperCase(); break;
        case 'lowercase': formatted = String(v).toLowerCase(); break;
        default: formatted = String(v);
      }
      return out({ formatted, value: formatted });
    },
  });

  // ── Actions ─────────────────────────────────────────────────────────────────
  registerNodeType({
    type: 'httpRequest', category: 'action', label: 'HTTP Request', color: 'emerald', icon: 'Globe',
    description: 'Call any external REST API.',
    fields: [
      { key: 'method', label: 'Method', type: 'select', required: true, options: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].map((m) => ({ value: m, label: m })) },
      { key: 'url', label: 'URL', type: 'text', required: true, placeholder: 'https://api.example.com/v1/resources' },
      { key: 'headers', label: 'Headers', type: 'keyvalue' },
      { key: 'body', label: 'Body (JSON)', type: 'code' },
    ],
    inputs: [{ id: 'in', label: 'In' }], outputs: [{ id: 'out', label: 'Response' }],
    defaultConfig: { method: 'GET' },
    executor: async ({ config, context, services }) => {
      const resolved = resolveConfig(config, context) as Record<string, unknown>;
      const res = await services.httpRequest({
        method: String(resolved.method ?? 'GET'),
        url: String(resolved.url ?? ''),
        headers: resolved.headers as Record<string, string> | undefined,
        body: resolved.body,
      });
      return out({ status: res.status, body: res.body, headers: res.headers });
    },
  });
  registerNodeType({
    type: 'sendEmail', category: 'action', label: 'Send Email', color: 'emerald', icon: 'Mail',
    description: 'Send an email through the configured mail integration.',
    fields: [
      { key: 'to', label: 'Recipient', type: 'text', required: true, placeholder: '{{trigger.email}}' },
      { key: 'subject', label: 'Subject', type: 'text', required: true },
      { key: 'body', label: 'Body', type: 'textarea', required: true },
    ],
    inputs: [{ id: 'in', label: 'In' }], outputs: [{ id: 'out', label: 'Sent' }],
    requiresIntegration: 'email',
    executor: async ({ config, context, services }) => {
      const resolved = resolveConfig(config, context) as Record<string, unknown>;
      const res = await services.sendEmail({ to: String(resolved.to), subject: String(resolved.subject), body: String(resolved.body) });
      return out({ delivered: res.delivered, messageId: res.messageId });
    },
  });
  const dbFields = (withWhere: boolean, withData: boolean) => ([
    { key: 'table', label: 'Table', type: 'text' as const, required: true },
    ...(withWhere ? [{ key: 'where', label: 'Where (JSON)', type: 'code' as const }] : []),
    ...(withData ? [{ key: 'fields', label: 'Fields (JSON)', type: 'keyvalue' as const, required: true }] : []),
  ]);
  registerNodeType({
    type: 'createRecord', category: 'action', label: 'Create Record', color: 'emerald', icon: 'Database',
    description: 'Insert a record into the workspace database.',
    fields: dbFields(false, true), inputs: [{ id: 'in', label: 'In' }], outputs: [{ id: 'out', label: 'Created' }],
    requiresIntegration: 'postgresql',
    executor: async ({ config, context, services }) => {
      const resolved = resolveConfig(config, context) as Record<string, unknown>;
      const res = await services.dbOperation({ operation: 'insert', table: String(resolved.table), fields: resolved.fields as Record<string, unknown> });
      return out({ created: true, rows: res.rows, count: res.count });
    },
  });
  registerNodeType({
    type: 'updateRecord', category: 'action', label: 'Update Record', color: 'emerald', icon: 'Pencil',
    description: 'Update records matching a filter.',
    fields: dbFields(true, true), inputs: [{ id: 'in', label: 'In' }], outputs: [{ id: 'out', label: 'Updated' }],
    requiresIntegration: 'postgresql',
    executor: async ({ config, context, services }) => {
      const resolved = resolveConfig(config, context) as Record<string, unknown>;
      const res = await services.dbOperation({ operation: 'update', table: String(resolved.table), where: (resolved.where ?? {}) as Record<string, unknown>, fields: resolved.fields as Record<string, unknown> });
      return out({ updatedCount: res.count, rows: res.rows });
    },
  });
  registerNodeType({
    type: 'deleteRecord', category: 'action', label: 'Delete Record', color: 'emerald', icon: 'Trash2',
    description: 'Delete records matching a filter.',
    fields: dbFields(true, false), inputs: [{ id: 'in', label: 'In' }], outputs: [{ id: 'out', label: 'Deleted' }],
    requiresIntegration: 'postgresql',
    executor: async ({ config, context, services }) => {
      const resolved = resolveConfig(config, context) as Record<string, unknown>;
      const res = await services.dbOperation({ operation: 'delete', table: String(resolved.table), where: (resolved.where ?? {}) as Record<string, unknown> });
      return out({ deletedCount: res.count });
    },
  });
  registerNodeType({
    type: 'notification', category: 'action', label: 'Send Notification', color: 'emerald', icon: 'Bell',
    description: 'Create an in-app notification for the workspace team.',
    fields: [
      { key: 'level', label: 'Level', type: 'select', required: true, options: [{ value: 'info', label: 'Info' }, { value: 'success', label: 'Success' }, { value: 'warning', label: 'Warning' }, { value: 'error', label: 'Error' }] },
      { key: 'message', label: 'Message', type: 'textarea', required: true },
    ],
    inputs: [{ id: 'in', label: 'In' }], outputs: [{ id: 'out', label: 'Sent' }], defaultConfig: { level: 'info' },
    executor: async ({ config, context, services }) => {
      const resolved = resolveConfig(config, context) as Record<string, unknown>;
      const res = await services.notify({ level: String(resolved.level), message: String(resolved.message) });
      return out({ notificationId: res.notificationId });
    },
  });
  registerNodeType({
    type: 'createTask', category: 'action', label: 'Create Task', color: 'emerald', icon: 'CheckSquare',
    description: 'Create a follow-up task for a teammate.',
    fields: [
      { key: 'title', label: 'Task title', type: 'text', required: true, placeholder: 'Follow up with {{trigger.name}}' },
      { key: 'assignee', label: 'Assignee email', type: 'text' },
      { key: 'dueDate', label: 'Due date', type: 'text', placeholder: '2026-10-01' },
    ],
    inputs: [{ id: 'in', label: 'In' }], outputs: [{ id: 'out', label: 'Created' }],
    executor: async ({ config, context, services }) => {
      const resolved = resolveConfig(config, context) as Record<string, unknown>;
      const res = await services.createTask({ title: String(resolved.title), assignee: resolved.assignee ? String(resolved.assignee) : undefined, dueDate: resolved.dueDate ? String(resolved.dueDate) : undefined });
      return out({ taskId: res.taskId, title: resolved.title });
    },
  });
  registerNodeType({
    type: 'runWorkflow', category: 'action', label: 'Run Workflow', color: 'emerald', icon: 'Workflow',
    description: 'Trigger another automation (sub-workflow).',
    fields: [
      { key: 'workflowKey', label: 'Target automation ID or name', type: 'text', required: true },
      { key: 'payload', label: 'Payload (JSON)', type: 'code' },
    ],
    inputs: [{ id: 'in', label: 'In' }], outputs: [{ id: 'out', label: 'Started' }],
    executor: async ({ config, context, services }) => {
      const resolved = resolveConfig(config, context) as Record<string, unknown>;
      const res = await services.runWorkflow({ workflowKey: String(resolved.workflowKey), payload: (resolved.payload as Record<string, unknown>) ?? {} });
      return out({ executionId: res.executionId });
    },
  });
}

let registered = false;
export function ensureBuiltinNodeTypes(): void {
  if (registered) return;
  registerBuiltinNodeTypes();
  registered = true;
}
