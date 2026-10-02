/**
 * Runtime settings editable by admins in the app (Settings → App settings).
 *
 * Precedence: environment variable (if set) > value saved in the app > built-in default.
 * Secrets (client secrets) are encrypted at rest and never sent back to the browser.
 */
import { q } from './db';
import { decrypt, encrypt } from './util';

export interface Settings {
  appUrl: string;
  appName: string;
  timezone: string;
  localLogin: boolean;
  oidcIssuer: string;
  oidcClientId: string;
  oidcClientSecret: string;
  oidcScopes: string;
  oidcLabel: string;
  oidcAdminGroup: string;
  oidcAutoCreate: boolean;
  googleClientId: string;
  googleClientSecret: string;
  googleSyncIntervalMinutes: number;
  googlePastDays: number;
  googleFutureDays: number;
  photosSource: string;
  photosAmazonLinks: string;
  immichUrl: string;
  immichApiKey: string;
  immichAlbumIds: string;
  photosSlideSeconds: number;
  photosRefreshMinutes: number;
  weatherEnabled: boolean;
  weatherLocationName: string;
  weatherLatitude: string;
  weatherLongitude: string;
  weatherUnits: string;
  protectUrl: string;
  protectApiKey: string;
  protectVerifyTls: boolean;
  camerasMode: string;
  camerasSelected: string;
  camerasSnapshotSeconds: number;
  camerasLiveQuality: string;
  go2rtcUrl: string;
  doorbellPopupEnabled: boolean;
  doorbellPopupSeconds: number;
  familyName: string;
  homeDefaultLayout: string;
  camerasTileQuality: string;
  camerasPreload: string;
  webrtcMode: string;
  webrtcLanAddress: string;
  webrtcPort: number;
  kioskPinHash: string;
  choreApproval: string;
  mailjetApiKey: string;
  mailjetSecretKey: string;
  mailFromEmail: string;
  mailFromName: string;
  fcmServiceAccount: string;
  fcmAndroidAppId: string;
  fcmApiKey: string;
  pushoverAppToken: string;
  pushoverUserKey: string;
  backupTime: string;
  backupKeep: number;
  reminderTime: string;
  pointsPerDollar: number;
}
export type SettingKey = keyof Settings;

interface Def {
  env: string;
  def: string | number | boolean;
  secret?: boolean;
}

