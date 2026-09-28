import { Router } from 'express';
import { z } from 'zod';
import { fetchDiscovery } from '../auth';
import { baseUrl, config, isValidTimezone } from '../config';
import { testGoogleCredentials } from '../google';
import { getPhotos, immichAlbums } from '../photos';
import { searchLocations } from '../weather';
import { go2rtcReachable, listCameras } from '../protect';
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
    photosSource: z.enum(['off', 'amazon', 'immich', 'both']).nullable().optional(),
    photosAmazonLinks: z.string().max(10000).nullable().optional(),
    immichUrl: z
      .string()
      .trim()
      .max(500)
      .refine((v) => v === '' || /^https?:\/\//.test(v), 'must start with http:// or https://')
      .nullable()
      .optional(),
    immichApiKey: z.string().max(500).nullable().optional(),
    immichAlbumIds: z.string().max(5000).nullable().optional(),
    photosSlideSeconds: z.number().int().min(3).max(300).nullable().optional(),
    photosRefreshMinutes: z.number().int().min(5).max(1440).nullable().optional(),
    weatherEnabled: z.boolean().nullable().optional(),
    weatherLocationName: str(200),
    weatherLatitude: z
      .string()
      .trim()
      .refine((v) => v === '' || (Math.abs(Number(v)) <= 90 && v !== ''), 'invalid latitude')
      .nullable()
      .optional(),
    weatherLongitude: z
      .string()
      .trim()
      .refine((v) => v === '' || (Math.abs(Number(v)) <= 180 && v !== ''), 'invalid longitude')
      .nullable()
      .optional(),
    weatherUnits: z.enum(['fahrenheit', 'celsius']).nullable().optional(),
    protectUrl: z
      .string()
      .trim()
      .max(300)
      .refine((v) => v === '' || /^https?:\/\/[^\s/]+\/?$/.test(v), 'use just the console address, e.g. https://192.168.1.1')
      .nullable()
      .optional(),
    protectApiKey: z.string().max(500).nullable().optional(),
    protectVerifyTls: z.boolean().nullable().optional(),
    camerasMode: z.enum(['off', 'snapshots', 'live', 'snapshots_live']).nullable().optional(),
    camerasSelected: z.string().max(5000).nullable().optional(),
    camerasSnapshotSeconds: z.number().int().min(1).max(60).nullable().optional(),
    camerasLiveQuality: z.enum(['high', 'medium', 'low']).nullable().optional(),
    go2rtcUrl: z
      .string()
      .trim()
      .max(300)
      .refine((v) => v === '' || /^https?:\/\//.test(v), 'must start with http:// or https://')
      .nullable()
      .optional(),
    doorbellPopupEnabled: z.boolean().nullable().optional(),
    doorbellPopupSeconds: z.number().int().min(5).max(300).nullable().optional(),
    familyName: str(80),
  })
  .strict();

adminRouter.put('/settings', async (req, res) => {
  const patch = parse(Patch, req.body) as Partial<Record<SettingKey, string | number | boolean | null>>;

  for (const k of Object.keys(patch) as SettingKey[]) {
    if (isLockedByEnv(k)) throw new HttpError(400, `${k} is set by an environment variable and can't be changed here`);
    // Empty strings clear a value (fall back to default); empty secrets mean "keep the current one".
    if (patch[k] === '') patch[k] = null;
  }
  for (const k of ['oidcClientSecret', 'googleClientSecret', 'immichApiKey', 'protectApiKey'] as const) {
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

/** Reload photos now and report what was found (used by the "Load photos" button). */
adminRouter.post('/photos/refresh', async (_req, res) => {
  const c = await getPhotos(true);
  res.json({ total: c.photos.length, counts: c.counts, errors: c.errors });
});

/** List Immich albums for the album picker. Uses the form's unsaved URL/key if given. */
adminRouter.post('/immich/albums', async (req, res) => {
  const b = parse(z.object({ url: z.string().trim().max(500).optional(), apiKey: z.string().max(500).optional() }), req.body);
  const url = b.url || getSetting('immichUrl');
  const apiKey = b.apiKey || getSetting('immichApiKey');
  if (!url || !apiKey) throw new HttpError(400, 'Enter the Immich URL and API key first');
  try {
    res.json({ ok: true, albums: await immichAlbums(url, apiKey) });
  } catch (e: any) {
    const msg = e.status === 401 ? 'Immich rejected the API key' : `Could not reach Immich: ${e.cause?.code ?? e.message}`;
    res.json({ ok: false, message: msg, albums: [] });
  }
});

/** Location search for the weather picker (Open-Meteo geocoding). */
adminRouter.get('/weather/search', async (req, res) => {
  const { q } = parse(z.object({ q: z.string().trim().min(2).max(100) }), req.query);
  res.json(await searchLocations(q));
});

/** Test the UniFi Protect connection (unsaved form values allowed) and list cameras for the picker. */
adminRouter.post('/protect/test', async (req, res) => {
  const b = parse(
    z.object({ url: z.string().trim().max(300).optional(), apiKey: z.string().max(500).optional(), verifyTls: z.boolean().optional(), go2rtcUrl: z.string().trim().max(300).optional() }),
    req.body,
  );
  const url = (b.url || getSetting('protectUrl')).replace(/\/+$/, '');
  const apiKey = b.apiKey || getSetting('protectApiKey');
  if (!url || !apiKey) throw new HttpError(400, 'Enter the console address and API key first');
  const go2rtc = await go2rtcReachable((b.go2rtcUrl || getSetting('go2rtcUrl')).replace(/\/+$/, ''));
  try {
    const cameras = await listCameras({ url, apiKey, verifyTls: b.verifyTls ?? getSetting('protectVerifyTls') }, false);
    res.json({ ok: true, cameras, go2rtc, message: `Connected: ${cameras.length} camera${cameras.length === 1 ? '' : 's'} found. Live video relay: ${go2rtc ? 'reachable' : 'not reachable'}.` });
  } catch (e: any) {
    res.json({ ok: false, cameras: [], go2rtc, message: e.message });
  }
});
