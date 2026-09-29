import { z } from 'zod';
import { EXECUTION_STATUSES, ROLES } from './types.js';

export const loginSchema = z.object({
  email: z.string().email('Enter a valid email address'),
  password: z.string().min(8, 'Password must be at least 8 characters'),
});

export const registerSchema = z.object({
  name: z.string().min(1, 'Name is required').max(120),
  email: z.string().email('Enter a valid email address'),
  password: z.string()
    .min(8, 'Password must be at least 8 characters')
    .regex(/[a-z]/, 'Include a lowercase letter')
    .regex(/[A-Z0-9]/, 'Include an uppercase letter or number'),
  organizationName: z.string().min(2, 'Organization name is required').max(120),
});

export const forgotPasswordSchema = z.object({ email: z.string().email() });
export const resetPasswordSchema = z.object({ token: z.string().min(10), password: z.string().min(8) });

export const workspaceUpdateSchema = z.object({
  name: z.string().min(2).max(120).optional(),
  slug: z.string().min(2).max(60).regex(/^[a-z0-9-]+$/, 'Lowercase letters, numbers and dashes only').optional(),
});

export const automationCreateSchema = z.object({
  name: z.string().min(2, 'Give your automation a name').max(140),
  description: z.string().max(2000).optional().default(''),
  folderId: z.string().optional(),
});

export const automationUpdateSchema = automationCreateSchema.partial();

export const workflowSaveSchema = z.object({
  definition: z.object({
    nodes: z.array(z.object({
      id: z.string().min(1),
      type: z.string().min(1),
      name: z.string().min(1).max(140),
      position: z.object({ x: z.number(), y: z.number() }),
      configuration: z.record(z.unknown()).default({}),
      metadata: z.record(z.unknown()).optional(),
    })).max(200),
    connections: z.array(z.object({
      id: z.string().min(1),
      sourceNodeId: z.string().min(1),
      sourceHandle: z.string().default('out'),
      targetNodeId: z.string().min(1),
      targetHandle: z.string().default('in'),
    })).max(600),
  }),
});

export const executeSchema = z.object({ payload: z.record(z.unknown()).optional().default({}) });

export const webhookCreateSchema = z.object({
  name: z.string().min(2).max(140),
  method: z.enum(['POST', 'PUT', 'PATCH']).default('POST'),
});

export const integrationConnectSchema = z.object({
  integrationKey: z.string().min(1),
  config: z.record(z.unknown()).default({}),
  secrets: z.record(z.string()).default({}),
});

export const teamInviteSchema = z.object({
  email: z.string().email(),
  role: z.enum(ROLES),
});

export const teamMemberUpdateSchema = z.object({ role: z.enum(ROLES) });

export const scheduleUpsertSchema = z.object({
  cron: z.string().min(4).max(120),
  timezone: z.string().default('UTC'),
  enabled: z.boolean().default(true),
});

export const commentCreateSchema = z.object({ body: z.string().min(1).max(4000) });

export const notificationReadSchema = z.object({ ids: z.array(z.string()).optional() });

export const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  status: z.enum(EXECUTION_STATUSES).optional(),
  search: z.string().max(200).optional(),
});

export const executionQuerySchema = paginationSchema;

export const apiKeyCreateSchema = z.object({ name: z.string().min(2).max(100) });

export type LoginInput = z.infer<typeof loginSchema>;
export type RegisterInput = z.infer<typeof registerSchema>;
export type AutomationCreateInput = z.infer<typeof automationCreateSchema>;
export type WorkflowSaveInput = z.infer<typeof workflowSaveSchema>;
export type TeamInviteInput = z.infer<typeof teamInviteSchema>;
export type IntegrationConnectInput = z.infer<typeof integrationConnectSchema>;
export type WebhookCreateInput = z.infer<typeof webhookCreateSchema>;
