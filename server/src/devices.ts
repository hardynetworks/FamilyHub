/**
 * Kiosk screens (wall tablets, Raspberry Pi displays, ...).
 *
 * A head of household adds a screen in Settings and gets a one-time pairing code. Opening
 * /kiosk on the screen and entering the code stores a long-lived device token in an
 * httpOnly cookie, so the screen stays signed in (as the family member it's linked to)
 * without anyone's password being saved on it. Removing the screen revokes the token.
 */
import crypto from 'crypto';
import type { Request } from 'express';
import { q } from './db';

export const DEVICE_COOKIE = 'familyhub.device';
export const PAIR_CODE_MINUTES = 30;
export const KIOSK_PAGES = ['calendar', 'lists', 'chores', 'meals'] as const;
export type KioskPage = (typeof KIOSK_PAGES)[number];

export interface DeviceOptions {
  /** Pages people can open on the screen besides Home. */
  pages: KioskPage[];
  /** Go back to Home after this many seconds without a touch (0 = never). */
  returnHomeSeconds: number;
  /** Hide the mouse pointer (touch-screen Raspberry Pi setups). */
  hideCursor: boolean;
  /** Reload the page once a night to keep long-running browsers healthy. */
  reloadNightly: boolean;
  /** Family group this screen shows (null = the whole family). Switchable on the screen with the PIN. */
  groupId: string | null;
}

export interface DeviceRow {
  id: string;
  name: string;
  user_id: string;
  token_hash: string | null;
  pair_code_hash: string | null;
  pair_expires: Date | null;
  options: Partial<DeviceOptions> | null;
  created_by: string | null;
  created_at: Date;
  paired_at: Date | null;
  last_seen: Date | null;
  last_ip: string | null;
  user_agent: string | null;
}

export const DEFAULT_DEVICE_OPTIONS: DeviceOptions = {
  pages: [...KIOSK_PAGES],
  returnHomeSeconds: 120,
  hideCursor: false,
  reloadNightly: true,
  groupId: null,
};

export function deviceOptions(d: Pick<DeviceRow, 'options'>): DeviceOptions {
  const o = d.options ?? {};
  return {
    pages: Array.isArray(o.pages) ? o.pages.filter((p): p is KioskPage => (KIOSK_PAGES as readonly string[]).includes(p)) : DEFAULT_DEVICE_OPTIONS.pages,
    returnHomeSeconds: typeof o.returnHomeSeconds === 'number' ? o.returnHomeSeconds : DEFAULT_DEVICE_OPTIONS.returnHomeSeconds,
    hideCursor: typeof o.hideCursor === 'boolean' ? o.hideCursor : DEFAULT_DEVICE_OPTIONS.hideCursor,
    reloadNightly: typeof o.reloadNightly === 'boolean' ? o.reloadNightly : DEFAULT_DEVICE_OPTIONS.reloadNightly,
    groupId: typeof o.groupId === 'string' && o.groupId ? o.groupId : null,
  };
}

export const hashToken = (t: string) => crypto.createHash('sha256').update(t).digest('hex');

/** Pairing codes avoid look-alike characters (0/O, 1/I/L). Shown as XXXX-XXXX. */
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export function newPairCode(): string {
  const bytes = crypto.randomBytes(8);
  let s = '';
  for (const b of bytes) s += CODE_ALPHABET[b % CODE_ALPHABET.length];
  return `${s.slice(0, 4)}-${s.slice(4)}`;
}
export const normalizeCode = (c: string) => c.toUpperCase().replace(/[^A-Z0-9]/g, '');

export function readCookie(req: Request, name: string): string | null {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) {
      try {
        return decodeURIComponent(part.slice(i + 1).trim());
      } catch {
        return null;
      }
    }
  }
  return null;
}

/** Record that a screen is alive (at most every few minutes per screen). */
const lastTouch = new Map<string, number>();
export function touchDevice(req: Request, d: DeviceRow) {
  const now = Date.now();
  if ((lastTouch.get(d.id) ?? 0) > now - 3 * 60_000) return;
  lastTouch.set(d.id, now);
  q('update devices set last_seen = now(), last_ip = $2, user_agent = $3 where id = $1', [d.id, req.ip ?? null, String(req.headers['user-agent'] ?? '').slice(0, 300)]).catch(
    () => {},
  );
}

export function publicDevice(d: DeviceRow) {
  return {
    id: d.id,
    name: d.name,
    userId: d.user_id,
    options: deviceOptions(d),
    paired: !!d.token_hash,
    pairingOpen: !!d.pair_code_hash && !!d.pair_expires && d.pair_expires.getTime() > Date.now(),
    pairExpires: d.pair_expires,
    pairedAt: d.paired_at,
    lastSeen: d.last_seen,
    lastIp: d.last_ip,
    userAgent: d.user_agent,
    createdAt: d.created_at,
  };
}

/** Changes every time the server starts, so kiosk screens reload themselves after an update. */
export const BOOT_ID = Date.now().toString(36);
