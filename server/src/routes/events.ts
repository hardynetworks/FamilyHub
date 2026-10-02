import { Router } from 'express';
import { RRule } from 'rrule';
import { z } from 'zod';
import { config } from '../config';
import { one, q } from '../db';
import { ExtCalendarRow, extCreate, extDelete, extUpdate, getExtCalendar } from '../caldav';
import { CalendarRow, LocalEventInput, getCalendar, isWritable, mirrorPushed, pushCreate, pushDelete, pushPatch, syncCalendar } from '../google';
import { anyInGroup, groupFilter } from '../groups';
import { occasionEvents } from '../occasions';
import { HttpError, parse, utcToWall, wallToUtc } from '../util';

export const eventsRouter = Router();

export interface EventRow {
  id: string;
  title: string;
  description: string | null;
  location: string | null;
  start_at: Date;
  end_at: Date;
  all_day: boolean;
  rrule: string | null;
  member_ids: string[];
  color: string | null;
  calendar_id: string | null;
  google_event_id: string | null;
  google_recurring_event_id: string | null;
  created_by: string | null;
  reminder_minutes: number | null;
  ext_calendar_id: string | null;
  ext_href: string | null;
  ext_uid: string | null;
  ext_etag: string | null;
  exdates: Date[] | null;
  recurrence_id: Date | null;
  calendar_name?: string | null;
  calendar_color?: string | null;
  access_role?: string | null;
  ext_writable?: boolean | null;
  ext_provider?: string | null;
}

export const SELECT = `select e.*, coalesce(gc.summary, xc.name) as calendar_name, coalesce(gc.background_color, xc.color) as calendar_color,
                gc.access_role, xc.writable as ext_writable, xa.provider as ext_provider
                from events e left join google_calendars gc on gc.id = e.calendar_id
                left join ext_calendars xc on xc.id = e.ext_calendar_id left join ext_accounts xa on xa.id = xc.account_id`;

function sourceOf(r: EventRow): 'local' | 'google' | 'icloud' | 'caldav' | 'ics' {
  if (r.calendar_id) return 'google';
  if (r.ext_calendar_id) return r.ext_provider === 'icloud' ? 'icloud' : r.ext_provider === 'ics' ? 'ics' : 'caldav';
  return 'local';
}

function fmt(d: Date, allDay: boolean) {
  return allDay ? d.toISOString().slice(0, 10) : d.toISOString();
}

function toDto(r: EventRow, occStart?: Date, occEnd?: Date) {
  const start = occStart ?? r.start_at;
  const end = occEnd ?? r.end_at;
  return {
    id: r.id,
    instanceKey: `${r.id}:${start.getTime()}`,
    title: r.title,
    description: r.description,
    location: r.location,
    start: fmt(start, r.all_day),
    end: fmt(end, r.all_day),
    seriesStart: fmt(r.start_at, r.all_day),
    seriesEnd: fmt(r.end_at, r.all_day),
    allDay: r.all_day,
    rrule: r.rrule,
    memberIds: r.member_ids,
    color: r.color,
    calendarId: r.calendar_id ?? r.ext_calendar_id,
    calendarName: r.calendar_name ?? null,
    calendarColor: r.calendar_color ?? null,
    source: sourceOf(r),
    isGoogleRecurringInstance: !!r.google_recurring_event_id || !!r.recurrence_id,
    editable: r.ext_calendar_id
      ? !!r.ext_writable && !r.recurrence_id
      : !r.calendar_id || r.access_role === 'owner' || r.access_role === 'writer',
    reminderMinutes: r.reminder_minutes,
  };
}

const MAX_OCCURRENCES = 1000;

/**
 * Expand a recurring event into occurrences overlapping [winStart, winEnd). DST-safe for timed
 * events. Dates in `exdates` (deleted or separately changed occurrences) are skipped.
 */
