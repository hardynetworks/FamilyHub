import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import { NextFunction, Request, Response, Router } from 'express';
import { z } from 'zod';
import { baseUrl, config, isValidTimezone } from './config';
import { getSetting, isLockedByEnv, onSettingsChange, saveSettings } from './settings';
import { one, q } from './db';
import { forgetSessionPush } from './push';
import { BOOT_ID, DEVICE_COOKIE, DeviceRow, deviceOptions, hashToken, readCookie, touchDevice } from './devices';
import { HttpError, decodeJwtPayload, parse, randomToken } from './util';

export interface UserRow {
  id: string;
  name: string;
  email: string | null;
  password_hash: string | null;
  oidc_sub: string | null;
  role: 'admin' | 'member';
  color: string;
  avatar: string | null;
  can_login: boolean;
  member_type: 'adult' | 'child';
  prefs: { slideshowEnabled?: boolean; slideshowIdleMinutes?: number; camerasMode?: string; doorbellPopup?: boolean; notifyEmail?: boolean; notifyText?: string; remindPush?: boolean; remindEmail?: boolean } | null;
  created_at: Date;
}

declare module 'express-session' {
  interface SessionData {
    userId?: string;
    /** Set when this session belongs to a paired kiosk screen. */
    deviceId?: string;
    oidc?: { state: string; nonce: string; verifier: string };
    googleState?: string;
  }
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: UserRow;
      /** The kiosk screen making this request, if any. */
      device?: DeviceRow;
      /** The family group this kiosk screen shows (looked up once per request). */
      groupCache?: unknown;
    }
  }
}

export const MEMBER_COLORS = ['#5b7cfa', '#f06a6a', '#2bb673', '#f5a623', '#a65bfa', '#1fb5c9', '#ec5fa8', '#8a6d3b'];

export function publicUser(u: UserRow) {
  return {
    id: u.id,
    name: u.name,
    email: u.email,
    role: u.role,
    color: u.color,
    avatar: u.avatar,
    canLogin: u.can_login,
    memberType: u.member_type ?? 'adult',
    hasPassword: !!u.password_hash,
    linkedSso: !!u.oidc_sub,
    prefs: {
      slideshowEnabled: u.prefs?.slideshowEnabled ?? true,
      slideshowIdleMinutes: u.prefs?.slideshowIdleMinutes ?? 1,
      camerasMode: u.prefs?.camerasMode ?? 'default',
      doorbellPopup: u.prefs?.doorbellPopup ?? true,
      notifyEmail: u.prefs?.notifyEmail ?? true,
      notifyText: u.prefs?.notifyText ?? '',
      remindPush: u.prefs?.remindPush ?? true,
      remindEmail: u.prefs?.remindEmail ?? true,
    },
  };
}

export async function loadUser(req: Request, res: Response, next: NextFunction) {
  // Kiosk screen: the session is tied to a device that must still exist and be paired.
  if (req.session.deviceId) {
    const d = await one<DeviceRow>('select * from devices where id = $1 and token_hash is not null', [req.session.deviceId]);
    if (d) {
      req.device = d;
      req.session.userId = d.user_id; // follows the member the screen is linked to, even if it changes
    } else {
      delete req.session.deviceId;
      delete req.session.userId;
    }
  }
  // No session (expired, or the server's sessions were cleared): sign a paired screen back in from its device cookie.
  if (!req.session.userId) {
    const token = readCookie(req, DEVICE_COOKIE);
    if (token) {
      const d = await one<DeviceRow>('select * from devices where token_hash = $1', [hashToken(token)]);
      if (d) {
        req.device = d;
        req.session.deviceId = d.id;
        req.session.userId = d.user_id;
      } else {
        res.clearCookie(DEVICE_COOKIE, { path: '/' });
      }
    }
  }
  if (req.session.userId) {
    const u = await one<UserRow>('select * from users where id = $1', [req.session.userId]);
    // A screen may be linked to a profile that can't sign in itself (e.g. "Kitchen screen").
    // Kiosk screens never get head-of-household powers, whoever they are linked to.
    if (u && req.device) req.user = { ...u, role: 'member' };
    else if (u && u.can_login) req.user = u;
    else {
      delete req.session.userId;
      delete req.session.deviceId;
      req.device = undefined;
    }
  }
  if (req.device) touchDevice(req, req.device);
  next();
}

export function requireAuth(req: Request, _res: Response, next: NextFunction) {
  if (!req.user) throw new HttpError(401, 'Not signed in');
  next();
}

export function requireAdmin(req: Request, _res: Response, next: NextFunction) {
  if (!req.user) throw new HttpError(401, 'Not signed in');
  if (req.device) throw new HttpError(403, 'Not available on a kiosk screen');
  if (req.user.role !== 'admin') throw new HttpError(403, 'Admins only');
  next();
}

async function userCount(): Promise<number> {
  const r = await one<{ n: string }>('select count(*)::text as n from users');
  return Number(r?.n ?? 0);
}

