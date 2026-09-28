import { Router } from 'express';
import { z } from 'zod';
import { one, q } from '../db';
import { HttpError, isoDate, parse, todayInTz } from '../util';

export const choresRouter = Router();

interface ChoreRow {
  id: string;
  title: string;
  emoji: string | null;
  assignee_id: string | null;
  points: number;
  frequency: 'once' | 'daily' | 'weekly';
  days_of_week: number[];
  due_date: string | null;
  active: boolean;
}

const dto = (r: ChoreRow) => ({
  id: r.id,
  title: r.title,
  emoji: r.emoji,
  assigneeId: r.assignee_id,
  points: r.points,
  frequency: r.frequency,
  daysOfWeek: r.days_of_week,
  dueDate: r.due_date,
  active: r.active,
});

function dow(date: string) {
  return new Date(date + 'T00:00:00Z').getUTCDay();
}

/** A one-time chore shows on its due date, and keeps showing on "today" while it's overdue and not done. */
function isDue(c: ChoreRow, date: string, today: string, doneOnce: boolean) {
  if (!c.active) return false;
  if (c.frequency === 'daily') return true;
  if (c.frequency === 'weekly') return c.days_of_week.includes(dow(date));
  if (!c.due_date) return date === today && !doneOnce;
  return c.due_date === date || (date === today && c.due_date < today && !doneOnce);
}

choresRouter.get('/', async (_req, res) => {
  const rows = await q<ChoreRow>('select * from chores order by active desc, title');
  res.json(rows.map(dto));
});

choresRouter.get('/day', async (req, res) => {
  const { date } = parse(z.object({ date: isoDate.optional() }), req.query);
  const d = date ?? todayInTz();
  const today = todayInTz();
  const chores = await q<ChoreRow>('select * from chores where active order by title');
  const doneOn = await q<{ chore_id: string; completed_by: string | null }>('select chore_id, completed_by from chore_completions where date = $1', [d]);
  const doneOnceIds = new Set(
    (await q<{ chore_id: string }>(`select distinct cc.chore_id from chore_completions cc join chores c on c.id = cc.chore_id where c.frequency = 'once'`)).map(
      (r) => r.chore_id,
    ),
  );
  const doneMap = new Map(doneOn.map((r) => [r.chore_id, r.completed_by]));
  const out = chores
    .filter((c) => isDue(c, d, today, doneOnceIds.has(c.id) && !doneMap.has(c.id)) || doneMap.has(c.id))
    .map((c) => ({ ...dto(c), done: doneMap.has(c.id), completedBy: doneMap.get(c.id) ?? null }));
  res.json({ date: d, chores: out });
});

const ChoreInput = z.object({
  title: z.string().trim().min(1).max(200),
  emoji: z.string().max(16).nullish(),
  assigneeId: z.string().uuid().nullish(),
  points: z.number().int().min(0).max(1000).default(1),
  frequency: z.enum(['once', 'daily', 'weekly']).default('daily'),
  daysOfWeek: z.array(z.number().int().min(0).max(6)).default([]),
  dueDate: isoDate.nullish(),
  active: z.boolean().default(true),
});

choresRouter.post('/', async (req, res) => {
  const b = parse(ChoreInput, req.body);
  if (b.frequency === 'weekly' && !b.daysOfWeek.length) throw new HttpError(400, 'Pick at least one day for a weekly chore');
  const r = await one(
    `insert into chores (title, emoji, assignee_id, points, frequency, days_of_week, due_date, active)
     values ($1, $2, $3, $4, $5, $6, $7, $8) returning id`,
    [b.title, b.emoji ?? null, b.assigneeId ?? null, b.points, b.frequency, b.daysOfWeek, b.dueDate ?? null, b.active],
  );
  res.status(201).json({ id: r!.id });
});

choresRouter.put('/:id', async (req, res) => {
  const b = parse(ChoreInput, req.body);
  if (b.frequency === 'weekly' && !b.daysOfWeek.length) throw new HttpError(400, 'Pick at least one day for a weekly chore');
  await q(
    `update chores set title = $2, emoji = $3, assignee_id = $4, points = $5, frequency = $6, days_of_week = $7, due_date = $8, active = $9
     where id = $1`,
    [req.params.id, b.title, b.emoji ?? null, b.assigneeId ?? null, b.points, b.frequency, b.daysOfWeek, b.dueDate ?? null, b.active],
  );
  res.json({ ok: true });
});

choresRouter.delete('/:id', async (req, res) => {
  await q('delete from chores where id = $1', [req.params.id]);
  res.json({ ok: true });
});

choresRouter.post('/:id/toggle', async (req, res) => {
  const b = parse(z.object({ date: isoDate, done: z.boolean(), completedBy: z.string().uuid().nullish() }), req.body);
  const chore = await one<ChoreRow>('select * from chores where id = $1', [req.params.id]);
  if (!chore) throw new HttpError(404, 'Chore not found');
  if (b.done) {
    await q(
      `insert into chore_completions (chore_id, date, completed_by, points) values ($1, $2, $3, $4)
       on conflict (chore_id, date) do nothing`,
      [chore.id, b.date, b.completedBy ?? chore.assignee_id ?? req.user!.id, chore.points],
    );
  } else {
    await q('delete from chore_completions where chore_id = $1 and date = $2', [chore.id, b.date]);
  }
  res.json({ ok: true });
});

choresRouter.get('/leaderboard', async (req, res) => {
  const { start, end } = parse(z.object({ start: isoDate, end: isoDate }), req.query);
  const rows = await q(
    `select completed_by as member_id, sum(points)::int as points, count(*)::int as count
     from chore_completions where date between $1 and $2 and completed_by is not null
     group by completed_by order by points desc`,
    [start, end],
  );
  res.json(rows.map((r: any) => ({ memberId: r.member_id, points: r.points, count: r.count })));
});