export const DEFS: Record<SettingKey, Def> = {
  appUrl: { env: 'APP_URL', def: '' },
  appName: { env: 'APP_NAME', def: 'FamilyHub' },
  timezone: { env: 'TZ', def: 'UTC' },
  localLogin: { env: 'LOCAL_LOGIN_ENABLED', def: true },
  oidcIssuer: { env: 'OIDC_ISSUER', def: '' },
  oidcClientId: { env: 'OIDC_CLIENT_ID', def: '' },
  oidcClientSecret: { env: 'OIDC_CLIENT_SECRET', def: '', secret: true },
  oidcScopes: { env: 'OIDC_SCOPES', def: 'openid profile email' },
  oidcLabel: { env: 'OIDC_BUTTON_LABEL', def: 'Sign in with Authentik' },
  oidcAdminGroup: { env: 'OIDC_ADMIN_GROUP', def: '' },
  oidcAutoCreate: { env: 'OIDC_AUTO_CREATE_USERS', def: true },
  googleClientId: { env: 'GOOGLE_CLIENT_ID', def: '' },
  googleClientSecret: { env: 'GOOGLE_CLIENT_SECRET', def: '', secret: true },
  googleSyncIntervalMinutes: { env: 'GOOGLE_SYNC_INTERVAL_MINUTES', def: 5 },
  googlePastDays: { env: 'GOOGLE_SYNC_PAST_DAYS', def: 60 },
  googleFutureDays: { env: 'GOOGLE_SYNC_FUTURE_DAYS', def: 400 },
  photosSource: { env: 'PHOTOS_SOURCE', def: 'off' }, // off | amazon | immich | both
  photosAmazonLinks: { env: 'PHOTOS_AMAZON_LINKS', def: '' }, // one shared-album link per line
  immichUrl: { env: 'IMMICH_URL', def: '' },
  immichApiKey: { env: 'IMMICH_API_KEY', def: '', secret: true },
  immichAlbumIds: { env: 'IMMICH_ALBUM_IDS', def: '' }, // comma-separated; empty = favorites
  photosSlideSeconds: { env: 'PHOTOS_SLIDE_SECONDS', def: 10 },
  photosRefreshMinutes: { env: 'PHOTOS_REFRESH_MINUTES', def: 60 },
  weatherEnabled: { env: 'WEATHER_ENABLED', def: true },
  weatherLocationName: { env: 'WEATHER_LOCATION_NAME', def: '' },
  weatherLatitude: { env: 'WEATHER_LATITUDE', def: '' },
  weatherLongitude: { env: 'WEATHER_LONGITUDE', def: '' },
  weatherUnits: { env: 'WEATHER_UNITS', def: 'fahrenheit' }, // fahrenheit | celsius
  protectUrl: { env: 'PROTECT_URL', def: '' }, // e.g. https://192.168.1.1 (UniFi console)
  protectApiKey: { env: 'PROTECT_API_KEY', def: '', secret: true },
  protectVerifyTls: { env: 'PROTECT_VERIFY_TLS', def: false }, // consoles use self-signed certificates
  camerasMode: { env: 'CAMERAS_MODE', def: 'snapshots_live' }, // off | snapshots | live | snapshots_live
  camerasSelected: { env: 'CAMERAS_SELECTED', def: '' }, // ordered, comma-separated camera ids; empty = all
  camerasSnapshotSeconds: { env: 'CAMERAS_SNAPSHOT_SECONDS', def: 5 },
  camerasLiveQuality: { env: 'CAMERAS_LIVE_QUALITY', def: 'high' }, // full-screen quality: high | medium | low
  camerasTileQuality: { env: 'CAMERAS_TILE_QUALITY', def: 'low' }, // quality for small Home tiles
  camerasPreload: { env: 'CAMERAS_PRELOAD', def: 'tiles' }, // keep streams warm: off | tiles | all
  webrtcMode: { env: 'WEBRTC_MODE', def: 'off' }, // off | lan
  webrtcLanAddress: { env: 'WEBRTC_LAN_ADDRESS', def: '' }, // server's home-network IP or hostname
  webrtcPort: { env: 'WEBRTC_PORT', def: 8555 },
  go2rtcUrl: { env: 'GO2RTC_URL', def: 'http://go2rtc:1984' },
  doorbellPopupEnabled: { env: 'DOORBELL_POPUP_ENABLED', def: true },
  doorbellPopupSeconds: { env: 'DOORBELL_POPUP_SECONDS', def: 30 },
  familyName: { env: 'FAMILY_NAME', def: '' },
  homeDefaultLayout: { env: 'HOME_DEFAULT_LAYOUT', def: '' }, // JSON, managed from the Home editor
  kioskPinHash: { env: 'KIOSK_PIN_HASH', def: '', secret: true },
  choreApproval: { env: 'CHORE_APPROVAL', def: 'kids' }, // off | kids | all
  mailjetApiKey: { env: 'MAILJET_API_KEY', def: '', secret: true },
  mailjetSecretKey: { env: 'MAILJET_SECRET_KEY', def: '', secret: true },
  mailFromEmail: { env: 'MAIL_FROM_EMAIL', def: '' }, // must be a sender address verified in Mailjet
  mailFromName: { env: 'MAIL_FROM_NAME', def: '' },
  fcmServiceAccount: { env: 'FCM_SERVICE_ACCOUNT', def: '', secret: true }, // Firebase service-account JSON
  fcmAndroidAppId: { env: 'FCM_ANDROID_APP_ID', def: '' }, // e.g. 1:1234567890:android:abc123
  fcmApiKey: { env: 'FCM_API_KEY', def: '' }, // Firebase Web/Android API key (not a secret)
  pushoverAppToken: { env: 'PUSHOVER_APP_TOKEN', def: '', secret: true },
  pushoverUserKey: { env: 'PUSHOVER_USER_KEY', def: '', secret: true },
  backupTime: { env: 'BACKUP_TIME', def: '03:15' }, // HH:MM local time for the nightly backup ('' = off)
  backupKeep: { env: 'BACKUP_KEEP', def: 14 }, // how many backups to keep
  reminderTime: { env: 'REMINDER_TIME', def: '07:30' }, // HH:MM for to-do and birthday reminders
  pointsPerDollar: { env: 'POINTS_PER_DOLLAR', def: 10 }, // reward points worth $1 (0 = no money)
};

