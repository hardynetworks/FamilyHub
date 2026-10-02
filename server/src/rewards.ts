/**
 * Reward balances. Kids earn points from approved chores; a parent's bonus adds points and a
 * cash payout takes them off. Parents keep a rewards list ("30 min of screen time = 20 pts").
 * Kids ask for a reward (on the kiosk or their phone), which waits for a parent's OK with the
 * same one-tap approve links as chores. Balances can also show as money (points per $1).
 */
import type { Request } from 'express';
import { Router } from 'express';
import { z } from 'zod';
import { baseUrl } from './config';
import { one, q } from './db';
import { hashToken } from './devices';
import { forGroup, groupFilter } from './groups';
import { notifyParents } from './notify';
import { getSetting, saveSettings } from './settings';
import { HttpError, parse, randomToken } from './util';

/** A parent (head of household, signed in on their own device). */
const isParent = (req: Request) => req.user?.role === 'admin' && !req.device;
function parentOnly(req: Request) {
  if (!isParent(req)) throw new HttpError(403, 'Only a head of household can do that');
}

interface RewardRow {
  id: string;
  title: string;
  emoji: string | null;
  cost: number;
  active: boolean;
  sort: number;
}

export interface Balance {
  memberId: string;
  earned: number;
  balance: number;
  pending: number;
  available: number;
}

export async function balances(): Promise<Balance[]> {
  const rows = await q<{ id: string; member_type: string; earned: number; adjusted: number; spent: number; pending: number }>(
    `select u.id, u.member_type,
       coalesce((select sum(points) from chore_completions where completed_by = u.id and status = 'approved'), 0)::int as earned,
       coalesce((select sum(points) from reward_adjustments where member_id = u.id), 0)::int as adjusted,
       coalesce((select sum(cost) from reward_redemptions where member_id = u.id and status = 'approved'), 0)::int as spent,
       coalesce((select sum(cost) from reward_redemptions where member_id = u.id and status = 'pending'), 0)::int as pending
     from users u order by u.created_at`,
  );
  return rows
    .filter((r) => r.member_type === 'child' || r.earned || r.adjusted || r.spent || r.pending)
    .map((r) => {
      const balance = r.earned + r.adjusted - r.spent;
      return { memberId: r.id, earned: r.earned, balance, pending: r.pending, available: balance - r.pending };
    });
}

async function balanceOf(memberId: string): Promise<Balance> {
  return (await balances()).find((b) => b.memberId === memberId) ?? { memberId, earned: 0, balance: 0, pending: 0, available: 0 };
}

function rewardDto(r: RewardRow) {
  return { id: r.id, title: r.title, emoji: r.emoji, cost: r.cost, active: r.active };
}

/** Approve or deny a reward request. Returns the row, or null if it wasn't pending. */
export async function reviewRedemption(where: { id?: string; tokenHash?: string }, approve: boolean, reviewerId: string | null) {
  const cond = where.id ? 'id = $1' : 'review_token_hash = $1';
  return one<{ id: string; status: string }>(
    `update reward_redemptions set status = $2, reviewed_by = $3, reviewed_at = now(), review_token_hash = null
     where ${cond} and status = 'pending' returning id, status`,
    [where.id ?? where.tokenHash, approve ? 'approved' : 'rejected', reviewerId],
  );
}

export async function redemptionByToken(token: string) {
  return one<{ id: string; status: string; cost: number; title: string; emoji: string | null; requested_at: Date; name: string | null }>(
    `select r.id, r.status, r.cost, r.title, r.emoji, r.requested_at, u.name
     from reward_redemptions r left join users u on u.id = r.member_id where r.review_token_hash = $1`,
    [hashToken(token)],
  );
}

// ---- Routes (mounted at /api/rewards behind requireAuth) ---------------------------------------
export const rewardsRouter = Router();

rewardsRouter.get('/', async (req, res) => {
  const group = await groupFilter(req);
  const rewards = await q<RewardRow>(`select * from rewards ${isParent(req) ? '' : 'where active'} order by sort, cost, title`);
  const bal = (await balances()).filter((b) => forGroup(group, b.memberId));
  const pending = await q<{ id: string; member_id: string; title: string; emoji: string | null; cost: number; requested_at: Date }>(
    `select id, member_id, title, emoji, cost, requested_at from reward_redemptions where status = 'pending' order by requested_at`,
  );
  const history = await q<{ kind: string; member_id: string; title: string; emoji: string | null; points: number; status: string | null; at: Date; note: string | null }>(
    `select * from (
       select 'redeem' as kind, member_id, title, emoji, -cost as points, status, requested_at as at, null as note from reward_redemptions
       union all
       select kind, member_id, coalesce(note, '') as title, null as emoji, points, null as status, created_at as at, note from reward_adjustments
     ) h order by at desc limit 40`,
  );
  res.json({
    pointsPerDollar: Number(getSetting('pointsPerDollar')) || 0,
    rewards: rewards.map(rewardDto),
    balances: bal,
    pending: pending
      .filter((p) => forGroup(group, p.member_id))
      .map((p) => ({ id: p.id, memberId: p.member_id, title: p.title, emoji: p.emoji, cost: p.cost, requestedAt: p.requested_at })),
    history: history
      .filter((h) => forGroup(group, h.member_id))
      .map((h) => ({ kind: h.kind, memberId: h.member_id, title: h.title, emoji: h.emoji, points: h.points, status: h.status, at: h.at })),
  });
});

const RewardInput = z.object({
  title: z.string().trim().min(1).max(80),
  emoji: z.string().max(16).nullish(),
  cost: z.number().int().min(1).max(100000),
  active: z.boolean().default(true),
});

