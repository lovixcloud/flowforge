import type { NextFunction, Request, Response } from 'express';

interface Bucket { count: number; resetAt: number; }
const buckets = new Map<string, Bucket>();

/** In-memory fixed-window rate limiter (swap for Redis-backed store in production). */
export function rateLimit(options: { windowMs: number; max: number; key?: (req: Request) => string }) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const key = options.key?.(req) ?? `${req.ip}:${req.path.split('/')[1] ?? ''}`;
    const now = Date.now();
    let bucket = buckets.get(key);
    if (!bucket || bucket.resetAt < now) { bucket = { count: 0, resetAt: now + options.windowMs }; buckets.set(key, bucket); }
    bucket.count++;
    if (bucket.count > options.max) {
      res.setHeader('retry-after', Math.ceil((bucket.resetAt - now) / 1000));
      res.status(429).json({ success: false, error: { code: 'RATE_LIMITED', message: 'Too many requests. Please slow down.' } });
      return;
    }
    next();
  };
}

setInterval(() => { const now = Date.now(); for (const [k, b] of buckets) if (b.resetAt < now) buckets.delete(k); }, 60_000).unref();
