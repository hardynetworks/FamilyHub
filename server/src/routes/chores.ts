import { Router } from 'express';
import { z } from 'zod';
import type { Request } from 'express';
import { baseUrl } from '../config';
import { one, q } from '../db';
import { hashToken } from '../devices';
import { notifyParents } from '../notify';
import { getSetting } from '../settings';
import { HttpError, isoDate, parse, randomToken, todayInTz } from '../util';

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
  const doneOn = await q<{ chore_id: string; completed_by: string | null; status: string }>(
    'select chore_id, completed_by, status from chore_completions where date = $1',
    [d],
  );
  const doneOnceIds = new Set(
    (
      await q<{ chore_id: string }>(
        `select distinct cc.chore_id from chore_completions cc join chores c on c.id = cc.chore_id where c.frequency = 'once' and cc.status <> 'rejected'`,
      )
    ).map((r) => r.chore_id),
  );
  const byChore = new Map(doneOn.map((r) => [r.chore_id, r]));
  const out = chores
    .filter((c) => {
      const cc = byChore.get(c.id);
      const counted = !!cc && cc.status !== 'rejected';
      return isDue(c, d, today, doneOnceIds.has(c.id) && !counted) || !!cc;
    })
    .map((c) => {
      const cc = byChore.get(c.id);
      const status = cc?.status ?? null;
      return {
        ...dto(c),
        done: status === 'approved' || status === 'pending',
        status,
        completedBy: cc?.completed_by ?? null,
      };
    });
  res.json({ date: d, chores: out, approval: getSetting('choreApproval') });
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

/** A parent (head of household, signed in on their own device) ticking a chore approves it straight away. */
const isParent = (req: Request) => req.user?.role === 'admin' && !req.device;

choresRouter.post('/:id/toggle', async (req, res) => {
  const b = parse(z.object({ date: isoDate, done: z.boolean(), completedBy: z.string().uuid().nullish() }), req.body);
  const chore = await one<ChoreRow>('select * from chores where id = $1', [req.params.id]);
  if (!chore) throw new HttpError(404, 'Chore not found');
  if (!b.done) {
    await q('delete from chore_completions where chore_id = $1 and date = $2', [chore.id, b.date]);
    return res.json({ ok: true });
  }
  const completedBy = b.completedBy ?? chore.assignee_id ?? req.user!.id;
  const who = await one<{ name: string; member_type: string }>('select name, member_type from users where id = $1', [completedBy]);
  const mode = getSetting('choreApproval');
  const pending = mode !== 'off' && !isParent(req) && (mode === 'all' || who?.member_type === 'child');
  const token = pending ? randomToken(24) : null;
  const row = await one<{ id: string }>(
    `insert into chore_completions (chore_id, date, completed_by, points, status, review_token_hash, reviewed_by, reviewed_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8)
     on conflict (chore_id, date) do update set
       completed_by = excluded.completed_by, points = excluded.points, status = excluded.status, completed_at = now(),
       review_token_hash = excluded.review_token_hash, reviewed_by = excluded.reviewed_by, reviewed_at = excluded.reviewed_at
     where chore_completions.status = 'rejected'
     returning id`,
    [
      chore.id,
      b.date,
      completedBy,
      chore.points,
      pending ? 'pending' : 'approved',
      token ? hashToken(token) : null,
      pending ? null : req.user!.id,
      pending ? null : new Date(),
    ],
  );
  if (row && pending && token) {
    const base = baseUrl(req);
    const name = who?.name?.split(' ')[0] ?? 'Someone';
    const choreName = `${chore.emoji ? chore.emoji + ' ' : ''}${chore.title}`;
    // Fire and forget: the child sees "waiting for approval" right away.
    notifyParents({
      title: `${name} finished a chore`,
      message: `${name} says "${choreName}" is done${chore.points ? ` (+${chore.points} point${chore.points === 1 ? '' : 's'})` : ''}. Approve it?`,
      url: `${base}/approve/${token}`,
    }).catch((e) => console.warn('Approval notification failed:', e.message));
  }
  res.json({ ok: true, pending });
});

/** Approve or deny a completion. Returns the updated row, or null if it wasn't pending. */
export async function reviewCompletion(where: { id?: string; tokenHash?: string }, approve: boolean, reviewerId: string | null) {
  const cond = where.id ? 'id = $1' : 'review_token_hash = $1';
  return one<{ id: string; status: string }>(
    `update chore_completions set status = $2, reviewed_by = $3, reviewed_at = now(), review_token_hash = null
     where ${cond} and status = 'pending' returning id, status`,
    [where.id ?? where.tokenHash, approve ? 'approved' : 'rejected', reviewerId],
  );
}

/** Chores waiting for a parent's OK. */
choresRouter.get('/approvals', async (_req, res) => {
  const rows = await q(
    `select cc.id, cc.date, cc.completed_by, cc.completed_at, cc.points, c.title, c.emoji
     from chore_completions cc join chores c on c.id = cc.chore_id
     where cc.status = 'pending' order by cc.completed_at`,
  );
  res.json(
    rows.map((r: any) => ({ id: r.id, date: r.date, completedBy: r.completed_by, completedAt: r.completed_at, points: r.points, title: r.title, emoji: r.emoji })),
  );
});

choresRouter.post('/approvals/:id', async (req, res) => {
  if (!isParent(req)) throw new HttpError(403, 'Only a head of household can approve chores');
  const { approve } = parse(z.object({ approve: z.boolean() }), req.body);
  const r = await reviewCompletion({ id: String(req.params.id) }, approve, req.user!.id);
  if (!r) throw new HttpError(409, 'This chore was already reviewed');
  res.json({ ok: true, status: r.status });
});

choresRouter.get('/leaderboard', async (req, res) => {
  const { start, end } = parse(z.object({ start: isoDate, end: isoDate }), req.query);
  const rows = await q(
    `select completed_by as member_id, sum(points)::int as points, count(*)::int as count
     from chore_completions where date between $1 and $2 and completed_by is not null and status = 'approved'
     group by completed_by order by points desc`,
    [start, end],
  );
  res.json(rows.map((r: any) => ({ memberId: r.member_id, points: r.points, count: r.count })));
});
