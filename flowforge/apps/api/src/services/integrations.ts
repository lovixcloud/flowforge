// Integration framework: a catalog of integration definitions + a credential service
// abstraction. Nothing in the app hardcodes provider specifics.

import { prisma } from '@flowforge/database';
import { decryptSecret, encryptSecret, maskSecret } from '../lib/crypto.js';
import { logger } from '../lib/logger.js';

export interface IntegrationFieldDef { key: string; label: string; type: 'text' | 'password' | 'url' | 'select'; required?: boolean; options?: { value: string; label: string }[]; placeholder?: string; }

export interface IntegrationDefinition {
  key: string;
  name: string;
  description: string;
  icon: string;
  authMethod: 'none' | 'api-key' | 'oauth' | 'webhook-url' | 'connection-string';
  configSchema: IntegrationFieldDef[];      // non-secret configuration
  secretSchema: IntegrationFieldDef[];      // credentials → encrypted at rest
  actions: string[];                        // node types this integration powers
  triggers: string[];
}

export const INTEGRATION_CATALOG: IntegrationDefinition[] = [
  { key: 'rest-api', name: 'REST API', description: 'Call any HTTP endpoint with headers, auth and JSON payloads.', icon: 'Globe', authMethod: 'api-key', configSchema: [{ key: 'baseUrl', label: 'Base URL', type: 'url', placeholder: 'https://api.example.com' }], secretSchema: [{ key: 'apiKey', label: 'API Key', type: 'password' }], actions: ['httpRequest'], triggers: [] },
  { key: 'webhooks', name: 'Webhooks', description: 'Receive events from external systems on signed HTTPS endpoints.', icon: 'Webhook', authMethod: 'none', configSchema: [], secretSchema: [], actions: [], triggers: ['webhook'] },
  { key: 'email', name: 'Email (SMTP)', description: 'Send transactional email through SMTP or a provider relay.', icon: 'Mail', authMethod: 'api-key', configSchema: [{ key: 'from', label: 'From address', type: 'text', placeholder: 'automations@company.com' }], secretSchema: [{ key: 'smtpPassword', label: 'SMTP password', type: 'password' }], actions: ['sendEmail'], triggers: [] },
  { key: 'postgresql', name: 'PostgreSQL', description: 'Read and write rows in your operational database.', icon: 'Database', authMethod: 'connection-string', configSchema: [{ key: 'host', label: 'Host', type: 'text' }, { key: 'database', label: 'Database', type: 'text' }, { key: 'user', label: 'User', type: 'text' }], secretSchema: [{ key: 'password', label: 'Password', type: 'password' }], actions: ['createRecord', 'updateRecord', 'deleteRecord'], triggers: ['database'] },
  { key: 'slack', name: 'Slack', description: 'Post messages to channels via Slack-compatible webhooks.', icon: 'MessageSquare', authMethod: 'webhook-url', configSchema: [{ key: 'channel', label: 'Default channel', type: 'text', placeholder: '#general' }], secretSchema: [{ key: 'webhookUrl', label: 'Incoming webhook URL', type: 'password' }], actions: ['httpRequest'], triggers: [] },
  { key: 'discord', name: 'Discord', description: 'Send notifications through Discord-compatible webhooks.', icon: 'MessagesSquare', authMethod: 'webhook-url', configSchema: [], secretSchema: [{ key: 'webhookUrl', label: 'Webhook URL', type: 'password' }], actions: ['httpRequest'], triggers: [] },
];

export function findIntegration(key: string): IntegrationDefinition | undefined {
  return INTEGRATION_CATALOG.find((i) => i.key === key);
}

/** Credential service abstraction — swap for Vault/AWS SM/KMS later without touching callers. */
export const credentialService = {
  async store(connectionId: string, name: string, plaintext: string): Promise<void> {
    const encrypted = encryptSecret(plaintext);
    await prisma.credential.upsert({
      where: { connectionId_name: { connectionId, name } },
      update: { encryptedValue: encrypted, maskedValue: maskSecret(plaintext) },
      create: { connectionId, name, encryptedValue: encrypted, maskedValue: maskSecret(plaintext) },
    });
  },
  async reveal(connectionId: string, name: string): Promise<string | undefined> {
    const cred = await prisma.credential.findUnique({ where: { connectionId_name: { connectionId, name } } });
    if (!cred) return undefined;
    try { return decryptSecret(cred.encryptedValue); } catch { logger.error('credential.decrypt_failed', { connectionId, name }); return undefined; }
  },
  async listMasked(connectionId: string): Promise<{ name: string; masked: string }[]> {
    const creds = await prisma.credential.findMany({ where: { connectionId } });
    return creds.map((c) => ({ name: c.name, masked: c.maskedValue }));
  },
};

export async function configuredIntegrationKeys(workspaceId: string): Promise<string[]> {
  const conns = await prisma.integrationConnection.findMany({ where: { workspaceId, status: 'connected' } });
  return conns.map((c) => c.key);
}
