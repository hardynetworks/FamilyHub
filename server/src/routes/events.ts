import { Router } from 'express';
import { RRule } from 'rrule';
import { z } from 'zod';
import { config } from '../config';
import { one, q } from '../db';
import { CalendarRow, LocalEventInput, getCalendar, isWritable, mirrorPushed, pushCreate, pushDelete, pushPatch, syncCalendar } from '../google';
import { HttpError, parse, utcToWall, wallToUtc } from '../util';

export const eventsRouter = Router();

interface EventRow {
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
  calendar_name?: string | null;
  calendar_color?: string | null;
  access_role?: string | null;
}

const SELECT = `select e.*, gc.summary as calendar_name, gc.background_color as calendar_color, gc.access_role
                from events e left join google_calendars gc on gc.id = e.calendar_id`;

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
    calendarId: r.calendar_id,
    calendarName: r.calendar_name ?? null,
    calendarColor: r.calendar_color ?? null,
    source: r.calendar_id ? 'google' : 'local',
    isGoogleRecurringInstance: !!r.google_recurring_event_id,
    editable: !r.calendar_id || r.access_role === 'owner' || r.access_role === 'writer',
  };
}

const MAX_OCCURRENCES = 1000;

/** Expand a local recurring event into occurrences overlapping [winStart, winEnd). DST-safe for timed events. */
function expand(r: EventRow, winStart: Date, winEnd: Date): { start: Date; end: Date }[] {
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
  rule.between(from, to, true, (d) => {
    const s = fromWall(d);
    const e = new Date(s.getTime() + dur);
    if (s < winEnd && e > winStart) out.push({ start: s, end: e });
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

  let out = single.map((r) => toDto(r));
  for (const r of recurring) for (const o of expand(r, ws, we)) out.push(toDto(r, o.start, o.end));
  if (memberId) out = out.filter((e) => e.memberIds.includes(memberId));
  out.sort((a, b) => a.start.localeCompare(b.start));
  res.json(out);
});

eventsRouter.get('/targets', async (_req, res) => {
  const cals = await q<CalendarRow & { google_email: string }>(
    `select gc.*, c.google_email from google_calendars gc join google_connections c on c.id = gc.connection_id
     where gc.sync_enabled and gc.access_role in ('owner','writer') order by gc.is_primary desc, gc.summary`,
  );
  res.json(cals.map((c) => ({ id: c.id, name: c.summary, account: c.google_email, color: c.background_color, memberId: c.member_id })));
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

eventsRouter.post('/', async (req, res) => {
  const b = parse(EventInput, req.body);
  const ev = toLocal(b);
  if (b.calendarId) {
    const cal = await getCalendar(b.calendarId);
    if (!cal.sync_enabled) throw new HttpError(400, 'That calendar is not being synced');
    const id = await createInGoogle(cal, ev);
    if (id && b.color) await q('update events set color = $2 where id = $1', [id, b.color]);
    return res.status(201).json({ id });
  }
  const row = await insertLocal(ev, b.color, req.user!.id);
  res.status(201).json({ id: row!.id });
});

eventsRouter.patch('/:id', async (req, res) => {
  const existing = await one<EventRow>(`${SELECT} where e.id = $1`, [req.params.id]);
  if (!existing) throw new HttpError(404, 'Event not found');
  const b = parse(EventInput, req.body);
  const ev = toLocal(b);
  const targetCal = b.calendarId ?? null;
  const oldCal = existing.calendar_id ? await getCalendar(existing.calendar_id) : null;

  if (oldCal && targetCal === existing.calendar_id) {
    // Edit in place on Google.
    const isInstance = !!existing.google_recurring_event_id;
    if (isInstance) ev.rrule = null; // instances can't carry their own recurrence
    const ge = await pushPatch(oldCal, existing.google_event_id!, ev, !isInstance);
    if (!isInstance && ev.rrule) {
      await q('delete from events where id = $1', [existing.id]);
      await syncCalendar(oldCal.id);
      return res.json({ id: null });
    }
    await mirrorPushed(oldCal, ge);
    await q('update events set color = $2 where id = $1', [existing.id, b.color ?? null]);
    return res.json({ id: existing.id });
  }

  if (oldCal && existing.google_recurring_event_id) {
    throw new HttpError(400, 'Occurrences of a recurring Google event cannot be moved to another calendar. Edit the series in Google Calendar.');
  }

  if (targetCal) {
    // Local -> Google, or Google calendar A -> B.
    const newCal = await getCalendar(targetCal);
    if (!newCal.sync_enabled) throw new HttpError(400, 'That calendar is not being synced');
    const id = await createInGoogle(newCal, ev);
    if (oldCal) await pushDelete(oldCal, existing.google_event_id!);
    await q('delete from events where id = $1', [existing.id]);
    if (id && b.color) await q('update events set color = $2 where id = $1', [id, b.color]);
    return res.json({ id });
  }

  if (oldCal) {
    // Google -> local only.
    await pushDelete(oldCal, existing.google_event_id!);
    await q('delete from events where id = $1', [existing.id]);
    const row = await insertLocal(ev, b.color, req.user!.id);
    return res.json({ id: row!.id });
  }

  // Local edit.
  await q(
    `update events set title = $2, description = $3, location = $4, start_at = $5, end_at = $6, all_day = $7,
       rrule = $8, member_ids = $9, color = $10, updated_at = now() where id = $1`,
    [existing.id, ev.title, ev.description, ev.location, ev.start, ev.end, ev.allDay, ev.rrule, ev.memberIds, b.color ?? null],
  );
  res.json({ id: existing.id });
});

eventsRouter.delete('/:id', async (req, res) => {
  const existing = await one<EventRow>('select * from events where id = $1', [req.params.id]);
  if (!existing) throw new HttpError(404, 'Event not found');
  if (existing.calendar_id && existing.google_event_id) {
    const cal = await getCalendar(existing.calendar_id);
    if (!isWritable(cal)) throw new HttpError(403, `You don't have write access to "${cal.summary}"`);
    await pushDelete(cal, existing.google_event_id);
  }
  await q('delete from events where id = $1', [existing.id]);
  res.json({ ok: true });
});
