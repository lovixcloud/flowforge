import type { NextFunction, Request, Response } from 'express';
import { randomUUID } from 'node:crypto';
import { logger } from '../lib/logger.js';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request { requestId: string; }
  }
}

/** Assigns a request id, echoes it back, and logs completion. */
export function requestContext(req: Request, res: Response, next: NextFunction): void {
  const requestId = (req.headers['x-request-id'] as string) || randomUUID();
  req.requestId = requestId;
  res.setHeader('x-request-id', requestId);
  const start = Date.now();
  res.on('finish', () => {
    logger.info('http_request', { requestId, method: req.method, path: req.path, status: res.statusCode, durationMs: Date.now() - start, ip: req.ip });
  });
  next();
}
