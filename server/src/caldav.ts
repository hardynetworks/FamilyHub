/**
 * Apple iCloud (and any CalDAV server) two-way calendar sync, plus read-only .ics subscriptions.
 *
 *  - ext_accounts: an iCloud / CalDAV sign-in (app-specific password, encrypted) or one .ics link.
 *  - ext_calendars: the calendars found on an account (an .ics link has exactly one).
 *  - events rows with ext_calendar_id are mirrors. A repeating event is stored once with its RRULE
 *    (expanded when the calendar is shown); changed single occurrences are separate rows with
 *    recurrence_id, and the series hides those dates through exdates.
 *  - Pull: every 15 minutes (skipped when the calendar's ctag / the link's ETag hasn't changed).
 *  - Push: creating, editing or deleting an event on a writable CalDAV calendar writes the .ics
 *    resource on the server first, then mirrors it locally.
 */
import crypto from 'crypto';
import { Router } from 'express';
import type { Request } from 'express';
import { z } from 'zod';
import { config } from './config';
import { one, q } from './db';
import { IcsEvent, buildIcs, parseIcs } from './ics';
import { HttpError, decrypt, encrypt, parse } from './util';

export interface ExtAccountRow {
  id: string;
  kind: 'caldav' | 'ics';
  provider: string;
  name: string;
  url: string;
  username: string | null;
  password_enc: string | null;
  user_id: string | null;
  last_error: string | null;
  created_at: Date;
}

export interface ExtCalendarRow {
  id: string;
  account_id: string;
  remote_url: string;
  name: string;
  color: string | null;
  writable: boolean;
  sync_enabled: boolean;
  member_id: string | null;
  ctag: string | null;
  last_synced_at: Date | null;
  last_error: string | null;
}

export interface ExtEventInput {
  title: string;
  description: string | null;
  location: string | null;
  start: Date;
  end: Date;
  allDay: boolean;
  rrule: string | null;
  memberIds: string[];
}

const ICLOUD_URL = 'https://caldav.icloud.com/';
const UA = 'FamilyHub (CalDAV)';
const SYNC_MINUTES = 15;

// ---------------------------------------------------------------------------------------------
// Tiny XML helpers (CalDAV multistatus responses; namespace prefixes vary between servers)
// ---------------------------------------------------------------------------------------------
function decodeXml(s: string): string {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, (_m, c: string) => c)
    .replace(/&#x([0-9a-f]+);/gi, (_m, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_m, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

const P = '(?:[A-Za-z0-9_.-]+:)?';
function elements(xml: string, local: string): string[] {
  const re = new RegExp(`<${P}${local}(?:\\s[^>]*)?(?:/>|>([\\s\\S]*?)</${P}${local}\\s*>)`, 'g');
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) out.push(m[1] ?? '');
  return out;
}
const first = (xml: string, local: string) => elements(xml, local)[0];
const has = (xml: string, local: string) => new RegExp(`<${P}${local}[\\s/>]`).test(xml);
function textOf(xml: string | undefined): string | undefined {
  if (xml === undefined) return undefined;
  // CDATA sections are taken as-is (calendar data often contains "<" and "&").
  const cdata = [...xml.matchAll(/<!\[CDATA\[([\s\S]*?)\]\]>/g)].map((m) => m[1]);
  if (cdata.length) return cdata.join('').trim();
  return decodeXml(xml.replace(/<[^>]+>/g, '')).trim();
}

interface DavResponse {
  href: string;
  /** Inner XML of the propstat(s) with a 200 status. */
  ok: string;
}

function multistatus(xml: string): DavResponse[] {
  return elements(xml, 'response').map((r) => {
    const href = decodeXml((first(r, 'href') ?? '').trim());
    const ok = elements(r, 'propstat')
      .filter((ps) => /\s200\s/.test(` ${textOf(first(ps, 'status')) ?? ''} `))
      .join('\n');
    return { href, ok };
  });
}

// ---------------------------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------------------------
interface Creds {
  username: string | null;
  password: string | null;
}

function credsOf(acc: ExtAccountRow): Creds {
  return { username: acc.username, password: acc.password_enc ? decrypt(acc.password_enc) : null };
}

