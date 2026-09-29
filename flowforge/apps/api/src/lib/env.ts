import { z } from 'zod';

// Environment variables are validated at startup — the app refuses to boot misconfigured.
const serverEnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().default(4000),
  DATABASE_PROVIDER: z.string().default('sqlite'),
  DATABASE_URL: z.string().default('file:../../data/flowforge.db'),
  SESSION_SECRET: z.string().min(8).default('flowforge-dev-session-secret-change-me'),
  ENCRYPTION_KEY: z.string().min(8).default('flowforge-dev-encryption-key-change-me'),
  APP_URL: z.string().default('http://localhost:5173'),
  API_URL: z.string().default('http://localhost:4000'),
  REDIS_URL: z.string().optional(),
  // External providers (all optional → dev mock mode)
  SUPABASE_URL: z.string().optional(),
  SUPABASE_ANON_KEY: z.string().optional(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().optional(),
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().optional(),
  SMTP_USER: z.string().optional(),
  SMTP_PASSWORD: z.string().optional(),
  SMTP_FROM: z.string().optional(),
  STRIPE_SECRET_KEY: z.string().optional(),
  STRIPE_WEBHOOK_SECRET: z.string().optional(),
});

export type ServerEnv = z.infer<typeof serverEnvSchema>;

export const env: ServerEnv = serverEnvSchema.parse(process.env);

if (env.NODE_ENV === 'production') {
  if (env.SESSION_SECRET.startsWith('flowforge-dev')) throw new Error('SESSION_SECRET must be set in production');
  if (env.ENCRYPTION_KEY.startsWith('flowforge-dev')) throw new Error('ENCRYPTION_KEY must be set in production');
  if (env.DATABASE_PROVIDER === 'sqlite') throw new Error('Production must use PostgreSQL (DATABASE_PROVIDER=postgresql)');
}

/** True when external providers aren't configured → adapters run in safe mock mode. */
export const mockMode = {
  email: !env.SMTP_HOST,
  billing: !env.STRIPE_SECRET_KEY,
  auth: !env.SUPABASE_URL, // local session-cookie auth instead of Supabase
};
