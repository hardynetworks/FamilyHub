/**
 * Birthdays, anniversaries and other yearly dates. They show on the calendar as all-day events,
 * in the Home "Countdowns" widget, and send a reminder a few days before and on the day.
 */
import type { Request } from 'express';
import { Router } from 'express';
import { z } from 'zod';
import { one, q } from './db';
import { anyInGroup, forGroup, groupFilter } from './groups';
import { HttpError, addDays, parse, todayInTz } from './util';

export interface OccasionRow {
  id: string;
  title: string;
  kind: 'birthday' | 'anniversary' | 'other';
  month: number;
  day: number;
  year: number | null;
  member_id: string | null;
  emoji: string | null;
  remind_days: number;
}

const isLeap = (y: number) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
const pad = (n: number) => String(n).padStart(2, '0');

/** The date of an occasion in a given year (Feb 29 falls on Feb 28 in other years). */
export function dateInYear(o: Pick<OccasionRow, 'month' | 'day'>, year: number): string {
  const daysIn = [31, isLeap(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][o.month - 1];
  return `${year}-${pad(o.month)}-${pad(Math.min(o.day, daysIn))}`;
}

export function nextOccurrence(o: OccasionRow, today = todayInTz()) {
  const y = Number(today.slice(0, 4));
  let date = dateInYear(o, y);
  if (date < today) date = dateInYear(o, y + 1);
  const daysUntil = Math.round((Date.parse(date) - Date.parse(today)) / 86400_000);
  const years = o.year ? Number(date.slice(0, 4)) - o.year : null;
  return { date, daysUntil, years: years !== null && years > 0 ? years : null };
}

export const defaultEmoji = (o: Pick<OccasionRow, 'kind' | 'emoji'>) => o.emoji || (o.kind === 'birthday' ? '🎂' : o.kind === 'anniversary' ? '💍' : '⭐');

/** "Ava's birthday", "Mom & Dad's anniversary", or the title as written for other dates. */
export function occasionLabel(o: Pick<OccasionRow, 'title' | 'kind'>): string {
  if (o.kind === 'other') return o.title;
  const who = o.title.trim();
  const poss = /s$/i.test(who) ? `${who}'` : `${who}'s`;
  return `${poss} ${o.kind}`;
}

/** e.g. "turns 9", "10 years" */
export function yearsLabel(o: Pick<OccasionRow, 'kind'>, years: number | null): string {
  if (!years) return '';
  return o.kind === 'birthday' ? `turns ${years}` : `${years} year${years === 1 ? '' : 's'}`;
}

export async function listOccasions(): Promise<OccasionRow[]> {
  return q<OccasionRow>('select * from special_dates order by month, day, title');
}

/** All-day calendar entries for occasions inside [ws, we). */
export async function occasionEvents(ws: Date, we: Date, group: Set<string> | null) {
  const rows = (await listOccasions()).filter((o) => forGroup(group, o.member_id));
  const out = [];
  for (let y = ws.getUTCFullYear() - 1; y <= we.getUTCFullYear(); y++) {
    for (const o of rows) {
      const date = dateInYear(o, y);
      const start = new Date(date + 'T00:00:00Z');
      const end = new Date(start.getTime() + 86400_000);
      if (end <= ws || start >= we) continue;
      const years = o.year && y - o.year > 0 ? y - o.year : null;
      const extra = yearsLabel(o, years);
      out.push({
        id: `occasion:${o.id}`,
        instanceKey: `occasion:${o.id}:${date}`,
        title: `${defaultEmoji(o)} ${occasionLabel(o)}${extra ? ` (${extra})` : ''}`,
        description: null,
        location: null,
        start: date,
        end: addDays(date, 1),
        seriesStart: date,
        seriesEnd: addDays(date, 1),
        allDay: true,
        rrule: null,
        memberIds: o.member_id ? [o.member_id] : [],
        color: null,
        calendarId: null,
        calendarName: 'Birthdays & anniversaries',
        calendarColor: '#ec4899',
        source: 'occasion' as const,
        isGoogleRecurringInstance: false,
        editable: false,
        reminderMinutes: null,
      });
    }
  }
  return out;
}

// ---- Routes (mounted at /api/occasions behind requireAuth) -------------------------------------
export const occasionsRouter = Router();

const Input = z.object({
  title: z.string().trim().min(1).max(80),
  kind: z.enum(['birthday', 'anniversary', 'other']),
  month: z.number().int().min(1).max(12),
  day: z.number().int().min(1).max(31),
  year: z.number().int().min(1900).max(2200).nullish(),
  memberId: z.string().uuid().nullish(),
  emoji: z.string().max(16).nullish(),
  remindDays: z.number().int().min(0).max(60).default(3),
});

function dto(o: OccasionRow) {
  const n = nextOccurrence(o);
  return {
    id: o.id,
    title: o.title,
    kind: o.kind,
    month: o.month,
    day: o.day,
    year: o.year,
    memberId: o.member_id,
    emoji: defaultEmoji(o),
    customEmoji: o.emoji,
    remindDays: o.remind_days,
    label: occasionLabel(o),
    next: n.date,
    daysUntil: n.daysUntil,
    years: n.years,
    yearsLabel: yearsLabel(o, n.years),
  };
}

function noKiosk(req: Request) {
  if (req.device) throw new HttpError(403, 'Not available on a kiosk screen');
}

occasionsRouter.get('/', async (req, res) => {
  const group = await groupFilter(req);
  const rows = (await listOccasions()).filter((o) => anyInGroup(group, o.member_id ? [o.member_id] : []));
  res.json(rows.map(dto).sort((a, b) => a.daysUntil - b.daysUntil));
});

occasionsRouter.post('/', async (req, res) => {
  noKiosk(req);
  const b = parse(Input, req.body);
  const r = await one<OccasionRow>(
    `insert into special_dates (title, kind, month, day, year, member_id, emoji, remind_days, created_by) values ($1, $2, $3, $4, $5, $6, $7, $8, $9) returning *`,
    [b.title, b.kind, b.month, b.day, b.year ?? null, b.memberId ?? null, b.emoji || null, b.remindDays, req.user!.id],
  );
  res.status(201).json(dto(r!));
});

occasionsRouter.put('/:id', async (req, res) => {
  noKiosk(req);
  const id = parse(z.string().uuid(), req.params.id);
  const b = parse(Input, req.body);
  const r = await one<OccasionRow>(
    `update special_dates set title = $2, kind = $3, month = $4, day = $5, year = $6, member_id = $7, emoji = $8, remind_days = $9 where id = $1 returning *`,
    [id, b.title, b.kind, b.month, b.day, b.year ?? null, b.memberId ?? null, b.emoji || null, b.remindDays],
  );
  if (!r) throw new HttpError(404, 'Not found');
  res.json(dto(r));
});

occasionsRouter.delete('/:id', async (req, res) => {
  noKiosk(req);
  await q('delete from special_dates where id = $1', [parse(z.string().uuid(), req.params.id)]);
  res.json({ ok: true });
});
