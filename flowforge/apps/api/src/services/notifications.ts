import { prisma } from '@flowforge/database';

export interface NotifyInput { type: string; title: string; body: string; link?: string; userId?: string; }

/** Fan out a notification to workspace members (or one user). */
export async function notifyWorkspace(workspaceId: string, input: NotifyInput): Promise<{ id: string }> {
  const n = await prisma.notification.create({
    data: { workspaceId, userId: input.userId ?? null, type: input.type, title: input.title, body: input.body, link: input.link ?? null },
  });
  return { id: n.id };
}

export async function listNotifications(userId: string, workspaceId: string) {
  return prisma.notification.findMany({
    where: { workspaceId, OR: [{ userId }, { userId: null }] },
    orderBy: { createdAt: 'desc' }, take: 50,
  });
}

export async function markRead(userId: string, ids?: string[]): Promise<void> {
  await prisma.notification.updateMany({
    where: { OR: ids && ids.length > 0 ? [{ id: { in: ids } }] : [], readAt: null },
    data: { readAt: new Date() },
  });
}
