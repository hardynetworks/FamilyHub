/**
 * Family groups (Parents, Kids, ... ): named sets of family members.
 *
 * A kiosk screen can be set to show one group. Everything that screen loads is then narrowed
 * to that group: calendar events that include someone in the group (or no one in particular),
 * chores and to-dos assigned to someone in the group (or to no one), and the family list.
 */
import type { Request } from 'express';
import { Router } from 'express';
import { z } from 'zod';
import { requireAdmin } from './auth';
import { one, q } from './db';
import { deviceOptions } from './devices';
import { HttpError, parse } from './util';

export interface FamilyGroup {
  id: string;
  name: string;
  emoji: string | null;
  color: string;
  sort: number;
  memberIds: string[];
}

export async function listGroups(): Promise<FamilyGroup[]> {
  const rows = await q<{ id: string; name: string; emoji: string | null; color: string; sort: number; member_ids: string[] | null }>(
    `select g.id, g.name, g.emoji, g.color, g.sort,
            coalesce(array_agg(m.user_id::text) filter (where m.user_id is not null), '{}'::text[]) as member_ids
     from family_groups g left join family_group_members m on m.group_id = g.id
     group by g.id order by g.sort, g.created_at`,
  );
  return rows.map((r) => ({ id: r.id, name: r.name, emoji: r.emoji, color: r.color, sort: r.sort, memberIds: r.member_ids ?? [] }));
}

export async function getGroup(id: string): Promise<FamilyGroup | null> {
  return (await listGroups()).find((g) => g.id === id) ?? null;
}

/** The group a kiosk screen is showing, if any. */
export async function deviceGroup(req: Request): Promise<FamilyGroup | null> {
  if (!req.device) return null;
  const id = deviceOptions(req.device).groupId;
  if (!id) return null;
  if (req.groupCache !== undefined) return req.groupCache as FamilyGroup | null;
  const g = await getGroup(id);
  req.groupCache = g;
  return g;
}

/**
 * Filter for this request: null means "everyone" (normal sign-ins and screens showing the whole
 * family). Otherwise the set of member ids in the screen's group.
 */
export async function groupFilter(req: Request): Promise<Set<string> | null> {
  const g = await deviceGroup(req);
  return g ? new Set(g.memberIds) : null;
}

/** Assigned to someone in the group, or to no one in particular. */
export const forGroup = (set: Set<string> | null, memberId: string | null | undefined) => !set || !memberId || set.has(memberId);
/** Includes someone in the group, or no one in particular. */
export const anyInGroup = (set: Set<string> | null, memberIds: string[]) => !set || !memberIds.length || memberIds.some((id) => set.has(id));

// ---- Routes (mounted at /api/groups behind requireAuth) ----------------------------------------
export const groupsRouter = Router();

const GroupInput = z.object({
  name: z.string().trim().min(1).max(40),
  emoji: z.string().max(16).nullish(),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  memberIds: z.array(z.string().uuid()).max(100).default([]),
});

async function setMembers(groupId: string, memberIds: string[]) {
  await q('delete from family_group_members where group_id = $1', [groupId]);
  if (memberIds.length) {
    await q(
      `insert into family_group_members (group_id, user_id) select $1::uuid, u.id from users u where u.id = any($2::uuid[]) on conflict do nothing`,
      [groupId, memberIds],
    );
  }
}

groupsRouter.get('/', async (_req, res) => {
  res.json(await listGroups());
});

groupsRouter.post('/', requireAdmin, async (req, res) => {
  const b = parse(GroupInput, req.body);
  const count = await one<{ n: number }>('select count(*)::int as n from family_groups');
  if ((count?.n ?? 0) >= 20) throw new HttpError(400, 'That’s a lot of groups! Remove one first.');
  const r = await one<{ id: string }>(
    `insert into family_groups (name, emoji, color, sort) values ($1, $2, $3, (select coalesce(max(sort), -1) + 1 from family_groups)) returning id`,
    [b.name, b.emoji ?? null, b.color ?? '#6366f1'],
  );
  await setMembers(r!.id, b.memberIds);
  res.status(201).json(await getGroup(r!.id));
});

groupsRouter.put('/:id', requireAdmin, async (req, res) => {
  const id = parse(z.string().uuid(), req.params.id);
  const b = parse(GroupInput, req.body);
  const r = await one('update family_groups set name = $2, emoji = $3, color = coalesce($4, color) where id = $1 returning id', [
    id,
    b.name,
    b.emoji ?? null,
    b.color ?? null,
  ]);
  if (!r) throw new HttpError(404, 'Group not found');
  await setMembers(id, b.memberIds);
  res.json(await getGroup(id));
});

groupsRouter.delete('/:id', requireAdmin, async (req, res) => {
  const id = parse(z.string().uuid(), req.params.id);
  await q('delete from family_groups where id = $1', [id]);
  // Screens that showed this group go back to the whole family.
  await q(`update devices set options = options - 'groupId' where options->>'groupId' = $1`, [id]);
  res.json({ ok: true });
});
