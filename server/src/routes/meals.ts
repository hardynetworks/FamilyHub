import { Router } from 'express';
import { z } from 'zod';
import { one, q } from '../db';
import { HttpError, isoDate, parse } from '../util';
import { addItems } from './lists';

export const recipesRouter = Router();
export const mealsRouter = Router();

const recipeDto = (r: any) => ({
  id: r.id,
  title: r.title,
  ingredients: r.ingredients,
  instructions: r.instructions,
  sourceUrl: r.source_url,
  servings: r.servings,
  prepMinutes: r.prep_minutes,
  tags: r.tags,
  updatedAt: r.updated_at,
});

const RecipeInput = z.object({
  title: z.string().trim().min(1).max(200),
  ingredients: z.array(z.string().max(300)).max(200).default([]),
  instructions: z.string().max(50000).nullish(),
  sourceUrl: z.string().url().max(2000).nullish().or(z.literal('')),
  servings: z.number().int().min(1).max(100).nullish(),
  prepMinutes: z.number().int().min(0).max(10000).nullish(),
  tags: z.array(z.string().max(40)).max(20).default([]),
});

recipesRouter.get('/', async (_req, res) => {
  res.json((await q('select * from recipes order by lower(title)')).map(recipeDto));
});

recipesRouter.get('/:id', async (req, res) => {
  const r = await one('select * from recipes where id = $1', [req.params.id]);
  if (!r) throw new HttpError(404, 'Recipe not found');
  res.json(recipeDto(r));
});

function recipeParams(b: z.infer<typeof RecipeInput>) {
  return [
    b.title,
    b.ingredients.map((s) => s.trim()).filter(Boolean),
    b.instructions ?? null,
    b.sourceUrl || null,
    b.servings ?? null,
    b.prepMinutes ?? null,
    b.tags.map((s) => s.trim()).filter(Boolean),
  ];
}

recipesRouter.post('/', async (req, res) => {
  const b = parse(RecipeInput, req.body);
  const r = await one(
    `insert into recipes (title, ingredients, instructions, source_url, servings, prep_minutes, tags, created_by)
     values ($1, $2, $3, $4, $5, $6, $7, $8) returning *`,
    [...recipeParams(b), req.user!.id],
  );
  res.status(201).json(recipeDto(r));
});

recipesRouter.put('/:id', async (req, res) => {
  const b = parse(RecipeInput, req.body);
  const r = await one(
    `update recipes set title = $2, ingredients = $3, instructions = $4, source_url = $5, servings = $6,
       prep_minutes = $7, tags = $8, updated_at = now() where id = $1 returning *`,
    [req.params.id, ...recipeParams(b)],
  );
  if (!r) throw new HttpError(404, 'Recipe not found');
  res.json(recipeDto(r));
});

recipesRouter.delete('/:id', async (req, res) => {
  await q('delete from recipes where id = $1', [req.params.id]);
  res.json({ ok: true });
});

recipesRouter.post('/:id/to-list', async (req, res) => {
  const b = parse(z.object({ listId: z.string().uuid(), ingredients: z.array(z.string()).optional() }), req.body);
  const r = await one('select * from recipes where id = $1', [req.params.id]);
  if (!r) throw new HttpError(404, 'Recipe not found');
  const ids = await addItems(b.listId, b.ingredients ?? r.ingredients, req.user!.id);
  res.json({ added: ids.length });
});

// ---------------- Meal plan ----------------

const mealDto = (r: any) => ({
  id: r.id,
  date: r.date,
  slot: r.slot,
  recipeId: r.recipe_id,
  recipeTitle: r.recipe_title ?? null,
  title: r.title,
  notes: r.notes,
});

mealsRouter.get('/', async (req, res) => {
  const { start, end } = parse(z.object({ start: isoDate, end: isoDate }), req.query);
  const rows = await q(
    `select m.*, r.title as recipe_title from meal_plan m left join recipes r on r.id = m.recipe_id
     where m.date between $1 and $2
     order by m.date, array_position(array['breakfast','lunch','dinner','snack'], m.slot), m.created_at`,
    [start, end],
  );
  res.json(rows.map(mealDto));
});

const MealInput = z
  .object({
    date: isoDate,
    slot: z.enum(['breakfast', 'lunch', 'dinner', 'snack']),
    recipeId: z.string().uuid().nullish(),
    title: z.string().trim().max(200).nullish(),
    notes: z.string().max(2000).nullish(),
  })
  .refine((m) => m.recipeId || m.title, 'Choose a recipe or enter a meal name');

mealsRouter.post('/', async (req, res) => {
  const b = parse(MealInput, req.body);
  const r = await one(
    `insert into meal_plan (date, slot, recipe_id, title, notes) values ($1, $2, $3, $4, $5) returning id`,
    [b.date, b.slot, b.recipeId ?? null, b.title || null, b.notes ?? null],
  );
  res.status(201).json({ id: r!.id });
});

mealsRouter.put('/:id', async (req, res) => {
  const b = parse(MealInput, req.body);
  await q(`update meal_plan set date = $2, slot = $3, recipe_id = $4, title = $5, notes = $6 where id = $1`, [
    req.params.id,
    b.date,
    b.slot,
    b.recipeId ?? null,
    b.title || null,
    b.notes ?? null,
  ]);
  res.json({ ok: true });
});

mealsRouter.delete('/:id', async (req, res) => {
  await q('delete from meal_plan where id = $1', [req.params.id]);
  res.json({ ok: true });
});

/** Add all ingredients from recipes planned in a date range to a shopping list. */
mealsRouter.post('/to-list', async (req, res) => {
  const b = parse(z.object({ start: isoDate, end: isoDate, listId: z.string().uuid() }), req.body);
  const rows = await q<{ ingredients: string[] }>(
    `select r.ingredients from meal_plan m join recipes r on r.id = m.recipe_id where m.date between $1 and $2`,
    [b.start, b.end],
  );
  // De-duplicate identical lines (case-insensitive) across recipes.
  const seen = new Set<string>();
  const all: string[] = [];
  for (const r of rows)
    for (const ing of r.ingredients) {
      const k = ing.trim().toLowerCase();
      if (k && !seen.has(k)) {
        seen.add(k);
        all.push(ing.trim());
      }
    }
  const ids = await addItems(b.listId, all, req.user!.id);
  res.json({ added: ids.length });
});
