import { prisma } from '@flowforge/database';
import { hashPassword, verifyPassword, sha256, randomToken } from '../lib/crypto.js';
import { badRequest, conflict, unauthorized, notFound } from '../lib/http.js';
import { logger } from '../lib/logger.js';
import type { RegisterInput } from '@flowforge/shared';

const SESSION_TTL_MS = 30 * 864e5; // 30 days

export interface PublicUser { id: string; email: string; name: string; emailVerified: boolean; createdAt: string; }

function toPublic(u: { id: string; email: string; name: string; emailVerifiedAt: Date | null; createdAt: Date }): PublicUser {
  return { id: u.id, email: u.email, name: u.name, emailVerified: !!u.emailVerifiedAt, createdAt: u.createdAt.toISOString() };
}

/** Email delivery adapter — mock in dev (logs the link), swappable for SES/SendGrid/Supabase. */
export async function sendEmailMessage(to: string, subject: string, body: string): Promise<void> {
  logger.info('email_queued', { to, subject, body: body.slice(0, 120) });
}

export async function register(input: RegisterInput): Promise<{ user: PublicUser; sessionToken: string }> {
  const email = input.email.toLowerCase();
  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) throw conflict('An account with this email already exists.');
  const verificationToken = randomToken(16);
  const user = await prisma.user.create({
    data: { email, name: input.name.trim(), passwordHash: hashPassword(input.password), verificationToken },
  });
  const slugBase = input.organizationName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'workspace';
  const org = await prisma.organization.create({ data: { name: input.organizationName, slug: `${slugBase}-${user.id.slice(0, 8)}`, plan: 'free' } });
  const ws = await prisma.workspace.create({ data: { organizationId: org.id, name: `${input.organizationName} Workspace`, slug: `${org.slug}-main` } });
  await prisma.membership.create({ data: { userId: user.id, workspaceId: ws.id, organizationId: org.id, role: 'owner' } });
  await prisma.subscription.create({ data: { organizationId: org.id, plan: 'free', provider: 'mock' } });
  await sendEmailMessage(email, 'Verify your FlowForge email', `Confirm here: /verify-email?token=${verificationToken}`);
  const sessionToken = await createSession(user.id);
  logger.info('auth.registered', { userId: user.id });
  return { user: toPublic(user), sessionToken };
}

export async function login(email: string, password: string): Promise<{ user: PublicUser; sessionToken: string }> {
  const user = await prisma.user.findUnique({ where: { email: email.toLowerCase() } });
  if (!user || !verifyPassword(password, user.passwordHash)) {
    logger.warn('auth.login_failed', { email });
    throw unauthorized('Invalid email or password.');
  }
  const sessionToken = await createSession(user.id);
  logger.info('auth.logged_in', { userId: user.id });
  return { user: toPublic(user), sessionToken };
}

export async function createSession(userId: string): Promise<string> {
  const raw = `ff-${randomToken(32)}`;
  await prisma.session.create({ data: { userId, token: sha256(raw), expiresAt: new Date(Date.now() + SESSION_TTL_MS) } });
  return raw;
}

export async function logout(token?: string): Promise<void> {
  if (token) await prisma.session.deleteMany({ where: { token: sha256(token) } });
}

export async function getSessionUser(token: string | undefined): Promise<PublicUser | null> {
  if (!token) return null;
  const session = await prisma.session.findUnique({ where: { token: sha256(token) }, include: { user: true } });
  if (!session || session.expiresAt < new Date()) return null;
  return toPublic(session.user);
}

export async function verifyEmail(token: string): Promise<{ verified: boolean }> {
  const user = await prisma.user.findFirst({ where: { verificationToken: token } });
  if (!user) throw notFound('Verification link');
  await prisma.user.update({ where: { id: user.id }, data: { emailVerifiedAt: new Date(), verificationToken: null } });
  return { verified: true };
}

export async function forgotPassword(email: string): Promise<{ sent: boolean }> {
  const user = await prisma.user.findUnique({ where: { email: email.toLowerCase() } });
  if (user) {
    const token = randomToken(24);
    await prisma.user.update({ where: { id: user.id }, data: { resetToken: token, resetTokenExpires: new Date(Date.now() + 3600_000) } });
    await sendEmailMessage(user.email, 'Reset your FlowForge password', `Reset link: /reset-password?token=${token}`);
  }
  // identical response whether or not the account exists (no user enumeration)
  return { sent: true };
}

export async function resetPassword(token: string, password: string): Promise<void> {
  const user = await prisma.user.findFirst({ where: { resetToken: token, resetTokenExpires: { gt: new Date() } } });
  if (!user) throw badRequest('INVALID_RESET_TOKEN', 'This reset link is invalid or has expired.');
  await prisma.user.update({ where: { id: user.id }, data: { passwordHash: hashPassword(password), resetToken: null, resetTokenExpires: null } });
  await prisma.session.deleteMany({ where: { userId: user.id } }); // kill all sessions
  logger.info('auth.password_reset', { userId: user.id });
}

export async function updateProfile(userId: string, input: { name?: string; email?: string }): Promise<PublicUser> {
  const user = await prisma.user.update({ where: { id: userId }, data: { ...(input.name ? { name: input.name } : {}), ...(input.email ? { email: input.email.toLowerCase() } : {}) } });
  return toPublic(user);
}
