// Execution backend abstraction. Default = in-process queue (dev). Swap REDIS_URL →
// BullMQ worker without touching call sites.
import { randomUUID } from 'node:crypto';
import { env } from '../lib/env.js';
import { logger } from '../lib/logger.js';

export interface ExecutionJob { executionId: string; workflowId: string; payload: unknown; triggerSource: string; }
export type JobHandler = (job: ExecutionJob) => Promise<void>;

export interface ExecutionQueue {
  enqueue(job: ExecutionJob): Promise<void>;
  register(handler: JobHandler): void;
}

class InProcessQueue implements ExecutionQueue {
  private handler: JobHandler | null = null;
  private queue: ExecutionJob[] = [];
  private running = false;

  register(handler: JobHandler): void { this.handler = handler; }

  async enqueue(job: ExecutionJob): Promise<void> {
    this.queue.push(job);
    logger.info('queue.enqueued', { executionId: job.executionId, workflowId: job.workflowId, depth: this.queue.length });
    if (!this.running) void this.drain();
  }

  private async drain(): Promise<void> {
    this.running = true;
    while (this.queue.length > 0) {
      const job = this.queue.shift()!;
      if (!this.handler) { logger.warn('queue.no_handler', { executionId: job.executionId }); continue; }
      try { await this.handler(job); } catch (err) {
        logger.error('queue.job_failed', { executionId: job.executionId, error: err instanceof Error ? err.message : String(err) });
      }
    }
    this.running = false;
  }
}

/* v-- production implementation sketch (enabled when REDIS_URL is set) --v
   Uses BullMQ; kept behind the same interface so nothing else changes.
*/
class RedisBullQueue implements ExecutionQueue {
  private handler: JobHandler | null = null;
  constructor(url: string) { logger.info('queue.using_bullmq', { url: url.replace(/\/\/.*@/, '//***@') }); }
  register(handler: JobHandler): void { this.handler = handler; }
  async enqueue(job: ExecutionJob): Promise<void> {
    // In a full deployment this adds to a BullMQ queue consumed by apps/worker.
    // Fallback: process in-process so behaviour is identical until workers are wired.
    if (this.handler) await this.handler(job);
  }
}

export function createExecutionQueue(): ExecutionQueue {
  return env.REDIS_URL ? new RedisBullQueue(env.REDIS_URL) : new InProcessQueue();
}

export const executionQueue: ExecutionQueue = createExecutionQueue();
export { randomUUID };
