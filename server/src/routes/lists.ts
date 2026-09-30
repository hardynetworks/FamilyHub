import { Router } from 'express';
import { z } from 'zod';
import { one, q } from '../db';
import { HttpError, isoDate, parse } from '../util';

export const listsRouter = Router();

const itemDto = (r: any) => ({
  id: r.id,
  listId: r.list_id,
  text: r.text,
  checked: r.checked,
  assigneeId: r.assignee_id,
  dueDate: r.due_date,
  priority: r.priority ?? 'none',
  sort: r.sort,
  createdAt: r.created_at,
  checkedAt: r.checked_at,
});

listsRouter.get('/', async (_req, res) => {
  const rows = await q(
    `select l.*, count(i.id) filter (where not i.checked)::int as open_count, count(i.id)::int as total_count
     from lists l left join list_items i on i.list_id = l.id group by l.id order by l.sort, l.created_at`,
  );
  res.json(rows.map((r: any) => ({ id: r.id, name: r.name, kind: r.kind, emoji: r.emoji, sort: r.sort, openCount: r.open_count, totalCount: r.total_count })));
});

const ListInput = z.object({
  name: z.string().trim().min(1).max(100),
  kind: z.enum(['shopping', 'todo']).default('todo'),
  emoji: z.string().max(16).nullish(),
});

listsRouter.post('/', async (req, res) => {
  const b = parse(ListInput, req.body);
  const r = await one(
    `insert into lists (name, kind, emoji, sort) values ($1, $2, $3, coalesce((select max(sort) + 1 from lists), 0)) returning id`,
    [b.name, b.kind, b.emoji ?? null],
  );
  res.status(201).json({ id: r!.id });
});

listsRouter.patch('/:id', async (req, res) => {
  const b = parse(ListInput.partial().extend({ sort: z.number().int().optional() }), req.body);
  await q(
    `update lists set name = coalesce($2, name), kind = coalesce($3, kind),
       emoji = case when $4::boolean then $5 else emoji end, sort = coalesce($6, sort) where id = $1`,
    [req.params.id, b.name ?? null, b.kind ?? null, b.emoji !== undefined, b.emoji ?? null, b.sort ?? null],
  );
  res.json({ ok: true });
});

listsRouter.delete('/:id', async (req, res) => {
  await q('delete from lists where id = $1', [req.params.id]);
  res.json({ ok: true });
});

listsRouter.get('/:id/items', async (req, res) => {
  const rows = await q('select * from list_items where list_id = $1 order by checked, sort, created_at', [req.params.id]);
  res.json(rows.map(itemDto));
});

/** Add one or more items (newline-separated text adds several). */
export async function addItems(listId: string, texts: string[], userId: string | null, extra: { assigneeId?: string | null; dueDate?: string | null } = {}) {
  const clean = texts.map((t) => t.trim()).filter(Boolean).slice(0, 200);
  if (!clean.length) return [];
  const list = await one('select id from lists where id = $1', [listId]);
  if (!list) throw new HttpError(404, 'List not found');
  const base = await one<{ m: number }>('select coalesce(max(sort), 0)::float8 as m from list_items where list_id = $1', [listId]);
  const ids: string[] = [];
  let sort = base?.m ?? 0;
  for (const text of clean) {
    sort += 1;
    const r = await one(
      `insert into list_items (list_id, text, assignee_id, due_date, sort, created_by) values ($1, $2, $3, $4, $5, $6) returning id`,
      [listId, text.slice(0, 500), extra.assigneeId ?? null, extra.dueDate ?? null, sort, userId],
    );
    ids.push(r!.id);
  }
  return ids;
}

listsRouter.post('/:id/items', async (req, res) => {
  const b = parse(
    z.object({ text: z.string().min(1).max(20000), assigneeId: z.string().uuid().nullish(), dueDate: isoDate.nullish() }),
    req.body,
  );
  const ids = await addItems(String(req.params.id), b.text.split('\n'), req.user!.id, b);
  res.status(201).json({ ids });
});

listsRouter.post('/:id/clear-checked', async (req, res) => {
  await q('delete from list_items where list_id = $1 and checked', [req.params.id]);
  res.json({ ok: true });
});

export const itemsRouter = Router();

itemsRouter.patch('/:id', async (req, res) => {
  const b = parse(
    z.object({
      text: z.string().trim().min(1).max(500).optional(),
      checked: z.boolean().optional(),
      assigneeId: z.string().uuid().nullish(),
      dueDate: isoDate.nullish(),
      sort: z.number().optional(),
      priority: z.enum(['none', 'low', 'medium', 'high']).optional(),
    }),
    req.body,
  );
  const r = await one(
    `update list_items set
       text = coalesce($2, text),
       checked = coalesce($3, checked),
       checked_at = case when $3 is null then checked_at when $3 then now() else null end,
       assignee_id = case when $4::boolean then $5::uuid else assignee_id end,
       due_date = case when $6::boolean then $7::date else due_date end,
       sort = coalesce($8, sort),
       priority = coalesce($9, priority)
     where id = $1 returning *`,
    [req.params.id, b.text ?? null, b.checked ?? null, b.assigneeId !== undefined, b.assigneeId ?? null, b.dueDate !== undefined, b.dueDate ?? null, b.sort ?? null, b.priority ?? null],
  );
  if (!r) throw new HttpError(404, 'Item not found');
  res.json(itemDto(r));
});

itemsRouter.delete('/:id', async (req, res) => {
  await q('delete from list_items where id = $1', [req.params.id]);
  res.json({ ok: true });
});

/** Open to-do items assigned to anyone, for the home dashboard. */
itemsRouter.get('/open-todos', async (_req, res) => {
  const rows = await q(
    `select i.*, l.name as list_name from list_items i join lists l on l.id = i.list_id
     where l.kind = 'todo' and not i.checked
     order by case i.priority when 'high' then 0 when 'medium' then 1 when 'low' then 2 else 3 end, i.due_date nulls last, i.sort limit 50`,
  );
  res.json(rows.map((r: any) => ({ ...itemDto(r), listName: r.list_name })));
});