async function nextColor(): Promise<string> {
  const n = await userCount();
  return MEMBER_COLORS[n % MEMBER_COLORS.length];
}

export function login(req: Request, userId: string, deviceId?: string): Promise<void> {
  return new Promise((resolve, reject) => {
    req.session.regenerate((err) => {
      if (err) return reject(err);
      req.session.userId = userId;
      if (deviceId) req.session.deviceId = deviceId;
      req.session.save((e) => (e ? reject(e) : resolve()));
    });
  });
}

// ---- Simple in-memory login rate limiter ----
const attempts = new Map<string, { n: number; reset: number }>();
export function rateLimit(key: string) {
  const now = Date.now();
  const a = attempts.get(key);
  if (!a || a.reset < now) {
    attempts.set(key, { n: 1, reset: now + 15 * 60_000 });
    return;
  }
  a.n++;
  if (a.n > 10) throw new HttpError(429, 'Too many attempts. Try again in a few minutes.');
}

// ---- OIDC (Authentik) ----
let discoveryCache: { at: number; issuer: string; doc: any } | null = null;
onSettingsChange(() => (discoveryCache = null));
/** Fetch an OIDC discovery document (also used by the admin "Test connection" button). */
export async function fetchDiscovery(issuer: string): Promise<any> {
  const base = issuer.endsWith('/') ? issuer : issuer + '/';
  let r: globalThis.Response;
  try {
    r = await fetch(base + '.well-known/openid-configuration', { signal: AbortSignal.timeout(8000) });
  } catch (e: any) {
    throw new HttpError(502, `Could not reach ${base} (${e.cause?.code ?? e.message})`);
  }
  if (!r.ok) throw new HttpError(502, `OIDC discovery failed: ${base}.well-known/openid-configuration returned ${r.status}`);
  const doc: any = await r.json().catch(() => null);
  if (!doc?.authorization_endpoint || !doc?.token_endpoint) throw new HttpError(502, 'That URL did not return a valid OpenID configuration');
  return doc;
}

async function discovery(): Promise<any> {
  const issuer = config.oidc.issuer;
  if (discoveryCache && discoveryCache.issuer === issuer && Date.now() - discoveryCache.at < 3600_000) return discoveryCache.doc;
  const doc = await fetchDiscovery(issuer);
  discoveryCache = { at: Date.now(), issuer, doc };
  return doc;
}

export const oidcRedirectUri = (req: Request) => `${baseUrl(req)}/api/auth/oidc/callback`;

export const authRouter = Router();

authRouter.get('/status', async (req, res) => {
  const count = await userCount();
  res.json({
    appName: config.appName,
    familyName: getSetting('familyName'),
    user: req.user ? publicUser(req.user) : null,
    needsSetup: count === 0,
    localLogin: config.localLogin,
    oidc: { enabled: config.oidc.enabled, label: config.oidc.label },
    google: { enabled: config.google.enabled },
    timezone: config.timezone,
    version: BOOT_ID,
    device: req.device ? { id: req.device.id, name: req.device.name, options: deviceOptions(req.device), group: await screenGroup(req) } : null,
    kioskPinSet: !!getSetting('kioskPinHash'),
  });
});

/** Name and colour of the family group a kiosk screen shows. */
async function screenGroup(req: Request) {
  const id = req.device ? deviceOptions(req.device).groupId : null;
  if (!id) return null;
  return (await one<{ id: string; name: string; emoji: string | null; color: string }>('select id, name, emoji, color from family_groups where id = $1', [id])) ?? null;
}

authRouter.post('/setup', async (req, res) => {
  if (!config.localLogin) throw new HttpError(400, 'Local login is disabled; sign in with SSO to become the first admin.');
  const body = parse(
    z.object({
      name: z.string().min(1).max(100),
      email: z.string().email(),
      password: z.string().min(8).max(200),
      appName: z.string().trim().max(60).optional(),
      familyName: z.string().trim().max(80).optional(),
      appUrl: z.string().url().max(300).optional(),
      timezone: z.string().max(80).optional(),
    }),
    req.body,
  );
  if ((await userCount()) > 0) throw new HttpError(409, 'Setup already completed');
  // First-run wizard also records the basics so nothing needs to be edited in files.
  await saveSettings({
    appName: body.appName && !isLockedByEnv('appName') ? body.appName : undefined,
    familyName: body.familyName && !isLockedByEnv('familyName') ? body.familyName : undefined,
    appUrl: body.appUrl && !isLockedByEnv('appUrl') && !getSetting('appUrl') ? body.appUrl.replace(/\/+$/, '') : undefined,
    timezone: body.timezone && isValidTimezone(body.timezone) && !isLockedByEnv('timezone') ? body.timezone : undefined,
  });
  const hash = await bcrypt.hash(body.password, 12);
  const u = await one<UserRow>(
    `insert into users (name, email, password_hash, role, color, avatar) values ($1, $2, $3, 'admin', $4, '🏠') returning *`,
    [body.name, body.email.toLowerCase(), hash, MEMBER_COLORS[0]],
  );
  await login(req, u!.id);
  res.json({ user: publicUser(u!) });
});

