import type { NextFunction, Request, Response } from 'express';
import { prisma } from '@flowforge/database';
import { sha256 } from '../lib/crypto.js';
import { unauthorized, forbidden } from '../lib/http.js';
import type { Permission, Role } from '@flowforge/shared';
import { hasPermission } from '@flowforge/shared';

export interface AuthedUser { id: string; email: string; name: string; }
declare module 'express-serve-static-core' {
  interface Request { user?: AuthedUser; }
}

const SESSION_COOKIE = 'ff_session';
export { SESSION_COOKIE };

export async function loadSession(req: Request): Promise<AuthedUser | null> {
  const authHeader = req.headers.authorization;
  const bearer = authHeader?.startsWith('Bearer ff-') ? authHeader.slice(7) : undefined;
  const token = req.cookies?.[SESSION_COOKIE] ?? bearer;
  if (!token) return null;
  const session = await prisma.session.findUnique({ where: { token: sha256(token) }, include: { user: true } });
  if (!session || session.expiresAt < new Date()) return null;
  return { id: session.user.id, email: session.user.email, name: session.user.name };
}

/** Require authentication. */
export async function requireAuth(req: Request, _res: Response, next: NextFunction): Promise<void> {
  try {
    const user = await loadSession(req);
    if (!user) throw unauthorized();
    req.user = user;
    next();
  } catch (err) { next(err); }
}

/**
 * Resolve the active workspace from header `x-workspace-id` (or query param) and enforce
 * membership + permission at the service layer — frontend checks are UX only.
 */
export function requireWorkspace(permission: Permission) {
  return async function requireWorkspaceMiddleware(req: Request, _res: Response, next: NextFunction): Promise<void> {
    try {
      if (!req.user) throw unauthorized();
      const workspaceId = (req.header('x-workspace-id') || req.query.workspaceId || '') as string;
      if (!workspaceId) throw forbidden('No workspace selected.');
      const membership = await prisma.membership.findUnique({
        where: { userId_workspaceId: { userId: req.user.id, workspaceId } },
      });
      if (!membership) throw forbidden('You are not a member of this workspace.');
      if (!hasPermission(membership.role as Role, permission)) {
        throw forbidden(`Your role (${membership.role}) lacks the "${permission}" permission.`);
      }
      (req as Request & { workspaceId: string; role: Role }).workspaceId = workspaceId;
      (req as Request & { role: Role }).role = membership.role as Role;
      next();
    } catch (err) { next(err); }
  };
}

/** Optional auth for public endpoints that personalize when logged in. */
export async function optionalAuth(req: Request, _res: Response, next: NextFunction): Promise<void> {
  try { req.user = (await loadSession(req)) ?? undefined; } catch { /* ignore */ }
  next();
}