export function expand(
  r: Pick<EventRow, 'start_at' | 'end_at' | 'all_day' | 'rrule' | 'exdates'>,
  winStart: Date,
  winEnd: Date,
): { start: Date; end: Date }[] {
  const dur = r.end_at.getTime() - r.start_at.getTime();
  let opts;
  try {
    opts = RRule.parseString(r.rrule!);
  } catch {
    return [{ start: r.start_at, end: r.end_at }];
  }
  const tz = config.timezone;
  const toWall = (d: Date) => (r.all_day ? d : utcToWall(d, tz));
  const fromWall = (d: Date) => (r.all_day ? d : wallToUtc(d, tz));
  const rule = new RRule({ ...opts, dtstart: toWall(r.start_at) });
  const from = toWall(new Date(winStart.getTime() - dur));
  const to = toWall(winEnd);
  const out: { start: Date; end: Date }[] = [];
  const skip = new Set((r.exdates ?? []).map((d) => new Date(d).getTime()));
  rule.between(from, to, true, (d) => {
    const s = fromWall(d);
    const e = new Date(s.getTime() + dur);
    if (s < winEnd && e > winStart && !skip.has(s.getTime())) out.push({ start: s, end: e });
    return out.length < MAX_OCCURRENCES;
  });
  return out;
}

eventsRouter.get('/', async (req, res) => {
  const { start, end, memberId } = parse(
    z.object({ start: z.string().min(1), end: z.string().min(1), memberId: z.string().uuid().optional() }),
    req.query,
  );
  const ws = new Date(start);
  const we = new Date(end);
  if (isNaN(ws.getTime()) || isNaN(we.getTime())) throw new HttpError(400, 'Invalid start/end');
  if (we.getTime() - ws.getTime() > 400 * 86400_000) throw new HttpError(400, 'Range too large');

  const single = await q<EventRow>(`${SELECT} where e.rrule is null and e.start_at < $2 and e.end_at > $1 order by e.start_at`, [ws, we]);
  const recurring = await q<EventRow>(`${SELECT} where e.rrule is not null and e.start_at < $1`, [we]);

  const group = await groupFilter(req);
  type Dto = ReturnType<typeof toDto> | Awaited<ReturnType<typeof occasionEvents>>[number];
  let out: Dto[] = single.map((r) => toDto(r));
  for (const r of recurring) for (const o of expand(r, ws, we)) out.push(toDto(r, o.start, o.end));
  out.push(...(await occasionEvents(ws, we, group)));
  if (memberId) out = out.filter((e) => e.memberIds.includes(memberId));
  if (group) out = out.filter((e) => anyInGroup(group, e.memberIds));
  out.sort((a, b) => a.start.localeCompare(b.start));
  res.json(out);
});

eventsRouter.get('/targets', async (_req, res) => {
  const cals = await q<CalendarRow & { google_email: string }>(
    `select gc.*, c.google_email from google_calendars gc join google_connections c on c.id = gc.connection_id
     where gc.sync_enabled and gc.access_role in ('owner','writer') order by gc.is_primary desc, gc.summary`,
  );
  const ext = await q<ExtCalendarRow & { account_name: string; provider: string }>(
    `select xc.*, xa.name as account_name, xa.provider from ext_calendars xc join ext_accounts xa on xa.id = xc.account_id
     where xc.sync_enabled and xc.writable and xa.kind = 'caldav' order by xa.created_at, xc.name`,
  );
  res.json([
    ...cals.map((c) => ({ id: c.id, name: c.summary, account: c.google_email, color: c.background_color, memberId: c.member_id, provider: 'google' })),
    ...ext.map((c) => ({ id: c.id, name: c.name, account: c.account_name, color: c.color, memberId: c.member_id, provider: c.provider })),
  ]);
});

const rruleSchema = z
  .string()
  .max(500)
  .regex(/^[A-Z0-9=;,:+\-]+$/, 'invalid RRULE')
  .refine((s) => {
    try {
      RRule.parseString(s);
      return /FREQ=/.test(s);
    } catch {
      return false;
    }
  }, 'invalid RRULE');