async function dav(
  creds: Creds,
  method: string,
  url: string,
  opts: { body?: string; depth?: '0' | '1'; headers?: Record<string, string>; contentType?: string } = {},
): Promise<{ status: number; text: string; etag: string | null }> {
  const headers: Record<string, string> = { 'User-Agent': UA, ...(opts.headers ?? {}) };
  if (creds.username) headers.Authorization = `Basic ${Buffer.from(`${creds.username}:${creds.password ?? ''}`).toString('base64')}`;
  if (opts.depth) headers.Depth = opts.depth;
  if (opts.body !== undefined) headers['Content-Type'] = opts.contentType ?? 'application/xml; charset=utf-8';
  let r: Awaited<ReturnType<typeof fetch>>;
  try {
    r = await fetch(url, { method, headers, body: opts.body, redirect: 'follow', signal: AbortSignal.timeout(30_000) });
  } catch (e: any) {
    throw new HttpError(502, `Couldn't reach ${new URL(url).host} (${e.cause?.code ?? e.message})`);
  }
  const text = await r.text();
  if (r.status === 401 || r.status === 403) {
    throw new HttpError(400, /icloud\.com/.test(url) ? 'iCloud didn’t accept that Apple ID and app-specific password.' : 'The server didn’t accept that user name and password.');
  }
  return { status: r.status, text, etag: r.headers.get('etag') };
}

const abs = (href: string, base: string) => new URL(href, base).toString();
const withSlash = (u: string) => (u.endsWith('/') ? u : u + '/');

// ---------------------------------------------------------------------------------------------
// Discovery: principal -> calendar home -> calendars
// ---------------------------------------------------------------------------------------------
interface FoundCalendar {
  url: string;
  name: string;
  color: string | null;
  writable: boolean;
  ctag: string | null;
}

async function findPrincipal(creds: Creds, start: string): Promise<string> {
  const body = `<?xml version="1.0" encoding="utf-8"?><d:propfind xmlns:d="DAV:"><d:prop><d:current-user-principal/></d:prop></d:propfind>`;
  for (const url of [start, new URL('/.well-known/caldav', start).toString()]) {
    const r = await dav(creds, 'PROPFIND', url, { body, depth: '0' });
    if (r.status === 207) {
      const href = textOf(first(first(r.text, 'current-user-principal') ?? '', 'href'));
      if (href) return abs(href, url);
    }
  }
  throw new HttpError(400, 'That doesn’t look like a CalDAV calendar server (no calendar account was found at that address).');
}

async function findHome(creds: Creds, principal: string): Promise<string> {
  const body = `<?xml version="1.0" encoding="utf-8"?><d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop><c:calendar-home-set/></d:prop></d:propfind>`;
  const r = await dav(creds, 'PROPFIND', principal, { body, depth: '0' });
  const href = textOf(first(first(r.text, 'calendar-home-set') ?? '', 'href'));
  if (r.status !== 207 || !href) throw new HttpError(400, 'Couldn’t find the calendars on that account.');
  return withSlash(abs(href, principal));
}

