/**
 * Two-way Google Calendar sync.
 *
 * Model:
 *  - Each family member can connect one or more Google accounts (google_connections).
 *  - Each Google calendar on that account is a google_calendars row; the family picks which ones to sync
 *    and which family member the calendar belongs to (used for colors/filters).
 *  - Pull: every N minutes (and on demand) we list events in a rolling window (singleEvents=true, so
 *    recurring events are expanded into instances) and mirror them into `events`.
 *  - Push: when an event that belongs to a Google calendar is created/edited/deleted in the app, the
 *    change is written to Google first, then mirrored locally. Google stays the source of truth.
 */
import { config } from './config';
import { one, q } from './db';
import { HttpError, decrypt, encrypt } from './util';

const API = 'https://www.googleapis.com/calendar/v3';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const GOOGLE_SCOPES = ['openid', 'email', 'https://www.googleapis.com/auth/calendar'];

export interface ConnectionRow {
  id: string;
  user_id: string;
  google_email: string;
  refresh_token_enc: string;
  access_token_enc: string | null;
  access_token_expires_at: Date | null;
  last_error: string | null;
}

export interface CalendarRow {
  id: string;
  connection_id: string;
  google_calendar_id: string;
  summary: string;
  background_color: string | null;
  access_role: string;
  is_primary: boolean;
  sync_enabled: boolean;
  member_id: string | null;
  last_synced_at: Date | null;
  last_error: string | null;
}

export interface LocalEventInput {
  title: string;
  description?: string | null;
  location?: string | null;
  start: Date;
  end: Date;
  allDay: boolean;
  rrule?: string | null;
  memberIds: string[];
}

export function googleAuthUrl(state: string, redirectUri: string): string {
  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  url.search = new URLSearchParams({
    client_id: config.google.clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: GOOGLE_SCOPES.join(' '),
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'true',
    state,
  }).toString();
  return url.toString();
}

export async function exchangeCode(code: string, redirectUri: string): Promise<any> {
  const r = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: config.google.clientId,
      client_secret: config.google.clientSecret,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
    }),
  });
  const j: any = await r.json().catch(() => ({}));
  if (!r.ok) throw new HttpError(400, j.error_description ?? j.error ?? 'Google token exchange failed');
  return j;
}

