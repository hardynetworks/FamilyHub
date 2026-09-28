/**
 * Home page layouts (the WYSIWYG Home editor).
 * Each person can have their own layout; the head of household can save one as the family default.
 * Resolution: personal layout -> family default -> built-in default (decided by the web app).
 */
import { Router } from 'express';
import { z } from 'zod';
import { requireAdmin } from '../auth';
import { one, q } from '../db';
import { getSetting, saveSettings } from '../settings';
import { parse } from '../util';

export const homeRouter = Router();

export const WIDGET_TYPES = ['header', 'weather', 'cameras', 'agenda', 'chores', 'meals', 'shopping', 'todos', 'clock', 'note'] as const;

const Widget = z.object({
  id: z.string().min(1).max(40).regex(/^[A-Za-z0-9_-]+$/),
  type: z.enum(WIDGET_TYPES),
  w: z.number().int().min(1).max(12),
  h: z.number().int().min(1).max(12),
  hidden: z.boolean().optional(),
  options: z.record(z.union([z.string().max(500), z.number(), z.boolean()])).optional(),
});

export const Layout = z.object({
  version: z.literal(1),
  widgets: z.array(Widget).max(40),
  theme: z
    .object({
      accent: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
      mode: z.enum(['auto', 'light', 'dark']).optional(),
      scale: z.enum(['sm', 'md', 'lg', 'xl']).optional(),
      background: z.enum(['plain', 'warm', 'sky', 'forest', 'dusk', 'photo']).optional(),
      density: z.enum(['cozy', 'compact']).optional(),
    })
    .default({}),
});

function familyDefault(): unknown {
  const raw = getSetting('homeDefaultLayout');
  if (!raw) return null;
  try {
    const r = Layout.safeParse(JSON.parse(raw));
    return r.success ? r.data : null;
  } catch {
    return null;
  }
}

homeRouter.get('/layout', async (req, res) => {
  const row = await one<{ layout: unknown }>(`select prefs->'homeLayout' as layout from users where id = $1`, [req.user!.id]);
  const mine = row?.layout ? Layout.safeParse(row.layout) : null;
  const fam = familyDefault();
  res.json({
    layout: mine?.success ? mine.data : fam,
    source: mine?.success ? 'mine' : fam ? 'family' : 'builtin',
    familyDefault: fam,
  });
});

homeRouter.put('/layout', async (req, res) => {
  const layout = parse(Layout, req.body?.layout);
  await q(`update users set prefs = jsonb_set(prefs, '{homeLayout}', $2::jsonb) where id = $1`, [req.user!.id, JSON.stringify(layout)]);
  res.json({ ok: true });
});

/** Go back to the family default. */
homeRouter.delete('/layout', async (req, res) => {
  await q(`update users set prefs = prefs - 'homeLayout' where id = $1`, [req.user!.id]);
  res.json({ ok: true });
});

/** Head of household: make a layout the family default (used by everyone who hasn't customized). */
homeRouter.put('/layout/family', requireAdmin, async (req, res) => {
  const layout = parse(Layout, req.body?.layout);
  await saveSettings({ homeDefaultLayout: JSON.stringify(layout) });
  res.json({ ok: true });
});

homeRouter.delete('/layout/family', requireAdmin, async (_req, res) => {
  await saveSettings({ homeDefaultLayout: null });
  res.json({ ok: true });
});