authRouter.post('/login', async (req, res) => {
  if (!config.localLogin) throw new HttpError(400, 'Local login is disabled');
  rateLimit(`login:${req.ip}`);
  const body = parse(z.object({ email: z.string().min(1), password: z.string().min(1) }), req.body);
  const u = await one<UserRow>('select * from users where lower(email) = lower($1)', [body.email.trim()]);
  const ok = !!u && !!u.password_hash && u.can_login && (await bcrypt.compare(body.password, u.password_hash));
  if (!ok) throw new HttpError(401, 'Invalid email or password');
  await login(req, u!.id);
  res.json({ user: publicUser(u!) });
});

authRouter.post('/logout', (req, res) => {
  if (req.device) throw new HttpError(403, 'This is a kiosk screen. Use the kiosk menu (with the PIN) to sign it out.');
  void forgetSessionPush(req.sessionID);
  req.session.destroy(() => {
    res.clearCookie('familyhub.sid');
    res.json({ ok: true });
  });
});

authRouter.get('/oidc/login', async (req, res) => {
  if (!config.oidc.enabled) throw new HttpError(404, 'SSO is not configured');
  const d = await discovery();
  const state = randomToken(16);
  const nonce = randomToken(16);
  const verifier = randomToken(48);
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  req.session.oidc = { state, nonce, verifier };
  const url = new URL(d.authorization_endpoint);
  url.search = new URLSearchParams({
    response_type: 'code',
    client_id: config.oidc.clientId,
    redirect_uri: oidcRedirectUri(req),
    scope: config.oidc.scopes,
    state,
    nonce,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  }).toString();
  req.session.save(() => res.redirect(url.toString()));
});

authRouter.get('/oidc/callback', async (req, res) => {
  const fail = (msg: string) => res.redirect(`/login?error=${encodeURIComponent(msg)}`);
  const pending = req.session.oidc;
  delete req.session.oidc;
  if (req.query.error) return fail(String(req.query.error_description ?? req.query.error));
  if (!pending || req.query.state !== pending.state) return fail('Login session expired, please try again.');
  const code = String(req.query.code ?? '');
  if (!code) return fail('Missing authorization code');

  const d = await discovery();
  const tokenRes = await fetch(d.token_endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: oidcRedirectUri(req),
      client_id: config.oidc.clientId,
      client_secret: config.oidc.clientSecret,
      code_verifier: pending.verifier,
    }),
  });
  const tokens: any = await tokenRes.json().catch(() => ({}));
  if (!tokenRes.ok || !tokens.access_token) return fail(tokens.error_description ?? 'Token exchange failed');

  // The ID token comes straight from the token endpoint over TLS, so we only check nonce/audience here.
  if (tokens.id_token) {
    const idt = decodeJwtPayload(tokens.id_token);
    const aud = Array.isArray(idt.aud) ? idt.aud : [idt.aud];
    if (idt.nonce !== pending.nonce || !aud.includes(config.oidc.clientId)) return fail('ID token validation failed');
  }

  const infoRes = await fetch(d.userinfo_endpoint, { headers: { Authorization: `Bearer ${tokens.access_token}` } });
  if (!infoRes.ok) return fail('Could not load user info');
  const info: any = await infoRes.json();
  const sub = String(info.sub);
  const email: string | null = info.email ? String(info.email).toLowerCase() : null;
  const name: string = info.name || info.preferred_username || email || 'Family member';
  const groups: string[] = Array.isArray(info.groups) ? info.groups : [];
  const isAdminByGroup = config.oidc.adminGroup ? groups.includes(config.oidc.adminGroup) : null;

  let u = await one<UserRow>('select * from users where oidc_sub = $1', [sub]);
  if (!u && email) {
    u = await one<UserRow>('update users set oidc_sub = $1 where lower(email) = $2 and oidc_sub is null returning *', [sub, email]);
  }
  if (!u) {
    const first = (await userCount()) === 0;
    if (!first && !config.oidc.autoCreate) return fail('Your account has not been added to this family yet. Ask an admin to add your email.');
    const role = first || isAdminByGroup ? 'admin' : 'member';
    u = await one<UserRow>(
      `insert into users (name, email, oidc_sub, role, color) values ($1, $2, $3, $4, $5) returning *`,
      [name, email, sub, role, await nextColor()],
    );
  } else if (isAdminByGroup !== null) {
    u = await one<UserRow>('update users set role = $2 where id = $1 returning *', [u.id, isAdminByGroup ? 'admin' : 'member']);
  }
  if (!u!.can_login) return fail('This profile is not allowed to sign in.');
  await login(req, u!.id);
  res.redirect('/');
});
