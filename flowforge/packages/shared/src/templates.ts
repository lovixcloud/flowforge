import type { WorkflowDefinition } from './types.js';

export interface AutomationTemplate {
  key: string;
  name: string;
  description: string;
  category: string;
  icon: string;
  tags: string[];
  definition: WorkflowDefinition;
}

const n = (id: string, type: string, name: string, x: number, y: number, configuration: Record<string, unknown> = {}) => ({
  id, type, name, position: { x, y }, configuration,
});
const c = (id: string, s: string, sh: string, t: string) => ({ id, sourceNodeId: s, sourceHandle: sh, targetNodeId: t, targetHandle: 'in' });

export const TEMPLATES: AutomationTemplate[] = [
  {
    key: 'customer-onboarding', name: 'Customer Onboarding', category: 'Customers',
    description: 'When a new customer signs up, validate the data, enrich it via API, store the record and send a welcome email.',
    icon: 'Users', tags: ['webhook', 'email', 'database'],
    definition: {
      nodes: [
        n('trigger', 'webhook', 'New Customer Webhook', 0, 200, { path: 'new-customer' }),
        n('validate', 'parseJson', 'Validate Payload', 260, 200, { source: '{{trigger.body}}' }),
        n('cond', 'ifElse', 'Has valid email?', 520, 200, { left: '{{nodes.validate.email}}', operator: 'contains', right: '@' }),
        n('db', 'createRecord', 'Save Customer', 800, 100, { table: 'customers', fields: { email: '{{nodes.validate.email}}', name: '{{nodes.validate.name}}' } }),
        n('email', 'sendEmail', 'Welcome Email', 1060, 100, { to: '{{nodes.validate.email}}', subject: 'Welcome aboard!', body: 'Hi {{nodes.validate.name}}, welcome to FlowForge.' }),
        n('task', 'createTask', 'Assign Success Manager', 1060, 320, { title: 'Onboard {{nodes.validate.name}}', assignee: 'success-team' }),
      ],
      connections: [c('e1', 'trigger', 'out', 'validate'), c('e2', 'validate', 'out', 'cond'), c('e3', 'cond', 'true', 'db'), c('e4', 'cond', 'false', 'task'), c('e5', 'db', 'out', 'email')],
    },
  },
  {
    key: 'lead-notification', name: 'Lead Notification', category: 'Sales',
    description: 'Route new leads from your CRM webhook straight into Slack and email alerts with smart field mapping.',
    icon: 'Megaphone', tags: ['webhook', 'slack', 'email'],
    definition: {
      nodes: [
        n('trigger', 'webhook', 'New Lead', 0, 160, {}),
        n('filter', 'filter', 'Score > 50', 280, 160, { left: '{{trigger.body.score}}', operator: 'gt', right: 50 }),
        n('slack', 'httpRequest', 'Notify Sales Channel', 560, 60, { method: 'POST', url: 'https://hooks.slack.com/services/REPLACE', body: { text: 'Hot lead: {{trigger.body.name}}' } }),
        n('email', 'sendEmail', 'Email Sales Rep', 560, 260, { to: 'sales@company.com', subject: 'New hot lead', body: '{{trigger.body.name}} scored {{trigger.body.score}}' }),
      ],
      connections: [c('e1', 'trigger', 'out', 'filter'), c('e2', 'filter', 'true', 'slack'), c('e3', 'filter', 'false', 'email')],
    },
  },
  {
    key: 'daily-report', name: 'Daily Business Report', category: 'Operations',
    description: 'Every morning at 8:00, query your database, format the results and email a summary to leadership.',
    icon: 'FileBarChart2', tags: ['schedule', 'database', 'email'],
    definition: {
      nodes: [
        n('trigger', 'schedule', 'Every day 8:00 AM', 0, 160, { cron: '0 8 * * *' }),
        n('db', 'createRecord', 'Query Orders', 280, 160, { operation: 'findMany', table: 'orders' }),
        n('fmt', 'transformData', 'Aggregate Totals', 560, 160, { expression: '{{nodes.db.rows}}' }),
        n('email', 'sendEmail', 'Send Report', 840, 160, { to: 'leadership@company.com', subject: 'Daily report {{variables.today}}', body: 'See attached totals.' }),
      ],
      connections: [c('e1', 'trigger', 'out', 'db'), c('e2', 'db', 'out', 'fmt'), c('e3', 'fmt', 'out', 'email')],
    },
  },
  {
    key: 'webhook-processor', name: 'Webhook Data Processor', category: 'Developers',
    description: 'Receive raw webhook events, parse JSON, map fields to your internal schema and persist clean records.',
    icon: 'Zap', tags: ['webhook', 'data'],
    definition: {
      nodes: [
        n('trigger', 'webhook', 'Inbound Event', 0, 160, {}),
        n('parse', 'parseJson', 'Parse JSON', 280, 160, { source: '{{trigger.body}}' }),
        n('map', 'mapFields', 'Map To Schema', 560, 160, { mappings: { externalId: '{{nodes.parse.id}}', status: '{{nodes.parse.state}}' } }),
        n('db', 'createRecord', 'Upsert Record', 840, 160, { table: 'events', fields: '{{nodes.map.result}}' }),
        n('log', 'notification', 'Log Result', 1120, 160, { level: 'info', message: 'Processed {{nodes.map.result.externalId}}' }),
      ],
      connections: [c('e1', 'trigger', 'out', 'parse'), c('e2', 'parse', 'out', 'map'), c('e3', 'map', 'out', 'db'), c('e4', 'db', 'out', 'log')],
    },
  },
  {
    key: 'form-to-email', name: 'Website Form → Email', category: 'Marketing',
    description: 'Capture contact-form submissions and instantly notify your team with a formatted email.',
    icon: 'Mail', tags: ['form', 'email'],
    definition: {
      nodes: [
        n('trigger', 'formSubmission', 'Contact Form', 0, 160, { formId: 'contact' }),
        n('cond', 'ifElse', 'Is sales inquiry?', 280, 160, { left: '{{trigger.body.topic}}', operator: 'equals', right: 'sales' }),
        n('email1', 'sendEmail', 'Notify Sales', 560, 60, { to: 'sales@company.com', subject: 'New inquiry: {{trigger.body.name}}', body: '{{trigger.body.message}}' }),
        n('email2', 'sendEmail', 'Auto-reply', 560, 260, { to: '{{trigger.body.email}}', subject: 'We received your message', body: 'Thanks for reaching out!' }),
      ],
      connections: [c('e1', 'trigger', 'out', 'cond'), c('e2', 'cond', 'true', 'email1'), c('e3', 'cond', 'false', 'email2')],
    },
  },
  {
    key: 'order-notification', name: 'Order Notification', category: 'E-commerce',
    description: 'On every order event, update inventory, notify the customer and create a fulfilment task.',
    icon: 'ShoppingCart', tags: ['webhook', 'email', 'tasks'],
    definition: {
      nodes: [
        n('trigger', 'webhook', 'Order Created', 0, 200, {}),
        n('db', 'updateRecord', 'Reserve Inventory', 280, 200, { table: 'products', where: { sku: '{{trigger.body.sku}}' }, data: { reserved: true } }),
        n('email', 'sendEmail', 'Confirm Order', 560, 100, { to: '{{trigger.body.email}}', subject: 'Order {{trigger.body.id}} confirmed', body: 'Thanks for your purchase.' }),
        n('task', 'createTask', 'Fulfilment Task', 560, 300, { title: 'Ship order {{trigger.body.id}}' }),
      ],
      connections: [c('e1', 'trigger', 'out', 'db'), c('e2', 'db', 'out', 'email'), c('e3', 'db', 'out', 'task')],
    },
  },
  {
    key: 'db-sync', name: 'Database Synchronization', category: 'Developers',
    description: 'Hourly loop that pulls changed rows, transforms them and pushes updates to a secondary system.',
    icon: 'RefreshCw', tags: ['schedule', 'loop', 'api'],
    definition: {
      nodes: [
        n('trigger', 'schedule', 'Hourly', 0, 160, { cron: '0 * * * *' }),
        n('db', 'createRecord', 'Fetch Changes', 280, 160, { operation: 'findMany', table: 'records' }),
        n('loop', 'loop', 'For Each Row', 560, 160, { items: '{{nodes.db.rows}}' }),
        n('http', 'httpRequest', 'Push To Remote API', 840, 160, { method: 'PUT', url: 'https://api.example.com/records/{{nodes.loop.item}}', onError: 'continue' }),
      ],
      connections: [c('e1', 'trigger', 'out', 'db'), c('e2', 'db', 'out', 'loop'), c('e3', 'loop', 'body', 'http')],
    },
  },
  {
    key: 'api-health-monitor', name: 'API Health Monitor', category: 'Operations',
    description: 'Ping critical endpoints every 15 minutes. If a check fails, alert on-call via notification and delay-retry.',
    icon: 'Activity', tags: ['schedule', 'http', 'alerts'],
    definition: {
      nodes: [
        n('trigger', 'schedule', 'Every 15 min', 0, 200, { cron: '*/15 * * * *' }),
        n('http', 'httpRequest', 'GET /health', 280, 200, { method: 'GET', url: 'https://api.company.com/health' }),
        n('cond', 'ifElse', 'Status OK?', 560, 200, { left: '{{nodes.http.status}}', operator: 'equals', right: 200 }),
        n('delay', 'delay', 'Wait 60s', 840, 320, { seconds: 60 }),
        n('alert', 'notification', 'Alert On-Call', 1120, 320, { level: 'error', message: 'Health check failed: {{nodes.http.status}}' }),
      ],
      connections: [c('e1', 'trigger', 'out', 'http'), c('e2', 'http', 'out', 'cond'), c('e3', 'cond', 'true', 'alert'), c('e4', 'cond', 'false', 'delay'), c('e5', 'delay', 'out', 'alert')],
    },
  },
];
