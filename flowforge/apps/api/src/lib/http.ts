// Centralized error handling + response helpers. Raw errors never leak to clients.
import type { Response } from 'express';
import { ZodError } from 'zod';
import { logger } from './logger.js';

export class AppError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    readonly details?: unknown[],
  ) { super(message); }
}

export const badRequest = (code: string, message: string, details?: unknown[]) => new AppError(400, code, message, details);
export const unauthorized = (message = 'Authentication required.') => new AppError(401, 'UNAUTHENTICATED', message);
export const forbidden = (message = 'You do not have permission to perform this action.') => new AppError(403, 'FORBIDDEN', message);
export const notFound = (what = 'Resource') => new AppError(404, 'NOT_FOUND', `${what} not found.`);
export const conflict = (message: string) => new AppError(409, 'CONFLICT', message);

export function ok(res: Response, data: unknown, status = 200): void {
  res.status(status).json({ success: true, data });
}
export function created(res: Response, data: unknown): void { ok(res, data, 201); }

export function failFromError(res: Response, err: unknown): void {
  if (err instanceof ZodError) {
    res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'The request contains invalid fields.', details: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) } });
    return;
  }
  if (err instanceof AppError) {
    res.status(err.statusCode).json({ success: false, error: { code: err.code, message: err.message, details: err.details ?? [] } });
    return;
  }
  // unexpected → log full detail server-side, generic message to client
  logger.error('Unhandled API error', { error: err instanceof Error ? err.stack ?? err.message : String(err) });
  res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred. Please try again.' } });
}