rewardsRouter.post('/', async (req, res) => {
  parentOnly(req);
  const b = parse(RewardInput, req.body);
  const r = await one<RewardRow>(
    `insert into rewards (title, emoji, cost, active, sort) values ($1, $2, $3, $4, (select coalesce(max(sort), -1) + 1 from rewards)) returning *`,
    [b.title, b.emoji || null, b.cost, b.active],
  );
  res.status(201).json(rewardDto(r!));
});

rewardsRouter.put('/settings', async (req, res) => {
  parentOnly(req);
  const b = parse(z.object({ pointsPerDollar: z.number().min(0).max(100000) }), req.body);
  await saveSettings({ pointsPerDollar: b.pointsPerDollar });
  res.json({ ok: true });
});

rewardsRouter.put('/:id', async (req, res) => {
  parentOnly(req);
  const id = parse(z.string().uuid(), req.params.id);
  const b = parse(RewardInput, req.body);
  const r = await one<RewardRow>('update rewards set title = $2, emoji = $3, cost = $4, active = $5 where id = $1 returning *', [id, b.title, b.emoji || null, b.cost, b.active]);
  if (!r) throw new HttpError(404, 'Reward not found');
  res.json(rewardDto(r));
});

rewardsRouter.delete('/:id', async (req, res) => {
  parentOnly(req);
  await q('delete from rewards where id = $1', [parse(z.string().uuid(), req.params.id)]);
  res.json({ ok: true });
});

/** Ask for a reward. A parent's own request is approved straight away; anyone else's waits for a parent. */
rewardsRouter.post('/:id/redeem', async (req, res) => {
  const id = parse(z.string().uuid(), req.params.id);
  const { memberId } = parse(z.object({ memberId: z.string().uuid() }), req.body);
  const reward = await one<RewardRow>('select * from rewards where id = $1 and active', [id]);
  if (!reward) throw new HttpError(404, 'That reward isn’t available any more');
  const who = await one<{ id: string; name: string }>('select id, name from users where id = $1', [memberId]);
  if (!who) throw new HttpError(404, 'Family member not found');
  const group = await groupFilter(req);
  if (!forGroup(group, memberId)) throw new HttpError(403, 'Not on this screen');
  const bal = await balanceOf(memberId);
  const first = who.name.split(' ')[0];
  if (bal.available < reward.cost) {
    throw new HttpError(400, `${first} needs ${reward.cost - bal.available} more point${reward.cost - bal.available === 1 ? '' : 's'} for that.`);
  }
  const direct = isParent(req);
  const token = direct ? null : randomToken(24);
  const r = await one<{ id: string }>(
    `insert into reward_redemptions (reward_id, member_id, title, emoji, cost, status, requested_by, reviewed_by, reviewed_at, review_token_hash)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) returning id`,
    [
      reward.id,
      memberId,
      reward.title,
      reward.emoji,
      reward.cost,
      direct ? 'approved' : 'pending',
      req.user!.id,
      direct ? req.user!.id : null,
      direct ? new Date() : null,
      token ? hashToken(token) : null,
    ],
  );
  if (token) {
    const base = baseUrl(req);
    notifyParents({
      title: `${first} wants a reward`,
      message: `${first} wants "${reward.emoji ? reward.emoji + ' ' : ''}${reward.title}" for ${reward.cost} points (has ${bal.available}). Approve it?`,
      url: `${base}/approve/reward/${token}`,
      approveUrl: `${base}/approve/reward/${token}/approve`,
      denyUrl: `${base}/approve/reward/${token}/deny`,
    }).catch((e) => console.warn('Reward notification failed:', e.message));
  }
  res.status(201).json({ id: r!.id, pending: !direct });
});

rewardsRouter.post('/redemptions/:id', async (req, res) => {
  parentOnly(req);
  const { approve } = parse(z.object({ approve: z.boolean() }), req.body);
  const r = await reviewRedemption({ id: parse(z.string().uuid(), req.params.id) }, approve, req.user!.id);
  if (!r) throw new HttpError(409, 'This request was already handled');
  res.json({ ok: true, status: r.status });
});

/** Bonus points, a cash payout (in dollars or points) or a correction. */
rewardsRouter.post('/adjust', async (req, res) => {
  parentOnly(req);
  const b = parse(
    z.object({
      memberId: z.string().uuid(),
      kind: z.enum(['bonus', 'payout', 'adjust']),
      points: z.number().int().min(-100000).max(100000).optional(),
      dollars: z.number().min(0).max(100000).optional(),
      note: z.string().trim().max(200).nullish(),
    }),
    req.body,
  );
  let points = b.points ?? 0;
  if (b.kind === 'payout' && b.dollars !== undefined) {
    const ppd = Number(getSetting('pointsPerDollar')) || 0;
    if (!ppd) throw new HttpError(400, 'Set how many points make $1 first');
    points = Math.round(b.dollars * ppd);
  }
  if (b.kind === 'payout' || (b.kind === 'bonus' && points < 0)) points = -Math.abs(points);
  if (b.kind === 'bonus') points = Math.abs(points);
  if (!points) throw new HttpError(400, 'Enter some points');
  const note =
    b.note ||
    (b.kind === 'payout' ? (b.dollars !== undefined ? `Paid $${b.dollars.toFixed(2)}` : 'Paid out') : b.kind === 'bonus' ? 'Bonus' : 'Correction');
  await q('insert into reward_adjustments (member_id, points, kind, note, created_by) values ($1, $2, $3, $4, $5)', [b.memberId, points, b.kind, note, req.user!.id]);
  res.json({ ok: true, balance: (await balanceOf(b.memberId)).balance });
});
