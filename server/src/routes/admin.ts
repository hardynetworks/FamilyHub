import { Router } from 'express';
import { z } from 'zod';
import { fetchDiscovery } from '../auth';
import { baseUrl, config, isValidTimezone } from '../config';
import { testGoogleCredentials } from '../google';
import { SETTING_KEYS, SettingKey, describeSettings, getSetting, isLockedByEnv, saveSettings } from '../settings';
import { HttpError, parse } from '../util';

/** Admin-only app configuration (mounted behind requireAdmin). */
export const adminRouter = Router();

function snapshot(req: Parameters<typeof baseUrl>[0]) {
  const base = baseUrl(req);
  return {
    settings: describeSettings(),
    detectedUrl: `${req.protocol}://${req.get('host')}`,
    effective: {
      baseUrl: base,
      localLogin: config.localLogin,
      oidcEnabled: config.oidc.enabled,
      googleEnabled: config.google.enabled,
      timezone: config.timezone,
    },
    redirectUris: {
      oidc: `${base}/api/auth/oidc/callback`,
      google: `${base}/api/google/callback`,
    },
    dataDir: config.dataDir,
  };
}

adminRouter.get('/settings', (req, res) => {
  res.json(snapshot(req));
});

const str = (max: number) => z.string().trim().max(max).nullable().optional();
const Patch = z
  .object({
    appUrl: z
      .string()
      .trim()
      .max(300)
      .refine((v) => v === '' || /^https?:\/\/[^\s/]+(\/.*)?$/.test(v), 'must start with http:// or https://')
      .nullable()
      .optional(),
    appName: str(60),
    timezone: z.string().trim().max(80).refine(isValidTimezone, 'unknown time zone').nullable().optional(),
    localLogin: z.boolean().nullable().optional(),
    oidcIssuer: z
      .string()
      .trim()
      .max(500)
      .refine((v) => v === '' || /^https?:\/\//.test(v), 'must be a URL')
      .nullable()
      .optional(),
    oidcClientId: str(300),
    oidcClientSecret: z.string().max(1000).nullable().optional(),
    oidcScopes: str(300),
    oidcLabel: str(60),
    oidcAdminGroup: str(200),
    oidcAutoCreate: z.boolean().nullable().optional(),
    googleClientId: str(300),
    googleClientSecret: z.string().max(1000).nullable().optional(),
    googleSyncIntervalMinutes: z.number().int().min(1).max(1440).nullable().optional(),
    googlePastDays: z.number().int().min(1).max(3650).nullable().optional(),
    googleFutureDays: z.number().int().min(1).max(3650).nullable().optional(),
  })
  .strict();

adminRouter.put('/settings', async (req, res) => {
  const patch = parse(Patch, req.body) as Partial<Record<SettingKey, string | number | boolean | null>>;

  for (const k of Object.keys(patch) as SettingKey[]) {
    if (isLockedByEnv(k)) throw new HttpError(400, `${k} is set by an environment variable and can't be changed here`);
    // Empty strings clear a value (fall back to default); empty secrets mean "keep the current one".
    if (patch[k] === '') patch[k] = null;
  }
  for (const k of ['oidcClientSecret', 'googleClientSecret'] as const) {
    if (patch[k] === null && req.body[k] === '') delete patch[k];
  }
  if (patch.appUrl) patch.appUrl = String(patch.appUrl).replace(/\/+$/, '');

  // Lock-out protection: password login can only be switched off when SSO would still work.
  const nextIssuer = patch.oidcIssuer !== undefined ? patch.oidcIssuer ?? '' : getSetting('oidcIssuer');
  const nextClient = patch.oidcClientId !== undefined ? patch.oidcClientId ?? '' : getSetting('oidcClientId');
  const nextLocal = patch.localLogin !== undefined ? patch.localLogin ?? true : getSetting('localLogin');
  if (!nextLocal) {
    if (!nextIssuer || !nextClient) throw new HttpError(400, 'Set up Authentik before turning off password login.');
    if (!req.user!.oidc_sub) throw new HttpError(400, 'Sign in with Authentik at least once before turning off password login, so you can still get in.');
  }

  await saveSettings(patch);
  res.json(snapshot(req));
});

/** Clear a saved value (e.g. remove a stored client secret). */
adminRouter.delete('/settings/:key', async (req, res) => {
  const k = req.params.key as SettingKey;
  if (!SETTING_KEYS.includes(k)) throw new HttpError(404, 'Unknown setting');
  if (k === 'oidcClientSecret' && !getSetting('localLogin') && !isLockedByEnv('localLogin')) {
    throw new HttpError(400, 'Turn password login back on before removing the Authentik secret.');
  }
  await saveSettings({ [k]: null });
  res.json(snapshot(req));
});

adminRouter.post('/test/oidc', async (req, res) => {
  const b = parse(z.object({ issuer: z.string().trim().max(500).optional() }), req.body);
  const issuer = b.issuer || config.oidc.issuer;
  if (!issuer) throw new HttpError(400, 'Enter the Authentik issuer URL first');
  try {
    const doc = await fetchDiscovery(issuer);
    const iss = String(doc.issuer ?? '');
    const norm = (s: string) => s.replace(/\/+$/, '');
    res.json({
      ok: true,
      message:
        norm(iss) === norm(issuer)
          ? `Found ${iss}`
          : `Reached the server, but it reports issuer "${iss}". Use that exact value as the issuer URL.`,
      issuer: iss,
      warn: norm(iss) !== norm(issuer),
    });
  } catch (e: any) {
    res.json({ ok: false, message: e.message });
  }
});

adminRouter.post('/test/google', async (req, res) => {
  const b = parse(z.object({ clientId: z.string().trim().optional(), clientSecret: z.string().optional() }), req.body);
  const clientId = b.clientId || config.google.clientId;
  const clientSecret = b.clientSecret || config.google.clientSecret;
  if (!clientId || !clientSecret) throw new HttpError(400, 'Enter the Google client ID and secret first');
  try {
    res.json(await testGoogleCredentials(clientId, clientSecret, `${baseUrl(req)}/api/google/callback`));
  } catch (e: any) {
    res.json({ ok: false, message: `Could not reach Google: ${e.message}` });
  }
});