const EventInput = z.object({
  title: z.string().trim().min(1).max(500),
  description: z.string().max(10000).nullish(),
  location: z.string().max(1000).nullish(),
  start: z.string().min(1),
  end: z.string().min(1),
  allDay: z.boolean().default(false),
  rrule: rruleSchema.nullish(),
  memberIds: z.array(z.string().uuid()).default([]),
  color: z.string().max(20).nullish(),
  calendarId: z.string().uuid().nullish(),
  reminderMinutes: z.number().int().min(0).max(40320).nullish(),
});
type EventInputT = z.infer<typeof EventInput>;

function toTimes(b: { start: string; end: string; allDay: boolean }) {
  const parseD = (s: string) => {
    const d = b.allDay ? new Date(s.slice(0, 10) + 'T00:00:00Z') : new Date(s);
    if (isNaN(d.getTime())) throw new HttpError(400, `Invalid date: ${s}`);
    return d;
  };
  const start = parseD(b.start);
  let end = parseD(b.end);
  if (end <= start) end = new Date(start.getTime() + (b.allDay ? 86400_000 : 3600_000));
  return { start, end };
}

function toLocal(b: EventInputT): LocalEventInput {
  const { start, end } = toTimes(b);
  return { title: b.title, description: b.description ?? null, location: b.location ?? null, start, end, allDay: b.allDay, rrule: b.rrule ?? null, memberIds: b.memberIds };
}

async function insertLocal(ev: LocalEventInput, color: string | null | undefined, userId: string) {
  return one<EventRow>(
    `insert into events (title, description, location, start_at, end_at, all_day, rrule, member_ids, color, created_by)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) returning id`,
    [ev.title, ev.description, ev.location, ev.start, ev.end, ev.allDay, ev.rrule, ev.memberIds, color ?? null, userId],
  );
}

async function createInGoogle(cal: CalendarRow, ev: LocalEventInput): Promise<string | null> {
  const ge = await pushCreate(cal, ev);
  if (ev.rrule) {
    // Recurring events are mirrored as expanded instances by the pull sync.
    await syncCalendar(cal.id);
    return null;
  }
  await mirrorPushed(cal, ge);
  const row = await one<{ id: string }>('select id from events where calendar_id = $1 and google_event_id = $2', [cal.id, ge.id]);
  return row?.id ?? null;
}

type Target = { kind: 'local' } | { kind: 'google'; cal: CalendarRow } | { kind: 'ext'; cal: ExtCalendarRow };

/** Where an event should live: FamilyHub only, a Google calendar or an iCloud / CalDAV calendar. */
async function resolveTarget(calendarId: string | null | undefined): Promise<Target> {
  if (!calendarId) return { kind: 'local' };
  const g = await one<CalendarRow>('select * from google_calendars where id = $1', [calendarId]);
  if (g) {
    if (!g.sync_enabled) throw new HttpError(400, 'That calendar is not being synced');
    return { kind: 'google', cal: g };
  }
  const x = await getExtCalendar(calendarId);
  if (x) {
    if (!x.sync_enabled) throw new HttpError(400, 'That calendar is not being synced');
    return { kind: 'ext', cal: x };
  }
  throw new HttpError(404, 'Calendar not found');
}

async function createIn(t: Target, ev: LocalEventInput, userId: string): Promise<string | null> {
  if (t.kind === 'google') return createInGoogle(t.cal, ev);
  if (t.kind === 'ext') return extCreate(t.cal, { ...ev, description: ev.description ?? null, location: ev.location ?? null, rrule: ev.rrule ?? null });
  const row = await insertLocal(ev, null, userId);
  return row!.id;
}

/** Remove an event from wherever it lives (remote calendar first), then locally. */
async function removeEverywhere(existing: EventRow) {
  if (existing.calendar_id && existing.google_event_id) {
    const cal = await getCalendar(existing.calendar_id);
    if (!isWritable(cal)) throw new HttpError(403, `You don't have write access to "${cal.summary}"`);
    await pushDelete(cal, existing.google_event_id);
  } else if (existing.ext_calendar_id) {
    const cal = await getExtCalendar(existing.ext_calendar_id);
    if (cal) return extDelete(existing, cal);
  }
  await q('delete from events where id = $1', [existing.id]);
}

