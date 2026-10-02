/**
 * The family info card: Wi-Fi (with a QR code guests can scan), home address, emergency and
 * other contacts (doctors, school, vet...), each person's medical notes, and free notes.
 * Everyone signed in can see it, including kiosk screens; grown-ups can change it.
 */
import { Router } from 'express';
import { z } from 'zod';
import { one, q } from './db';
import { HttpError, parse } from './util';

const str = (max: number) => z.string().trim().max(max).default('');

export const FamilyInfo = z.object({
  wifi: z
    .array(
      z.object({
        label: str(40),
        ssid: z.string().max(64).default(''),
        password: z.string().max(128).default(''),
        security: z.enum(['WPA', 'WEP', 'nopass']).default('WPA'),
        hidden: z.boolean().default(false),
      }),
    )
    .max(4)
    .default([]),
  address: str(300),
  contacts: z
    .array(
      z.object({
        category: z.enum(['emergency', 'family', 'doctor', 'dentist', 'school', 'work', 'vet', 'other']).default('other'),
        name: str(80),
        role: str(80),
        phone: str(40),
        email: str(120),
        notes: str(300),
      }),
    )
    .max(60)
    .default([]),
  medical: z
    .array(
      z.object({
        memberId: z.string().uuid(),
        allergies: str(300),
        medications: str(300),
        conditions: str(300),
        bloodType: str(10),
        notes: str(500),
      }),
    )
    .max(40)
    .default([]),
  notes: str(3000),
});
export type FamilyInfoT = z.infer<typeof FamilyInfo>;

export const familyInfoRouter = Router();

familyInfoRouter.get('/', async (_req, res) => {
  const row = await one<{ data: unknown; updated_at: Date }>('select data, updated_at from family_info where id = 1');
  const parsed = FamilyInfo.safeParse(row?.data ?? {});
  res.json({ ...(parsed.success ? parsed.data : FamilyInfo.parse({})), updatedAt: row?.updated_at ?? null });
});

familyInfoRouter.put('/', async (req, res) => {
  if (req.device) throw new HttpError(403, 'Change the family info from a phone or computer');
  if (req.user!.role !== 'admin' && req.user!.member_type === 'child') throw new HttpError(403, 'Ask a grown-up to change the family info');
  const data = parse(FamilyInfo, req.body);
  await q(
    `insert into family_info (id, data, updated_by, updated_at) values (1, $1::jsonb, $2, now())
     on conflict (id) do update set data = excluded.data, updated_by = excluded.updated_by, updated_at = now()`,
    [JSON.stringify(data), req.user!.id],
  );
  res.json({ ok: true });
});
