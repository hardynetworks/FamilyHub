import bcrypt from 'bcryptjs';
import { Request, Response, Router } from 'express';
import { z } from 'zod';
import { login, rateLimit } from '../auth';
import { baseUrl } from '../config';
import { one, q } from '../db';
import {
  DEFAULT_DEVICE_OPTIONS,
  DEVICE_COOKIE,
  DeviceRow,
  KIOSK_PAGES,
  PAIR_CODE_MINUTES,
  deviceOptions,
  hashToken,
  newPairCode,
  normalizeCode,
  publicDevice,
} from '../devices';
import { getSetting, saveSettings } from '../settings';
import { HttpError, parse, randomToken } from '../util';

const FIVE_YEARS = 5 * 365 * 24 * 60 * 60 * 1000;

function setDeviceCookie(req: Request, res: Response, token: string) {
  res.cookie(DEVICE_COOKIE, token, { httpOnly: true, sameSite: 'lax', secure: req.secure, maxAge: FIVE_YEARS, path: '/' });
}

async function checkPin(req: Request, pin: string | undefined) {
  const hash = getSetting('kioskPinHash');
  if (!hash) return; // no PIN set: the kiosk menu opens freely
  rateLimit(`kiosk-pin:${req.device?.id ?? req.ip}`);
  if (!pin || !(await bcrypt.compare(pin, hash))) throw new HttpError(401, 'Wrong PIN');
}

// ---------------------------------------------------------------------------------------------
// Screen side (/api/kiosk): pair with a code, unlock with the PIN, sign the screen out.
// ---------------------------------------------------------------------------------------------
export const kioskRouter = Router();

kioskRouter.post('/pair', async (req, res) => {
  rateLimit(`kiosk-pair:${req.ip}`);
  const { code } = parse(z.object({ code: z.string().trim().min(4).max(20) }), req.body);
  const d = await one<DeviceRow>('select * from devices where pair_code_hash = $1 and pair_expires > now()', [hashToken(normalizeCode(code))]);
  if (!d) throw new HttpError(400, 'That code is wrong or has expired. Ask a head of household for a new one.');
  const token = randomToken(32);
  await q('update devices set token_hash = $2, pair_code_hash = null, pair_expires = null, paired_at = now() where id = $1', [d.id, hashToken(token)]);
  await login(req, d.user_id, d.id);
  setDeviceCookie(req, res, token);
  res.json({ ok: true, name: d.name });
});

kioskRouter.post('/unlock', async (req, res) => {
  if (!req.device) throw new HttpError(400, 'This browser is not a kiosk screen');
  const { pin } = parse(z.object({ pin: z.string().max(20).optional() }), req.body);
  await checkPin(req, pin);
  res.json({ ok: true });
});

/** Sign this screen out (unpairs it; it stays in the list so it can be paired again). */
kioskRouter.post('/forget', async (req, res) => {
  if (!req.device) throw new HttpError(400, 'This browser is not a kiosk screen');
  const { pin } = parse(z.object({ pin: z.string().max(20).optional() }), req.body);
  await checkPin(req, pin);
  await q('update devices set token_hash = null where id = $1', [req.device.id]);
  res.clearCookie(DEVICE_COOKIE, { path: '/' });
  req.session.destroy(() => {
    res.clearCookie('familyhub.sid');
    res.json({ ok: true });
  });
});

// ---------------------------------------------------------------------------------------------
// Head-of-household side (/api/admin/devices, mounted behind requireAdmin).
// ---------------------------------------------------------------------------------------------
export const devicesAdminRouter = Router();

const Options = z
  .object({
    pages: z.array(z.enum(KIOSK_PAGES)).max(KIOSK_PAGES.length),
    returnHomeSeconds: z.number().int().min(0).max(3600),
    hideCursor: z.boolean(),
    reloadNightly: z.boolean(),
  })
  .partial();

async function memberExists(id: string) {
  if (!(await one('select 1 from users where id = $1', [id]))) throw new HttpError(400, 'Pick a family member for this screen');
}

async function openPairing(id: string) {
  const code = newPairCode();
  const d = await one<DeviceRow>(
    `update devices set pair_code_hash = $2, pair_expires = now() + make_interval(mins => $3) where id = $1 returning *`,
    [id, hashToken(normalizeCode(code)), PAIR_CODE_MINUTES],
  );
  if (!d) throw new HttpError(404, 'Screen not found');
  return { device: publicDevice(d), code };
}

devicesAdminRouter.get('/', async (req, res) => {
  const rows = await q<DeviceRow>('select * from devices order by created_at');
  res.json({ devices: rows.map(publicDevice), pinSet: !!getSetting('kioskPinHash'), pairUrl: `${baseUrl(req)}/kiosk` });
});

devicesAdminRouter.post('/', async (req, res) => {
  const b = parse(z.object({ name: z.string().trim().min(1).max(60), userId: z.string().uuid(), options: Options.optional() }), req.body);
  await memberExists(b.userId);
  const options = { ...DEFAULT_DEVICE_OPTIONS, ...(b.options ?? {}) };
  const d = await one<DeviceRow>('insert into devices (name, user_id, options, created_by) values ($1, $2, $3, $4) returning *', [
    b.name,
    b.userId,
    JSON.stringify(options),
    req.user!.id,
  ]);
  res.json(await openPairing(d!.id));
});

devicesAdminRouter.patch('/:id', async (req, res) => {
  const id = parse(z.string().uuid(), req.params.id);
  const b = parse(z.object({ name: z.string().trim().min(1).max(60).optional(), userId: z.string().uuid().optional(), options: Options.optional() }), req.body);
  const cur = await one<DeviceRow>('select * from devices where id = $1', [id]);
  if (!cur) throw new HttpError(404, 'Screen not found');
  if (b.userId) await memberExists(b.userId);
  const options = { ...deviceOptions(cur), ...(b.options ?? {}) };
  const d = await one<DeviceRow>('update devices set name = $2, user_id = $3, options = $4 where id = $1 returning *', [
    id,
    b.name ?? cur.name,
    b.userId ?? cur.user_id,
    JSON.stringify(options),
  ]);
  res.json({ device: publicDevice(d!) });
});

/** New pairing code. The screen's current sign-in is revoked, so use this to move it to new hardware too. */
devicesAdminRouter.post('/:id/pair', async (req, res) => {
  const id = parse(z.string().uuid(), req.params.id);
  await q('update devices set token_hash = null where id = $1', [id]);
  res.json(await openPairing(id));
});

devicesAdminRouter.delete('/:id', async (req, res) => {
  const id = parse(z.string().uuid(), req.params.id);
  await q('delete from devices where id = $1', [id]);
  res.json({ ok: true });
});

devicesAdminRouter.put('/pin', async (req, res) => {
  const { pin } = parse(z.object({ pin: z.string().regex(/^\d{4,8}$/, 'Use 4 to 8 digits').nullable() }), req.body);
  await saveSettings({ kioskPinHash: pin ? await bcrypt.hash(pin, 10) : null });
  res.json({ ok: true, pinSet: !!pin });
});