export const SETTING_KEYS = Object.keys(DEFS) as SettingKey[];

let saved: Partial<Settings> = {};
const listeners: (() => void)[] = [];

function fromEnv<K extends SettingKey>(k: K): Settings[K] | undefined {
  const raw = process.env[DEFS[k].env];
  if (raw === undefined || raw === '') return undefined;
  const d = DEFS[k].def;
  if (typeof d === 'boolean') return ['1', 'true', 'yes', 'on'].includes(raw.toLowerCase()) as Settings[K];
  if (typeof d === 'number') {
    const n = Number(raw);
    return (Number.isFinite(n) ? n : undefined) as Settings[K] | undefined;
  }
  return raw as Settings[K];
}

export function getSetting<K extends SettingKey>(k: K): Settings[K] {
  const e = fromEnv(k);
  if (e !== undefined) return e;
  const v = saved[k];
  return (v !== undefined ? v : DEFS[k].def) as Settings[K];
}

export function isLockedByEnv(k: SettingKey): boolean {
  return fromEnv(k) !== undefined;
}

export function onSettingsChange(fn: () => void) {
  listeners.push(fn);
}

export async function loadSettings(): Promise<void> {
  const rows = await q<{ key: string; value: unknown }>(`select key, value from settings where key like 'cfg:%'`);
  const next: Partial<Settings> = {};
  for (const r of rows) {
    const k = r.key.slice(4) as SettingKey;
    const def = DEFS[k];
    if (!def) continue;
    if (def.secret) {
      try {
        (next as any)[k] = decrypt(String(r.value));
      } catch {
        console.warn(`Could not decrypt saved setting "${k}" (encryption key changed?). Re-enter it in Settings.`);
      }
    } else {
      (next as any)[k] = r.value;
    }
  }
  saved = next;
  listeners.forEach((fn) => fn());
}

/** Save a partial update. `null` clears the saved value (falls back to env/default). */
export async function saveSettings(patch: Partial<Record<SettingKey, string | number | boolean | null>>): Promise<void> {
  for (const [k, v] of Object.entries(patch) as [SettingKey, string | number | boolean | null | undefined][]) {
    if (v === undefined || !DEFS[k]) continue;
    if (v === null) {
      await q('delete from settings where key = $1', [`cfg:${k}`]);
    } else {
      const stored = DEFS[k].secret ? encrypt(String(v)) : v;
      await q(`insert into settings (key, value) values ($1, $2::jsonb) on conflict (key) do update set value = excluded.value`, [
        `cfg:${k}`,
        JSON.stringify(stored),
      ]);
    }
  }
  await loadSettings();
}

/** Shape sent to the admin UI. Secret values are never included, only whether they are set. */
export function describeSettings() {
  const out: Record<string, { value?: unknown; isSet?: boolean; secret: boolean; lockedByEnv: boolean; env: string }> = {};
  for (const k of SETTING_KEYS) {
    const def = DEFS[k];
    out[k] = def.secret
      ? { isSet: !!getSetting(k), secret: true, lockedByEnv: isLockedByEnv(k), env: def.env }
      : { value: getSetting(k), secret: false, lockedByEnv: isLockedByEnv(k), env: def.env };
  }
  return out;
}
