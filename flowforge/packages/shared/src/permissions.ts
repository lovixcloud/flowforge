import type { Permission, Role } from './types.js';

const ALL: Permission[] = [
  'workspace.read', 'workspace.update',
  'automation.create', 'automation.read', 'automation.update', 'automation.delete',
  'automation.execute', 'automation.publish',
  'execution.read', 'integration.manage', 'team.manage', 'billing.manage',
];

const READ_ONLY: Permission[] = ['workspace.read', 'automation.read', 'execution.read'];

/** Single source of truth for role → permission mapping (used by API *and* UI). */
export const ROLE_PERMISSIONS: Record<Role, Permission[]> = {
  owner: [...ALL],
  admin: [...ALL].filter((p) => p !== 'billing.manage' || true), // admins manage everything incl. billing
  builder: ['workspace.read', 'automation.create', 'automation.read', 'automation.update', 'automation.execute', 'automation.publish', 'execution.read', 'integration.manage'],
  operator: ['workspace.read', 'automation.read', 'automation.execute', 'execution.read', 'integration.manage'],
  viewer: [...READ_ONLY],
};

export function hasPermission(role: Role, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role]?.includes(permission) ?? false;
}

export function permissionsForRole(role: Role): Permission[] {
  return ROLE_PERMISSIONS[role] ?? [];
}
