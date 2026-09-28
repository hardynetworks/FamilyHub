import bcrypt from 'bcryptjs';
import { Router } from 'express';
import { z } from 'zod';
import { MEMBER_COLORS, UserRow, publicUser, requireAdmin } from '../auth';
import { one, q } from '../db';
import { HttpError, parse } from '../util';

export const membersRouter = Router();

const color = z.string().regex(/^#[0-9a-fA-F]{6}$/);

membersRouter.get('/', async (_req, res) => {
  const rows = await q<UserRow>('select * from users order by created_at');
  res.json(rows.map(publicUser));
});

membersRouter.post('/', requireAdmin, async (req, res) => {
  const b = parse(
    z.object({
      name: z.string().min(1).max(100),
      email: z.string().email().nullish(),
      password: z.string().min(8).max(200).nullish(),
      role: z.enum(['admin', 'member']).default('member'),
      color: color.optional(),
      avatar: z.string().max(16).nullish(),
      canLogin: z.boolean().default(true),
    }),
    req.body,
  );
  const n = await one<{ n: number }>('select count(*)::int as n from users');
  const hash = b.password ? await bcrypt.hash(b.password, 12) : null;
  try {
    const u = await one<UserRow>(
      `insert into users (name, email, password_hash, role, color, avatar, can_login)
       values ($1, $2, $3, $4, $5, $6, $7) returning *`,
      [b.name, b.email?.toLowerCase() ?? null, hash, b.role, b.color ?? MEMBER_COLORS[(n?.n ?? 0) % MEMBER_COLORS.length], b.avatar ?? null, b.canLogin],
    );
    res.status(201).json(publicUser(u!));
  } catch (e: any) {
    if (e.code === '23505') throw new HttpError(409, 'A member with that email already exists');
    throw e;
  }
});

membersRouter.patch('/:id', async (req, res) => {
  const me = req.user!;
  const isSelf = me.id === req.params.id;
  if (!isSelf && me.role !== 'admin') throw new HttpError(403, 'You can only edit your own profile');
  const b = parse(
    z.object({
      name: z.string().min(1).max(100).optional(),
      email: z.string().email().nullish(),
      password: z.string().min(8).max(200).optional(),
      currentPassword: z.string().optional(),
      role: z.enum(['admin', 'member']).optional(),
      color: color.optional(),
      avatar: z.string().max(16).nullish(),
      canLogin: z.boolean().optional(),
      unlinkSso: z.boolean().optional(),
      prefs: z
        .object({
          slideshowEnabled: z.boolean().optional(),
          slideshowIdleMinutes: z.number().int().min(1).max(240).optional(),
          camerasMode: z.enum(['default', 'off', 'snapshots', 'live', 'snapshots_live']).optional(),
          doorbellPopup: z.boolean().optional(),
        })
        .strict()
        .optional(),
    }),
    req.body,
  );
  const target = await one<UserRow>('select * from users where id = $1', [req.params.id]);
  if (!target) throw new HttpError(404, 'Member not found');

  if (me.role !== 'admin' && (b.role !== undefined || b.canLogin !== undefined || b.email !== undefined)) {
    throw new HttpError(403, 'Only admins can change email, role or login access');
  }
  if (isSelf && (b.role === 'member' || b.canLogin === false)) {
    const admins = await one<{ n: number }>(`select count(*)::int as n from users where role = 'admin' and can_login`);
    if ((admins?.n ?? 0) <= 1 && target.role === 'admin') throw new HttpError(400, 'You are the last admin');
  }
  let hash: string | undefined;
  if (b.password) {
    if (isSelf && target.password_hash && me.role !== 'admin') {
      if (!b.currentPassword || !(await bcrypt.compare(b.currentPassword, target.password_hash))) {
        throw new HttpError(400, 'Current password is incorrect');
      }
    }
    hash = await bcrypt.hash(b.password, 12);
  }
  const u = await one<UserRow>(
    `update users set
       name = coalesce($2, name),
       email = case when $3::boolean then $4 else email end,
       password_hash = coalesce($5, password_hash),
       role = coalesce($6, role),
       color = coalesce($7, color),
       avatar = case when $8::boolean then $9 else avatar end,
       can_login = coalesce($10, can_login),
       oidc_sub = case when $11::boolean then null else oidc_sub end,
       prefs = case when $12::jsonb is null then prefs else prefs || $12::jsonb end
     where id = $1 returning *`,
    [
      req.params.id,
      b.name ?? null,
      b.email !== undefined,
      b.email?.toLowerCase() ?? null,
      hash ?? null,
      b.role ?? null,
      b.color ?? null,
      b.avatar !== undefined,
      b.avatar ?? null,
      b.canLogin ?? null,
      me.role === 'admin' && !!b.unlinkSso,
      b.prefs ? JSON.stringify(b.prefs) : null,
    ],
  );
  res.json(publicUser(u!));
});

membersRouter.delete('/:id', requireAdmin, async (req, res) => {
  if (req.params.id === req.user!.id) throw new HttpError(400, "You can't remove yourself");
  await q('delete from users where id = $1', [req.params.id]);
  res.json({ ok: true });
});
