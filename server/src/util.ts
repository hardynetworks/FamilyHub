import crypto from 'crypto';
import type { NextFunction, Request, Response } from 'express';
import { z, ZodTypeAny } from 'zod';
import { config } from './config';
import { encryptionKey, isProd } from './env';

export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export function parse<S extends ZodTypeAny>(schema: S, data: unknown): z.infer<S> {
  const r = schema.safeParse(data);
  if (!r.success) {
    const issue = r.error.issues[0];
    throw new HttpError(400, `${issue.path.join('.') || 'body'}: ${issue.message}`);
  }
  return r.data;
}

export function errorHandler(err: any, _req: Request, res: Response, _next: NextFunction) {
  let status = err instanceof HttpError ? err.status : typeof err.status === 'number' ? err.status : 500;
  let message = err.message;
  if (err.code === '23505') {
    status = 409;
    message = 'That already exists (duplicate value)';
  } else if (err.code === '22P02') {
    status = 400;
    message = 'Invalid id';
  }
  if (status >= 500) console.error(err);
  res.status(status).json({ error: status >= 500 && isProd ? 'Internal server error' : message });
}

// ---------- Encryption for stored tokens (AES-256-GCM) ----------
const key = crypto.createHash('sha256').update(encryptionKey).digest();

export function encrypt(plain: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv, tag, enc].map((b) => b.toString('base64url')).join('.');
}

export function decrypt(payload: string): string {
  const [iv, tag, enc] = payload.split('.').map((s) => Buffer.from(s, 'base64url'));
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
}

export function randomToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString('base64url');
}

export function decodeJwtPayload(jwt: string): any {
  const part = jwt.split('.')[1];
  if (!part) return {};
  return JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
}

// ---------- Time zone helpers (no external deps) ----------
const dtfCache = new Map<string, Intl.DateTimeFormat>();
function dtf(tz: string) {
  let f = dtfCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    dtfCache.set(tz, f);
  }
  return f;
}

/** Offset (ms) of the zone from UTC at the given instant. */
export function tzOffsetMs(date: Date, tz: string): number {
  const parts = dtf(tz).formatToParts(date);
  const get = (t: string) => Number(parts.find((p) => p.type === t)!.value);
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  return asUtc - Math.floor(date.getTime() / 1000) * 1000;
}

/** Real instant -> "wall clock" Date whose UTC fields equal the local wall time in tz. */
export function utcToWall(d: Date, tz: string): Date {
  return new Date(d.getTime() + tzOffsetMs(d, tz));
}

/** "Wall clock" Date (UTC fields = local time in tz) -> real instant. */
export function wallToUtc(wall: Date, tz: string): Date {
  const guess = wall.getTime() - tzOffsetMs(wall, tz);
  const off = tzOffsetMs(new Date(guess), tz);
  return new Date(wall.getTime() - off);
}

/** Today's date (YYYY-MM-DD) in the household time zone. */
export function todayInTz(tz?: string): string {
  tz = tz ?? config.timezone;
  return utcToWall(new Date(), tz).toISOString().slice(0, 10);
}

export const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD');

export function addDays(date: string, n: number): string {
  const d = new Date(date + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
