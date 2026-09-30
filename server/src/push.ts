/**
 * Android app push notifications through Firebase Cloud Messaging (HTTP v1 API).
 *
 * The head of household pastes a Firebase service-account key (server side) plus the Android app's
 * ID and API key (sent to the app so it can register for push without a google-services.json).
 * Messages are data-only, so the app builds the notification itself (with Approve / Not yet buttons).
 */
import crypto from 'crypto';
import { Router } from 'express';
import { z } from 'zod';
import type { UserRow } from './auth';
import { q } from './db';
import { cameraEvents } from './protect';
import { getSetting, onSettingsChange } from './settings';
import { HttpError, parse } from './util';

interface ServiceAccount {
  project_id: string;
  client_email: string;
  private_key: string;
  token_uri?: string;
}

function serviceAccount(): ServiceAccount | null {
  const raw = getSetting('fcmServiceAccount');
  if (!raw) return null;
  try {
    const j = JSON.parse(raw);
    return j.client_email && j.private_key && j.project_id ? j : null;
  } catch {
    return null;
  }
}

export function pushConfig() {
  const sa = serviceAccount();
  const appId = getSetting('fcmAndroidAppId').trim();
  const apiKey = getSetting('fcmApiKey').trim();
  const senderId = appId.split(':')[1] ?? '';
  const enabled = !!sa && !!appId && !!apiKey && !!senderId;
  return { enabled, projectId: sa?.project_id ?? '', appId, apiKey, senderId };
}

let access: { token: string; exp: number; key: string } | null = null;
onSettingsChange(() => (access = null));

async function accessToken(sa: ServiceAccount): Promise<string> {
  const key = sa.client_email;
  if (access && access.key === key && access.exp > Date.now() + 60_000) return access.token;
  const now = Math.floor(Date.now() / 1000);
  const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const tokenUri = sa.token_uri || 'https://oauth2.googleapis.com/token';
  const unsigned = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({
    iss: sa.client_email,
    scope: 'https://www.googleapis.com/auth/firebase.messaging',
    aud: tokenUri,
    iat: now,
    exp: now + 3600,
  })}`;
  const sig = crypto.createSign('RSA-SHA256').update(unsigned).sign(sa.private_key, 'base64url');
  const r = await fetch(tokenUri, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${unsigned}.${sig}` }),
    signal: AbortSignal.timeout(10_000),
  });
  const j: any = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) throw new Error(`Google sign-in for Firebase failed: ${j.error_description ?? j.error ?? r.status}`);
  access = { token: j.access_token, exp: Date.now() + (j.expires_in ?? 3600) * 1000, key };
  return j.access_token;
}

/** Send a data message to every registered device of these users. Returns how many were delivered. */
export async function pushToUsers(userIds: string[], data: Record<string, string>): Promise<{ sent: number; failed: number; error?: string }> {
  const sa = serviceAccount();
  if (!sa || !pushConfig().enabled || !userIds.length) return { sent: 0, failed: 0 };
  const rows = await q<{ token: string }>('select token from push_tokens where user_id = any($1::uuid[])', [userIds]);
  if (!rows.length) return { sent: 0, failed: 0 };
  let bearer: string;
  try {
    bearer = await accessToken(sa);
  } catch (e: any) {
    return { sent: 0, failed: rows.length, error: e.message };
  }
  let sent = 0;
  let failed = 0;
  let error: string | undefined;
  await Promise.all(
    rows.map(async ({ token }) => {
      try {
        const r = await fetch(`https://fcm.googleapis.com/v1/projects/${sa.project_id}/messages:send`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ message: { token, data, android: { priority: 'HIGH', ttl: '3600s' } } }),
          signal: AbortSignal.timeout(10_000),
        });
        if (r.ok) return void sent++;
        const j: any = await r.json().catch(() => ({}));
        const code = JSON.stringify(j.error?.details ?? '') + (j.error?.status ?? '');
        if (r.status === 404 || /UNREGISTERED|INVALID_ARGUMENT/.test(code)) {
          await q('delete from push_tokens where token = $1', [token]); // app uninstalled or token rotated
        }
        failed++;
        error = j.error?.message ?? `HTTP ${r.status}`;
      } catch (e: any) {
        failed++;
        error = e.message;
      }
    }),
  );
  return { sent, failed, error };
}

// ---- Routes (mounted at /api/push behind requireAuth) ----
export const pushRouter = Router();

/** What the Android app needs to register for push (the API key and app ID are not secrets). */
pushRouter.get('/config', (_req, res) => {
  const c = pushConfig();
  res.json(c.enabled ? c : { enabled: false });
});

pushRouter.post('/register', async (req, res) => {
  if (req.device) throw new HttpError(400, 'Kiosk screens do not receive push notifications');
  const b = parse(z.object({ token: z.string().min(20).max(4096), platform: z.enum(['android']).default('android'), name: z.string().max(100).optional() }), req.body);
  await q(
    `insert into push_tokens (token, user_id, platform, device_name, session_id) values ($1, $2, $3, $4, $5)
     on conflict (token) do update set user_id = excluded.user_id, device_name = excluded.device_name, session_id = excluded.session_id, last_seen = now()`,
    [b.token, req.user!.id, b.platform, b.name ?? null, req.sessionID],
  );
  res.json({ ok: true });
});

pushRouter.post('/unregister', async (req, res) => {
  const b = parse(z.object({ token: z.string().min(20).max(4096) }), req.body);
  await q('delete from push_tokens where token = $1 and user_id = $2', [b.token, req.user!.id]);
  res.json({ ok: true });
});

/** Forget this browser session's devices when someone signs out of the app. */
export async function forgetSessionPush(sessionId: string) {
  await q('delete from push_tokens where session_id = $1', [sessionId]).catch(() => {});
}

// ---- Doorbell: ring every signed-in phone that wants doorbell alerts ----
const lastRing = new Map<string, number>();
export function startDoorbellPush(cameraName: (id: string) => Promise<string>) {
  cameraEvents.on('ring', async ({ cameraId }: { cameraId: string }) => {
    if (!pushConfig().enabled || !getSetting('doorbellPopupEnabled')) return;
    if (Date.now() - (lastRing.get(cameraId) ?? 0) < 30_000) return;
    lastRing.set(cameraId, Date.now());
    const users = await q<UserRow>(`select * from users where can_login and coalesce((prefs->>'doorbellPopup')::boolean, true)`);
    const name = await cameraName(cameraId).catch(() => 'Doorbell');
    await pushToUsers(
      users.map((u) => u.id),
      { type: 'doorbell', title: "🔔 Someone's at the door", body: name, cameraId },
    );
  });
}