async function listCalendars(creds: Creds, home: string): Promise<FoundCalendar[]> {
  const body = `<?xml version="1.0" encoding="utf-8"?>
<d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav" xmlns:cs="http://calendarserver.org/ns/" xmlns:a="http://apple.com/ns/ical/">
  <d:prop><d:displayname/><d:resourcetype/><a:calendar-color/><cs:getctag/><c:supported-calendar-component-set/><d:current-user-privilege-set/></d:prop>
</d:propfind>`;
  const r = await dav(creds, 'PROPFIND', home, { body, depth: '1' });
  if (r.status !== 207) throw new HttpError(502, `The calendar server answered ${r.status} when listing calendars.`);
  const out: FoundCalendar[] = [];
  for (const res of multistatus(r.text)) {
    const rt = first(res.ok, 'resourcetype') ?? '';
    if (!has(rt, 'calendar')) continue;
    const comps = first(res.ok, 'supported-calendar-component-set');
    if (comps !== undefined && comps.trim() && !/name\s*=\s*["']VEVENT["']/i.test(comps)) continue; // reminders-only lists
    const priv = first(res.ok, 'current-user-privilege-set');
    const writable = priv === undefined || !priv.trim() || has(priv, 'write') || has(priv, 'write-content') || has(priv, 'all');
    const color = textOf(first(res.ok, 'calendar-color'));
    out.push({
      url: withSlash(abs(res.href, home)),
      name: textOf(first(res.ok, 'displayname')) || 'Calendar',
      color: color && /^#[0-9a-f]{6}/i.test(color) ? color.slice(0, 7) : null,
      writable,
      ctag: textOf(first(res.ok, 'getctag')) ?? null,
    });
  }
  return out;
}

async function discover(creds: Creds, start: string): Promise<FoundCalendar[]> {
  const principal = await findPrincipal(creds, start);
  const home = await findHome(creds, principal);
  return listCalendars(creds, home);
}

async function saveCalendars(acc: ExtAccountRow, found: FoundCalendar[], memberId: string | null) {
  for (const c of found) {
    await q(
      `insert into ext_calendars (account_id, remote_url, name, color, writable, sync_enabled, member_id)
       values ($1, $2, $3, $4, $5, true, $6)
       on conflict (account_id, remote_url) do update set name = excluded.name, color = coalesce(excluded.color, ext_calendars.color), writable = excluded.writable`,
      [acc.id, c.url, c.name, c.color, c.writable, memberId],
    );
  }
  await q('delete from ext_calendars where account_id = $1 and not (remote_url = any($2))', [acc.id, found.map((c) => c.url)]);
}

// ---------------------------------------------------------------------------------------------
// Pull sync
// ---------------------------------------------------------------------------------------------
function syncWindow() {
  const now = Date.now();
  return { start: new Date(now - config.google.pastDays * 86400_000), end: new Date(now + config.google.futureDays * 86400_000) };
}

const icsStamp = (d: Date) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');

interface Mirror {
  key: string;
  href: string | null;
  etag: string | null;
  ev: IcsEvent;
  exdates: Date[];
}

/** Turn the events of one resource (or one UID in an .ics file) into rows: the series plus changed occurrences. */
function mirrorsFor(events: IcsEvent[], base: string, href: string | null, etag: string | null): Mirror[] {
  const master = events.find((e) => !e.recurrenceId) ?? null;
  const overrides = events.filter((e) => e.recurrenceId);
  const out: Mirror[] = [];
  if (master && !master.cancelled) {
    const hidden = master.rrule ? overrides.map((o) => o.recurrenceId!) : [];
    out.push({ key: base + '#', href, etag, ev: master, exdates: [...master.exdates, ...hidden] });
  }
  for (const o of overrides) {
    if (o.cancelled) continue;
    out.push({ key: `${base}#${o.recurrenceId!.toISOString()}`, href, etag, ev: { ...o, rrule: null }, exdates: [] });
  }
  return out;
}

async function upsertMirror(cal: ExtCalendarRow, m: Mirror, validIds: Set<string>) {
  const own = (m.ev.memberIds ?? []).filter((id) => validIds.has(id));
  const members = m.ev.memberIds && own.length ? own : cal.member_id ? [cal.member_id] : [];
  await q(
    `insert into events (title, description, location, start_at, end_at, all_day, rrule, member_ids, ext_calendar_id, ext_key, ext_href, ext_uid,
                         ext_etag, exdates, recurrence_id, updated_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, now())
     on conflict (ext_calendar_id, ext_key) where ext_calendar_id is not null do update set
       title = excluded.title, description = excluded.description, location = excluded.location, start_at = excluded.start_at,
       end_at = excluded.end_at, all_day = excluded.all_day, rrule = excluded.rrule, member_ids = excluded.member_ids,
       ext_href = excluded.ext_href, ext_uid = excluded.ext_uid, ext_etag = excluded.ext_etag, exdates = excluded.exdates,
       recurrence_id = excluded.recurrence_id, updated_at = now()`,
    [
      m.ev.title.slice(0, 500),
      m.ev.description?.slice(0, 10000) ?? null,
      m.ev.location?.slice(0, 1000) ?? null,
      m.ev.start,
      m.ev.end,
      m.ev.allDay,
      m.ev.rrule,
      members,
      cal.id,
      m.key,
      m.href,
      m.ev.uid,
      m.etag,
      m.exdates,
      m.ev.recurrenceId,
    ],
  );
}

async function finishSync(cal: ExtCalendarRow, seen: string[], ctag: string | null) {
  await q('delete from events where ext_calendar_id = $1 and not (ext_key = any($2))', [cal.id, seen]);
  await q('update ext_calendars set ctag = $2, last_synced_at = now(), last_error = null where id = $1', [cal.id, ctag]);
}

async function syncCaldav(acc: ExtAccountRow, cal: ExtCalendarRow, force: boolean) {
  const creds = credsOf(acc);
  // Skip when nothing changed (ctag), but still do a full pass every few hours.
  const ctagBody = `<?xml version="1.0" encoding="utf-8"?><d:propfind xmlns:d="DAV:" xmlns:cs="http://calendarserver.org/ns/"><d:prop><cs:getctag/></d:prop></d:propfind>`;
  const ct = await dav(creds, 'PROPFIND', cal.remote_url, { body: ctagBody, depth: '0' });
  if (ct.status === 404) throw new HttpError(404, 'This calendar no longer exists on the server.');
  const ctag = textOf(first(ct.text, 'getctag')) ?? null;
  const fresh = cal.last_synced_at && Date.now() - cal.last_synced_at.getTime() < 6 * 3600_000;
  if (!force && ctag && ctag === cal.ctag && fresh) return;

  const w = syncWindow();
  const body = `<?xml version="1.0" encoding="utf-8"?>
<c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:prop><d:getetag/><c:calendar-data/></d:prop>
  <c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="VEVENT"><c:time-range start="${icsStamp(w.start)}" end="${icsStamp(w.end)}"/></c:comp-filter></c:comp-filter></c:filter>
</c:calendar-query>`;
  const r = await dav(creds, 'REPORT', cal.remote_url, { body, depth: '1' });
  if (r.status !== 207) throw new HttpError(502, `The calendar server answered ${r.status} when reading events.`);
  const validIds = new Set((await q<{ id: string }>('select id from users')).map((x) => x.id));
  const seen: string[] = [];
  for (const res of multistatus(r.text)) {
    const data = textOf(first(res.ok, 'calendar-data'));
    if (!data) continue;
    const href = abs(res.href, cal.remote_url);
    const etag = textOf(first(res.ok, 'getetag')) ?? null;
    for (const m of mirrorsFor(parseIcs(data), href, href, etag)) {
      await upsertMirror(cal, m, validIds);
      seen.push(m.key);
    }
  }
  await finishSync(cal, seen, ctag);
}

export function normalizeIcsUrl(u: string): string {
  const url = u.trim().replace(/^webcals?:\/\//i, 'https://');
  if (!/^https?:\/\//i.test(url)) throw new HttpError(400, 'Paste the calendar’s link (it starts with https:// or webcal://).');
  return url;
}

async function fetchIcs(url: string, etag?: string | null): Promise<{ status: number; text: string; etag: string | null }> {
  let r: Awaited<ReturnType<typeof fetch>>;
  try {
    r = await fetch(url, {
      headers: { 'User-Agent': UA, Accept: 'text/calendar, */*', ...(etag ? { 'If-None-Match': etag } : {}) },
      redirect: 'follow',
      signal: AbortSignal.timeout(30_000),
    });
  } catch (e: any) {
    throw new HttpError(502, `Couldn't download that calendar (${e.cause?.code ?? e.message})`);
  }
  if (r.status === 304) return { status: 304, text: '', etag: etag ?? null };
  const text = await r.text();
  if (!r.ok) throw new HttpError(502, `The calendar link answered ${r.status}. Check that it's still shared.`);
  if (!/BEGIN:VCALENDAR/i.test(text)) throw new HttpError(400, "That link doesn't point to a calendar (.ics) file.");
  return { status: r.status, text, etag: r.headers.get('etag') };
}

async function syncIcs(cal: ExtCalendarRow, force: boolean) {
  const fresh = cal.last_synced_at && Date.now() - cal.last_synced_at.getTime() < 6 * 3600_000;
  const r = await fetchIcs(cal.remote_url, !force && fresh ? cal.ctag : null);
  if (r.status === 304) {
    await q('update ext_calendars set last_synced_at = now(), last_error = null where id = $1', [cal.id]);
    return;
  }
  const w = syncWindow();
  const byUid = new Map<string, IcsEvent[]>();
  for (const e of parseIcs(r.text)) {
    // Skip one-off events far outside the window (big school / sports feeds go back years).
    if (!e.rrule && (e.end < w.start || e.start > w.end)) continue;
    if (!byUid.has(e.uid)) byUid.set(e.uid, []);
    byUid.get(e.uid)!.push(e);
  }
  const validIds = new Set((await q<{ id: string }>('select id from users')).map((x) => x.id));
  const seen: string[] = [];
  for (const [uid, events] of byUid) {
    for (const m of mirrorsFor(events, uid, null, null)) {
      await upsertMirror(cal, m, validIds);
      seen.push(m.key);
    }
  }
  await finishSync(cal, seen, r.etag);
}

const running = new Set<string>();

export async function syncExtCalendar(calendarId: string, force = false): Promise<void> {
  if (running.has(calendarId)) return;
  running.add(calendarId);
  try {
    const cal = await one<ExtCalendarRow>('select * from ext_calendars where id = $1', [calendarId]);
    if (!cal || !cal.sync_enabled) return;
    const acc = await one<ExtAccountRow>('select * from ext_accounts where id = $1', [cal.account_id]);
    if (!acc) return;
    try {
      if (acc.kind === 'ics') await syncIcs(cal, force);
      else await syncCaldav(acc, cal, force);
      await q('update ext_accounts set last_error = null where id = $1', [acc.id]);
    } catch (e: any) {
      await q('update ext_calendars set last_error = $2 where id = $1', [cal.id, String(e.message ?? e).slice(0, 500)]);
      throw e;
    }
  } finally {
    running.delete(calendarId);
  }
}

export async function syncAllExt(): Promise<void> {
  const cals = await q<{ id: string }>('select id from ext_calendars where sync_enabled');
  for (const c of cals) {
    await syncExtCalendar(c.id).catch((e) => console.warn(`Calendar sync failed for ${c.id}: ${e.message}`));
  }
}

export function startExtSyncLoop() {
  const tick = async () => {
    await syncAllExt().catch((e) => console.warn('Calendar sync loop error', e));
    setTimeout(tick, SYNC_MINUTES * 60_000);
  };
  setTimeout(tick, 20_000);
}

// ---------------------------------------------------------------------------------------------
// Push (app -> CalDAV)
// ---------------------------------------------------------------------------------------------
export async function getExtCalendar(id: string): Promise<ExtCalendarRow | null> {
  return one<ExtCalendarRow>('select * from ext_calendars where id = $1', [id]);
}

async function accountFor(cal: ExtCalendarRow): Promise<ExtAccountRow> {
  const acc = await one<ExtAccountRow>('select * from ext_accounts where id = $1', [cal.account_id]);
  if (!acc) throw new HttpError(404, 'Calendar account not found');
  if (acc.kind !== 'caldav' || !cal.writable) throw new HttpError(403, `"${cal.name}" is read-only in FamilyHub`);
  return acc;
}

/** Create an event on a CalDAV calendar and mirror it. Returns the new local event id. */
export async function extCreate(cal: ExtCalendarRow, ev: ExtEventInput): Promise<string | null> {
  const acc = await accountFor(cal);
  const uid = `${crypto.randomUUID()}@familyhub`;
  const href = new URL(encodeURIComponent(uid.replace('@', '-')) + '.ics', withSlash(cal.remote_url)).toString();
  const r = await dav(credsOf(acc), 'PUT', href, {
    body: buildIcs({ uid, ...ev }),
    contentType: 'text/calendar; charset=utf-8',
    headers: { 'If-None-Match': '*' },
  });
  if (r.status >= 300) throw new HttpError(502, `The calendar server refused the new event (${r.status}).`);
  const validIds = new Set(ev.memberIds);
  const icsEv: IcsEvent = { uid, ...ev, exdates: [], recurrenceId: null, cancelled: false, memberIds: ev.memberIds };
  await upsertMirror(cal, { key: href + '#', href, etag: r.etag, ev: icsEv, exdates: [] }, validIds);
  const row = await one<{ id: string }>('select id from events where ext_calendar_id = $1 and ext_key = $2', [cal.id, href + '#']);
  return row?.id ?? null;
}

interface ExtEventRow {
  id: string;
  ext_calendar_id: string | null;
  ext_href: string | null;
  ext_uid: string | null;
  ext_etag: string | null;
  recurrence_id: Date | null;
}

/** Split an iCalendar text into its VEVENT blocks (raw lines), keeping everything else. */
function veventBlocks(text: string): { start: number; end: number; isMaster: boolean }[] {
  const ls = text.split(/\r?\n/);
  const out: { start: number; end: number; isMaster: boolean }[] = [];
  let s = -1;
  let rid = false;
  for (let i = 0; i < ls.length; i++) {
    const l = ls[i].toUpperCase();
    if (l === 'BEGIN:VEVENT') {
      s = i;
      rid = false;
    } else if (s >= 0 && l.startsWith('RECURRENCE-ID')) rid = true;
    else if (l === 'END:VEVENT' && s >= 0) {
      out.push({ start: s, end: i, isMaster: !rid });
      s = -1;
    }
  }
  return out;
}

/** Edit a series / single event in place (changed occurrences of a series are kept). */
export async function extUpdate(row: ExtEventRow, cal: ExtCalendarRow, ev: ExtEventInput): Promise<string | null> {
  if (row.recurrence_id) {
    throw new HttpError(400, 'This is one changed occurrence of a repeating event. Edit the series instead, or change it in the Calendar app.');
  }
  const acc = await accountFor(cal);
  const creds = credsOf(acc);
  const href = row.ext_href!;
  const cur = await dav(creds, 'GET', href);
  if (cur.status === 404) throw new HttpError(404, 'This event was deleted on the calendar server. Pull to refresh.');
  const uid = row.ext_uid ?? `${crypto.randomUUID()}@familyhub`;
  const parsed = cur.status < 300 ? parseIcs(cur.text) : [];
  const oldMaster = parsed.find((e) => !e.recurrenceId);
  const fresh = buildIcs({ uid, ...ev, exdates: ev.rrule ? oldMaster?.exdates ?? [] : [] });
  let body = fresh;
  const blocks = cur.status < 300 ? veventBlocks(cur.text) : [];
  const master = blocks.find((b) => b.isMaster);
  if (master && blocks.length > 1 && ev.rrule) {
    // Swap just the series' VEVENT and keep the changed occurrences and time zones.
    const ls = cur.text.split(/\r?\n/);
    const freshLines = fresh.split(/\r\n/);
    const fb = freshLines.indexOf('BEGIN:VEVENT');
    const fe = freshLines.indexOf('END:VEVENT');
    ls.splice(master.start, master.end - master.start + 1, ...freshLines.slice(fb, fe + 1));
    body = ls.join('\r\n');
  }
  const r = await dav(creds, 'PUT', href, {
    body,
    contentType: 'text/calendar; charset=utf-8',
    headers: cur.etag ? { 'If-Match': cur.etag } : {},
  });
  if (r.status === 412) throw new HttpError(409, 'This event was just changed somewhere else. Close it, wait a moment and try again.');
  if (r.status >= 300) throw new HttpError(502, `The calendar server refused the change (${r.status}).`);
  await syncExtCalendar(cal.id, true);
  const again = await one<{ id: string }>('select id from events where ext_calendar_id = $1 and ext_key = $2', [cal.id, href + '#']);
  return again?.id ?? null;
}

export async function extDelete(row: ExtEventRow, cal: ExtCalendarRow): Promise<void> {
  if (row.recurrence_id) {
    throw new HttpError(400, 'This is one changed occurrence of a repeating event. Delete it in the Calendar app, or delete the whole series.');
  }
  const acc = await accountFor(cal);
  const r = await dav(credsOf(acc), 'DELETE', row.ext_href!);
  if (r.status >= 300 && r.status !== 404 && r.status !== 410) throw new HttpError(502, `The calendar server refused to delete it (${r.status}).`);
  await q('delete from events where ext_calendar_id = $1 and ext_href = $2', [cal.id, row.ext_href]);
}

// ---------------------------------------------------------------------------------------------
// Routes (mounted at /api/ext-calendars behind requireAuth)
// ---------------------------------------------------------------------------------------------
export const extCalendarsRouter = Router();

function noKiosk(req: Request) {
  if (req.device) throw new HttpError(403, 'Not available on a kiosk screen');
}

async function ownedAccount(req: Request, id: string): Promise<ExtAccountRow> {
  const acc = await one<ExtAccountRow>('select * from ext_accounts where id = $1', [id]);
  if (!acc) throw new HttpError(404, 'Calendar account not found');
  if (acc.user_id !== req.user!.id && req.user!.role !== 'admin') throw new HttpError(403, 'Only the person who added it (or a head of household) can change this');
  return acc;
}

extCalendarsRouter.get('/', async (req, res) => {
  noKiosk(req);
  const accounts = await q<ExtAccountRow>('select * from ext_accounts order by created_at');
  const cals = await q<ExtCalendarRow>('select * from ext_calendars order by name');
  res.json(
    accounts.map((a) => ({
      id: a.id,
      kind: a.kind,
      provider: a.provider,
      name: a.name,
      url: a.url,
      username: a.username,
      userId: a.user_id,
      canEdit: a.user_id === req.user!.id || req.user!.role === 'admin',
      lastError: a.last_error,
      calendars: cals
        .filter((c) => c.account_id === a.id)
        .map((c) => ({
          id: c.id,
          name: c.name,
          color: c.color,
          writable: c.writable,
          syncEnabled: c.sync_enabled,
          memberId: c.member_id,
          lastSyncedAt: c.last_synced_at,
          lastError: c.last_error,
        })),
    })),
  );
});

async function addCaldav(req: Request, provider: string, name: string, url: string, username: string, password: string) {
  const creds = { username, password };
  const found = await discover(creds, url);
  if (!found.length) throw new HttpError(400, 'Signed in, but there are no calendars with events on that account.');
  const acc = await one<ExtAccountRow>(
    `insert into ext_accounts (kind, provider, name, url, username, password_enc, user_id) values ('caldav', $1, $2, $3, $4, $5, $6) returning *`,
    [provider, name, url, username, encrypt(password), req.user!.id],
  );
  await saveCalendars(acc!, found, req.user!.id);
  syncAccount(acc!.id);
  return acc!;
}

function syncAccount(accountId: string) {
  q<{ id: string }>('select id from ext_calendars where account_id = $1 and sync_enabled', [accountId])
    .then((cals) => Promise.all(cals.map((c) => syncExtCalendar(c.id, true).catch(() => {}))))
    .catch(() => {});
}

extCalendarsRouter.post('/icloud', async (req, res) => {
  noKiosk(req);
  const b = parse(z.object({ email: z.string().trim().email().max(200), password: z.string().trim().min(8).max(100) }), req.body);
  const acc = await addCaldav(req, 'icloud', `iCloud · ${b.email}`, ICLOUD_URL, b.email, b.password.replace(/\s/g, ''));
  res.status(201).json({ id: acc.id });
});

extCalendarsRouter.post('/caldav', async (req, res) => {
  noKiosk(req);
  const b = parse(
    z.object({ url: z.string().trim().url().max(500), username: z.string().trim().min(1).max(200), password: z.string().min(1).max(200), name: z.string().trim().max(80).optional() }),
    req.body,
  );
  const acc = await addCaldav(req, 'caldav', b.name || `${new URL(b.url).host} · ${b.username}`, b.url, b.username, b.password);
  res.status(201).json({ id: acc.id });
});

extCalendarsRouter.post('/ics', async (req, res) => {
  noKiosk(req);
  const b = parse(
    z.object({ url: z.string().trim().min(8).max(2000), name: z.string().trim().min(1).max(80), memberId: z.string().uuid().nullish(), color: z.string().regex(/^#[0-9a-fA-F]{6}$/).nullish() }),
    req.body,
  );
  const url = normalizeIcsUrl(b.url);
  const test = await fetchIcs(url);
  const count = parseIcs(test.text).length;
  const acc = await one<ExtAccountRow>(`insert into ext_accounts (kind, provider, name, url, user_id) values ('ics', 'ics', $1, $2, $3) returning *`, [b.name, url, req.user!.id]);
  const cal = await one<{ id: string }>(
    `insert into ext_calendars (account_id, remote_url, name, color, writable, sync_enabled, member_id) values ($1, $2, $3, $4, false, true, $5) returning id`,
    [acc!.id, url, b.name, b.color ?? null, b.memberId ?? null],
  );
  syncExtCalendar(cal!.id, true).catch(() => {});
  res.status(201).json({ id: acc!.id, events: count });
});

extCalendarsRouter.patch('/calendars/:id', async (req, res) => {
  noKiosk(req);
  const id = parse(z.string().uuid(), req.params.id);
  const b = parse(
    z.object({ syncEnabled: z.boolean().optional(), memberId: z.string().uuid().nullable().optional(), name: z.string().trim().min(1).max(80).optional(), color: z.string().regex(/^#[0-9a-fA-F]{6}$/).nullable().optional() }),
    req.body,
  );
  const cal = await getExtCalendar(id);
  if (!cal) throw new HttpError(404, 'Calendar not found');
  await ownedAccount(req, cal.account_id);
  await q(
    `update ext_calendars set sync_enabled = coalesce($2, sync_enabled), member_id = case when $3::boolean then $4::uuid else member_id end,
       name = coalesce($5, name), color = case when $6::boolean then $7 else color end, ctag = null where id = $1`,
    [id, b.syncEnabled ?? null, b.memberId !== undefined, b.memberId ?? null, b.name ?? null, b.color !== undefined, b.color ?? null],
  );
  if (b.syncEnabled === false) await q('delete from events where ext_calendar_id = $1', [id]);
  else syncExtCalendar(id, true).catch(() => {});
  res.json({ ok: true });
});

extCalendarsRouter.post('/accounts/:id/sync', async (req, res) => {
  noKiosk(req);
  const acc = await ownedAccount(req, parse(z.string().uuid(), req.params.id));
  if (acc.kind === 'caldav') {
    const found = await discover(credsOf(acc), acc.url);
    await saveCalendars(acc, found, acc.user_id);
  }
  const cals = await q<{ id: string }>('select id from ext_calendars where account_id = $1 and sync_enabled', [acc.id]);
  const errors: string[] = [];
  for (const c of cals) await syncExtCalendar(c.id, true).catch((e) => errors.push(e.message));
  if (errors.length) throw new HttpError(502, errors[0]);
  res.json({ ok: true });
});

extCalendarsRouter.put('/accounts/:id/password', async (req, res) => {
  noKiosk(req);
  const acc = await ownedAccount(req, parse(z.string().uuid(), req.params.id));
  const { password } = parse(z.object({ password: z.string().trim().min(1).max(200) }), req.body);
  if (acc.kind !== 'caldav') throw new HttpError(400, 'This calendar has no password');
  const pw = acc.provider === 'icloud' ? password.replace(/\s/g, '') : password;
  await discover({ username: acc.username, password: pw }, acc.url); // check it works first
  await q('update ext_accounts set password_enc = $2, last_error = null where id = $1', [acc.id, encrypt(pw)]);
  syncAccount(acc.id);
  res.json({ ok: true });
});

extCalendarsRouter.delete('/accounts/:id', async (req, res) => {
  noKiosk(req);
  const acc = await ownedAccount(req, parse(z.string().uuid(), req.params.id));
  await q('delete from ext_accounts where id = $1', [acc.id]); // calendars and their events go with it
  res.json({ ok: true });
});