async function setExtras(id: string | null, color: string | null | undefined, reminderMinutes: number | null | undefined) {
  if (id) await q('update events set color = $2, reminder_minutes = $3 where id = $1', [id, color ?? null, reminderMinutes ?? null]);
}

eventsRouter.post('/', async (req, res) => {
  const b = parse(EventInput, req.body);
  const ev = toLocal(b);
  const target = await resolveTarget(b.calendarId);
  const id = await createIn(target, ev, req.user!.id);
  await setExtras(id, b.color, b.reminderMinutes);
  res.status(201).json({ id });
});

eventsRouter.patch('/:id', async (req, res) => {
  const existing = await one<EventRow>(`${SELECT} where e.id = $1`, [req.params.id]);
  if (!existing) throw new HttpError(404, 'Event not found');
  const b = parse(EventInput, req.body);
  const ev = toLocal(b);
  const targetId = b.calendarId ?? null;
  const currentId = existing.calendar_id ?? existing.ext_calendar_id ?? null;

  // Google: edit in place.
  if (existing.calendar_id && targetId === existing.calendar_id) {
    const oldCal = await getCalendar(existing.calendar_id);
    const isInstance = !!existing.google_recurring_event_id;
    if (isInstance) ev.rrule = null; // instances can't carry their own recurrence
    const ge = await pushPatch(oldCal, existing.google_event_id!, ev, !isInstance);
    if (!isInstance && ev.rrule) {
      await q('delete from events where id = $1', [existing.id]);
      await syncCalendar(oldCal.id);
      return res.json({ id: null });
    }
    await mirrorPushed(oldCal, ge);
    await setExtras(existing.id, b.color, b.reminderMinutes);
    return res.json({ id: existing.id });
  }

  // iCloud / CalDAV: edit in place.
  if (existing.ext_calendar_id && targetId === existing.ext_calendar_id) {
    const cal = await getExtCalendar(existing.ext_calendar_id);
    if (!cal) throw new HttpError(404, 'Calendar not found');
    const id = await extUpdate(existing, cal, { ...ev, description: ev.description ?? null, location: ev.location ?? null, rrule: ev.rrule ?? null });
    await setExtras(id, b.color, b.reminderMinutes);
    return res.json({ id });
  }

  if (existing.google_recurring_event_id && targetId !== currentId) {
    throw new HttpError(400, 'Occurrences of a recurring Google event cannot be moved to another calendar. Edit the series in Google Calendar.');
  }
  if (existing.recurrence_id && targetId !== currentId) {
    throw new HttpError(400, 'One changed occurrence of a repeating event can’t be moved to another calendar.');
  }

  // FamilyHub-only edit.
  if (!currentId && !targetId) {
    await q(
      `update events set title = $2, description = $3, location = $4, start_at = $5, end_at = $6, all_day = $7,
         rrule = $8, member_ids = $9, color = $10, reminder_minutes = $11, updated_at = now() where id = $1`,
      [existing.id, ev.title, ev.description, ev.location, ev.start, ev.end, ev.allDay, ev.rrule, ev.memberIds, b.color ?? null, b.reminderMinutes ?? null],
    );
    return res.json({ id: existing.id });
  }

  // Moving between FamilyHub, Google and iCloud / CalDAV: create in the new place, then remove the old one.
  const target = await resolveTarget(targetId);
  const id = await createIn(target, ev, req.user!.id);
  await removeEverywhere(existing);
  await setExtras(id, b.color, b.reminderMinutes);
  res.json({ id });
});

eventsRouter.delete('/:id', async (req, res) => {
  const existing = await one<EventRow>('select * from events where id = $1', [req.params.id]);
  if (!existing) throw new HttpError(404, 'Event not found');
  await removeEverywhere(existing);
  res.json({ ok: true });
});