export async function revokeToken(token: string) {
  await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(token)}`, { method: 'POST' }).catch(() => {});
}

async function accessToken(conn: ConnectionRow, force = false): Promise<string> {
  if (!force && conn.access_token_enc && conn.access_token_expires_at && conn.access_token_expires_at.getTime() > Date.now() + 60_000) {
    return decrypt(conn.access_token_enc);
  }
  const r = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: config.google.clientId,
      client_secret: config.google.clientSecret,
      refresh_token: decrypt(conn.refresh_token_enc),
      grant_type: 'refresh_token',
    }),
  });
  const j: any = await r.json().catch(() => ({}));
  if (!r.ok) {
    const msg = j.error === 'invalid_grant' ? 'Google access was revoked or expired. Reconnect this account.' : `Token refresh failed: ${j.error ?? r.status}`;
    await q('update google_connections set last_error = $2 where id = $1', [conn.id, msg]);
    throw new HttpError(502, msg);
  }
  const expires = new Date(Date.now() + (j.expires_in ?? 3600) * 1000);
  await q('update google_connections set access_token_enc = $2, access_token_expires_at = $3, last_error = null where id = $1', [
    conn.id,
    encrypt(j.access_token),
    expires,
  ]);
  conn.access_token_enc = encrypt(j.access_token);
  conn.access_token_expires_at = expires;
  return j.access_token;
}

async function getConnection(id: string): Promise<ConnectionRow> {
  const c = await one<ConnectionRow>('select * from google_connections where id = $1', [id]);
  if (!c) throw new HttpError(404, 'Google connection not found');
  return c;
}

export async function gapi<T = any>(
  conn: ConnectionRow,
  method: string,
  path: string,
  opts: { query?: Record<string, string | undefined>; body?: unknown } = {},
): Promise<T> {
  const url = new URL(API + path);
  for (const [k, v] of Object.entries(opts.query ?? {})) if (v !== undefined) url.searchParams.set(k, v);
  let token = await accessToken(conn);
  for (let attempt = 0; attempt < 2; attempt++) {
    const r = await fetch(url, {
      method,
      headers: { Authorization: `Bearer ${token}`, ...(opts.body ? { 'Content-Type': 'application/json' } : {}) },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    if (r.status === 401 && attempt === 0) {
      token = await accessToken(conn, true);
      continue;
    }
    if (r.status === 204) return undefined as T;
    const j: any = await r.json().catch(() => ({}));
    if (!r.ok) {
      const err = new HttpError(r.status === 404 || r.status === 410 ? r.status : 502, `Google API: ${j.error?.message ?? r.statusText}`);
      throw err;
    }
    return j as T;
  }
  throw new HttpError(502, 'Google API authorization failed');
}

// ---------------- Calendar list ----------------

export async function refreshCalendarList(connectionId: string, defaultMemberId?: string): Promise<void> {
  const conn = await getConnection(connectionId);
  const items: any[] = [];
  let pageToken: string | undefined;
  do {
    const page: any = await gapi(conn, 'GET', '/users/me/calendarList', { query: { maxResults: '250', pageToken } });
    items.push(...(page.items ?? []));
    pageToken = page.nextPageToken;
  } while (pageToken);

  for (const c of items) {
    await q(
      `insert into google_calendars (connection_id, google_calendar_id, summary, background_color, access_role, is_primary, sync_enabled, member_id)
       values ($1, $2, $3, $4, $5, $6, $7, $8)
       on conflict (connection_id, google_calendar_id) do update set
         summary = excluded.summary, background_color = excluded.background_color,
         access_role = excluded.access_role, is_primary = excluded.is_primary`,
      [
        conn.id,
        c.id,
        c.summaryOverride || c.summary || c.id,
        c.backgroundColor ?? null,
        c.accessRole ?? 'reader',
        !!c.primary,
        !!c.primary, // sync the primary calendar by default
        c.primary ? defaultMemberId ?? conn.user_id : null,
      ],
    );
  }
  const ids = items.map((c) => c.id);
  await q('delete from google_calendars where connection_id = $1 and not (google_calendar_id = any($2))', [conn.id, ids]);
}

// ---------------- Mapping ----------------

function toDateOnly(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function toGoogleBody(ev: LocalEventInput, includeRecurrence: boolean) {
  const body: any = {
    summary: ev.title,
    description: ev.description ?? '',
    location: ev.location ?? '',
    extendedProperties: { private: { familyhubMembers: ev.memberIds.join(',') } },
  };
  if (ev.allDay) {
    body.start = { date: toDateOnly(ev.start), dateTime: null };
    body.end = { date: toDateOnly(ev.end), dateTime: null };
  } else {
    body.start = { dateTime: ev.start.toISOString(), timeZone: config.timezone, date: null };
    body.end = { dateTime: ev.end.toISOString(), timeZone: config.timezone, date: null };
  }
  if (includeRecurrence) body.recurrence = ev.rrule ? [`RRULE:${ev.rrule}`] : [];
  return body;
}

function parseGoogleTimes(ge: any): { start: Date; end: Date; allDay: boolean } | null {
  if (ge.start?.date) {
    const start = new Date(ge.start.date + 'T00:00:00Z');
    const end = ge.end?.date ? new Date(ge.end.date + 'T00:00:00Z') : new Date(start.getTime() + 86400_000);
    return { start, end, allDay: true };
  }
  if (ge.start?.dateTime) {
    const start = new Date(ge.start.dateTime);
    const end = ge.end?.dateTime ? new Date(ge.end.dateTime) : new Date(start.getTime() + 3600_000);
    return { start, end, allDay: false };
  }
  return null;
}

function membersFromGoogle(ge: any, cal: CalendarRow, validIds: Set<string>): string[] {
  const raw: string | undefined = ge.extendedProperties?.private?.familyhubMembers;
  if (raw !== undefined) {
    const ids = raw.split(',').filter((id) => validIds.has(id));
    if (ids.length || raw === '') return ids.length ? ids : cal.member_id ? [cal.member_id] : [];
  }
  return cal.member_id ? [cal.member_id] : [];
}

async function upsertFromGoogle(cal: CalendarRow, ge: any, validIds: Set<string>): Promise<void> {
  const t = parseGoogleTimes(ge);
  if (!t) return;
  await q(
    `insert into events (title, description, location, start_at, end_at, all_day, member_ids, calendar_id,
                         google_event_id, google_etag, google_recurring_event_id, updated_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, now())
     on conflict (calendar_id, google_event_id) do update set
       title = excluded.title, description = excluded.description, location = excluded.location,
       start_at = excluded.start_at, end_at = excluded.end_at, all_day = excluded.all_day,
       member_ids = excluded.member_ids, google_etag = excluded.google_etag,
       google_recurring_event_id = excluded.google_recurring_event_id, rrule = null, updated_at = now()
     where events.google_etag is distinct from excluded.google_etag`,
    [
      ge.summary || '(No title)',
      ge.description ?? null,
      ge.location ?? null,
      t.start,
      t.end,
      t.allDay,
      membersFromGoogle(ge, cal, validIds),
      cal.id,
      ge.id,
      ge.etag ?? null,
      ge.recurringEventId ?? null,
    ],
  );
}

// ---------------- Pull sync ----------------

const running = new Set<string>();

export async function syncCalendar(calendarId: string): Promise<void> {
  if (running.has(calendarId)) return;
  running.add(calendarId);
  try {
    const cal = await one<CalendarRow>('select * from google_calendars where id = $1', [calendarId]);
    if (!cal || !cal.sync_enabled) return;
    const conn = await getConnection(cal.connection_id);
    const now = Date.now();
    const winStart = new Date(now - config.google.pastDays * 86400_000);
    const winEnd = new Date(now + config.google.futureDays * 86400_000);
    const validIds = new Set((await q<{ id: string }>('select id from users')).map((r) => r.id));
    try {
      const seen: string[] = [];
      let pageToken: string | undefined;
      do {
        const page: any = await gapi(conn, 'GET', `/calendars/${encodeURIComponent(cal.google_calendar_id)}/events`, {
          query: {
            singleEvents: 'true',
            showDeleted: 'false',
            maxResults: '2500',
            timeMin: winStart.toISOString(),
            timeMax: winEnd.toISOString(),
            pageToken,
          },
        });
        for (const ge of page.items ?? []) {
          if (ge.status === 'cancelled') continue;
          seen.push(ge.id);
          await upsertFromGoogle(cal, ge, validIds);
        }
        pageToken = page.nextPageToken;
      } while (pageToken);

      // Anything in the window that Google no longer returns was deleted on the Google side.
      await q(
        `delete from events where calendar_id = $1 and google_event_id is not null
           and not (google_event_id = any($2)) and start_at < $4 and end_at > $3`,
        [cal.id, seen, winStart, winEnd],
      );
      // Drop mirrored events that fell out of the window entirely.
      await q('delete from events where calendar_id = $1 and (end_at < $2 or start_at > $3)', [cal.id, winStart, winEnd]);
      await q('update google_calendars set last_synced_at = now(), last_error = null where id = $1', [cal.id]);
    } catch (e: any) {
      await q('update google_calendars set last_error = $2 where id = $1', [cal.id, String(e.message ?? e)]);
      throw e;
    }
  } finally {
    running.delete(calendarId);
  }
}

export async function syncAll(): Promise<{ ok: number; failed: number }> {
  const cals = await q<{ id: string }>('select id from google_calendars where sync_enabled');
  let ok = 0;
  let failed = 0;
  for (const c of cals) {
    try {
      await syncCalendar(c.id);
      ok++;
    } catch (e: any) {
      failed++;
      console.warn(`Google sync failed for calendar ${c.id}: ${e.message}`);
    }
  }
  return { ok, failed };
}

/** Background sync. Re-reads settings every tick, so enabling Google or changing the interval needs no restart. */
export function startSyncLoop() {
  const tick = async () => {
    if (config.google.enabled) await syncAll().catch((e) => console.warn('Google sync loop error', e));
    setTimeout(tick, config.google.syncIntervalMinutes * 60_000);
  };
  setTimeout(tick, 10_000);
}

/**
 * Check Google OAuth client credentials without a user: exchanging a bogus code returns
 * `invalid_client` for bad credentials and `invalid_grant` when the client itself is valid.
 */
export async function testGoogleCredentials(clientId: string, clientSecret: string, redirectUri: string): Promise<{ ok: boolean; message: string }> {
  const r = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ code: 'familyhub-credential-test', client_id: clientId, client_secret: clientSecret, redirect_uri: redirectUri, grant_type: 'authorization_code' }),
    signal: AbortSignal.timeout(8000),
  });
  const j: any = await r.json().catch(() => ({}));
  if (j.error === 'invalid_grant') return { ok: true, message: 'Google accepted the client ID and secret.' };
  if (j.error === 'invalid_client' || j.error === 'unauthorized_client') return { ok: false, message: 'Google rejected the client ID or secret.' };
  if (j.error === 'redirect_uri_mismatch') return { ok: false, message: `Add ${redirectUri} as an Authorized redirect URI on the OAuth client.` };
  return { ok: false, message: `Unexpected response from Google: ${j.error_description ?? j.error ?? r.status}` };
}

// ---------------- Push (app -> Google) ----------------

export async function getCalendar(calendarId: string): Promise<CalendarRow> {
  const cal = await one<CalendarRow>('select * from google_calendars where id = $1', [calendarId]);
  if (!cal) throw new HttpError(404, 'Calendar not found');
  return cal;
}

export function isWritable(cal: CalendarRow) {
  return cal.access_role === 'owner' || cal.access_role === 'writer';
}

export async function pushCreate(cal: CalendarRow, ev: LocalEventInput): Promise<any> {
  if (!isWritable(cal)) throw new HttpError(403, `You don't have write access to "${cal.summary}"`);
  const conn = await getConnection(cal.connection_id);
  return gapi(conn, 'POST', `/calendars/${encodeURIComponent(cal.google_calendar_id)}/events`, { body: toGoogleBody(ev, true) });
}

