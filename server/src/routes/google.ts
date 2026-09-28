import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../auth';
import { baseUrl, config } from '../config';
import { one, q } from '../db';
import { ConnectionRow, exchangeCode, googleAuthUrl, refreshCalendarList, revokeToken, syncAll, syncCalendar } from '../google';
import { HttpError, decodeJwtPayload, decrypt, encrypt, parse, randomToken } from '../util';

export const googleRouter = Router();

function ensureEnabled() {
  if (!config.google.enabled) throw new HttpError(400, 'Google Calendar sync is not set up yet. An admin can add the Google client ID and secret in Settings → App settings.');
}

async function canManageConnection(userId: string, role: string, connectionId: string) {
  const c = await one<ConnectionRow>('select * from google_connections where id = $1', [connectionId]);
  if (!c) throw new HttpError(404, 'Connection not found');
  if (c.user_id !== userId && role !== 'admin') throw new HttpError(403, 'Only the owner or an admin can change this connection');
  return c;
}

googleRouter.get('/status', requireAuth, async (req, res) => {
  const conns = await q(
    `select c.id, c.google_email, c.user_id, c.last_error, u.name as user_name
     from google_connections c join users u on u.id = c.user_id order by c.created_at`,
  );
  const cals = await q(`select * from google_calendars order by is_primary desc, summary`);
  res.json({
    enabled: config.google.enabled,
    redirectUri: `${baseUrl(req)}/api/google/callback`,
    intervalMinutes: config.google.syncIntervalMinutes,
    connections: conns.map((c: any) => ({
      id: c.id,
      googleEmail: c.google_email,
      userId: c.user_id,
      userName: c.user_name,
      error: c.last_error,
      calendars: cals
        .filter((k: any) => k.connection_id === c.id)
        .map((k: any) => ({
          id: k.id,
          name: k.summary,
          color: k.background_color,
          accessRole: k.access_role,
          primary: k.is_primary,
          syncEnabled: k.sync_enabled,
          memberId: k.member_id,
          lastSyncedAt: k.last_synced_at,
          error: k.last_error,
        })),
    })),
  });
});

googleRouter.get('/connect', requireAuth, (req, res) => {
  ensureEnabled();
  const state = randomToken(16);
  req.session.googleState = state;
  req.session.save(() => res.redirect(googleAuthUrl(state, `${baseUrl(req)}/api/google/callback`)));
});

googleRouter.get('/callback', requireAuth, async (req, res) => {
  const back = (qs: string) => res.redirect(`/settings?${qs}#google`);
  if (req.query.error) return back(`googleError=${encodeURIComponent(String(req.query.error))}`);
  if (!req.session.googleState || req.query.state !== req.session.googleState) return back('googleError=state_mismatch');
  delete req.session.googleState;
  ensureEnabled();

  const tokens = await exchangeCode(String(req.query.code ?? ''), `${baseUrl(req)}/api/google/callback`);
  const email = tokens.id_token ? decodeJwtPayload(tokens.id_token).email : null;
  if (!email) return back('googleError=no_email');
  const userId = req.user!.id;

  const existing = await one<ConnectionRow>('select * from google_connections where user_id = $1 and google_email = $2', [userId, email]);
  let connId: string;
  if (existing) {
    await q(
      `update google_connections set refresh_token_enc = coalesce($2, refresh_token_enc), access_token_enc = $3,
         access_token_expires_at = $4, last_error = null where id = $1`,
      [existing.id, tokens.refresh_token ? encrypt(tokens.refresh_token) : null, encrypt(tokens.access_token), new Date(Date.now() + tokens.expires_in * 1000)],
    );
    connId = existing.id;
  } else {
    if (!tokens.refresh_token) return back('googleError=no_refresh_token');
    const row = await one<{ id: string }>(
      `insert into google_connections (user_id, google_email, refresh_token_enc, access_token_enc, access_token_expires_at)
       values ($1, $2, $3, $4, $5) returning id`,
      [userId, email, encrypt(tokens.refresh_token), encrypt(tokens.access_token), new Date(Date.now() + tokens.expires_in * 1000)],
    );
    connId = row!.id;
  }
  await refreshCalendarList(connId, userId);
  syncAll().catch(() => {});
  back('google=connected');
});

googleRouter.post('/connections/:id/refresh', requireAuth, async (req, res) => {
  await canManageConnection(req.user!.id, req.user!.role, String(req.params.id));
  await refreshCalendarList(String(req.params.id));
  res.json({ ok: true });
});

googleRouter.delete('/connections/:id', requireAuth, async (req, res) => {
  const c = await canManageConnection(req.user!.id, req.user!.role, String(req.params.id));
  try {
    await revokeToken(decrypt(c.refresh_token_enc));
  } catch {
    /* ignore */
  }
  await q('delete from google_connections where id = $1', [c.id]); // cascades to calendars and mirrored events
  res.json({ ok: true });
});

googleRouter.patch('/calendars/:id', requireAuth, async (req, res) => {
  const b = parse(z.object({ syncEnabled: z.boolean().optional(), memberId: z.string().uuid().nullish() }), req.body);
  const cal = await one<any>('select * from google_calendars where id = $1', [req.params.id]);
  if (!cal) throw new HttpError(404, 'Calendar not found');
  await canManageConnection(req.user!.id, req.user!.role, cal.connection_id);
  await q(
    `update google_calendars set sync_enabled = coalesce($2, sync_enabled),
       member_id = case when $3::boolean then $4::uuid else member_id end where id = $1`,
    [cal.id, b.syncEnabled ?? null, b.memberId !== undefined, b.memberId ?? null],
  );
  if (b.syncEnabled === false) {
    await q('delete from events where calendar_id = $1', [cal.id]);
  } else {
    if (b.memberId !== undefined) await q('update events set google_etag = null where calendar_id = $1', [cal.id]);
    await syncCalendar(cal.id).catch(() => {});
  }
  res.json({ ok: true });
});

googleRouter.post('/sync', requireAuth, async (_req, res) => {
  ensureEnabled();
  res.json(await syncAll());
});
