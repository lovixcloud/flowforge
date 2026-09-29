import type { PlanTier } from './types.js';

export interface PlanLimits {
  maxWorkflows: number;              // -1 = unlimited
  maxMonthlyExecutions: number;
  maxTeamMembers: number;
  maxIntegrations: number;
  executionRetentionDays: number;
  advancedWorkflows: boolean;        // branching, loops, switches
  prioritySupport: boolean;
}

export interface PlanDefinition {
  tier: PlanTier;
  name: string;
  priceMonthly: number;              // USD
  priceYearly: number;
  tagline: string;
  limits: PlanLimits;
  features: string[];
}

export const PLANS: Record<PlanTier, PlanDefinition> = {
  free: {
    tier: 'free', name: 'Free', priceMonthly: 0, priceYearly: 0,
    tagline: 'For individuals exploring automation',
    limits: { maxWorkflows: 3, maxMonthlyExecutions: 500, maxTeamMembers: 2, maxIntegrations: 2, executionRetentionDays: 7, advancedWorkflows: false, prioritySupport: false },
    features: ['3 active workflows', '500 executions / month', 'Manual + webhook triggers', 'Community support'],
  },
  pro: {
    tier: 'pro', name: 'Pro', priceMonthly: 29, priceYearly: 290,
    tagline: 'For small teams shipping automations fast',
    limits: { maxWorkflows: 25, maxMonthlyExecutions: 10000, maxTeamMembers: 10, maxIntegrations: 10, executionRetentionDays: 30, advancedWorkflows: true, prioritySupport: false },
    features: ['25 workflows', '10,000 executions / month', 'Advanced branching & loops', 'All integrations', 'Email support'],
  },
  business: {
    tier: 'business', name: 'Business', priceMonthly: 99, priceYearly: 990,
    tagline: 'For growing companies with real operational load',
    limits: { maxWorkflows: 100, maxMonthlyExecutions: 100000, maxTeamMembers: 50, maxIntegrations: 50, executionRetentionDays: 90, advancedWorkflows: true, prioritySupport: true },
    features: ['100 workflows', '100,000 executions / month', 'Audit logs & change history', 'Role-based access control', 'Priority support'],
  },
  enterprise: {
    tier: 'enterprise', name: 'Enterprise', priceMonthly: 0, priceYearly: 0,
    tagline: 'Custom scale, security and compliance',
    limits: { maxWorkflows: -1, maxMonthlyExecutions: -1, maxTeamMembers: -1, maxIntegrations: -1, executionRetentionDays: 365, advancedWorkflows: true, prioritySupport: true },
    features: ['Unlimited everything', 'SSO / SAML', 'Dedicated infrastructure options', 'SLA & dedicated support', 'Custom integrations'],
  },
};

export const PLAN_ORDER: PlanTier[] = ['free', 'pro', 'business', 'enterprise'];