export async function pushPatch(cal: CalendarRow, googleEventId: string, ev: LocalEventInput, includeRecurrence: boolean): Promise<any> {
  if (!isWritable(cal)) throw new HttpError(403, `You don't have write access to "${cal.summary}"`);
  const conn = await getConnection(cal.connection_id);
  return gapi(conn, 'PATCH', `/calendars/${encodeURIComponent(cal.google_calendar_id)}/events/${encodeURIComponent(googleEventId)}`, {
    body: toGoogleBody(ev, includeRecurrence),
  });
}

export async function pushDelete(cal: CalendarRow, googleEventId: string): Promise<void> {
  if (!isWritable(cal)) throw new HttpError(403, `You don't have write access to "${cal.summary}"`);
  const conn = await getConnection(cal.connection_id);
  try {
    await gapi(conn, 'DELETE', `/calendars/${encodeURIComponent(cal.google_calendar_id)}/events/${encodeURIComponent(googleEventId)}`);
  } catch (e: any) {
    if (e.status === 404 || e.status === 410) return; // already gone
    throw e;
  }
}

/** Store a single Google event returned from a push so the UI updates immediately. */
export async function mirrorPushed(cal: CalendarRow, ge: any): Promise<void> {
  const validIds = new Set((await q<{ id: string }>('select id from users')).map((r) => r.id));
  await upsertFromGoogle(cal, ge, validIds);
}
