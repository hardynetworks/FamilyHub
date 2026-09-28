import type { Request } from 'express';
import * as env from './env';
import { getSetting } from './settings';

export function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/**
 * App configuration. Static values come from ./env; everything else is read live from the
 * settings store (editable in the app), so changes apply without a restart.
 */
export const config = {
  isProd: env.isProd,
  port: env.port,
  databaseUrl: env.databaseUrl,
  staticDir: env.staticDir,
  dataDir: env.dataDir,
  sessionSecret: env.sessionSecret,
  encryptionKey: env.encryptionKey,

  get appUrl(): string {
    return getSetting('appUrl').trim().replace(/\/+$/, '');
  },
  get appName(): string {
    return getSetting('appName') || 'FamilyHub';
  },
  get timezone(): string {
    const tz = getSetting('timezone');
    return isValidTimezone(tz) ? tz : 'UTC';
  },
  /** Password login. Always on while SSO isn't configured, so you can never lock yourself out. */
  get localLogin(): boolean {
    return getSetting('localLogin') || !config.oidc.enabled;
  },
  get oidc() {
    const issuer = getSetting('oidcIssuer').trim();
    const clientId = getSetting('oidcClientId').trim();
    return {
      enabled: !!(issuer && clientId),
      issuer,
      clientId,
      clientSecret: getSetting('oidcClientSecret'),
      scopes: getSetting('oidcScopes') || 'openid profile email',
      label: getSetting('oidcLabel') || 'Sign in with SSO',
      adminGroup: getSetting('oidcAdminGroup').trim(),
      autoCreate: getSetting('oidcAutoCreate'),
    };
  },
  get google() {
    const clientId = getSetting('googleClientId').trim();
    const clientSecret = getSetting('googleClientSecret');
    return {
      enabled: !!(clientId && clientSecret),
      clientId,
      clientSecret,
      syncIntervalMinutes: Math.max(1, getSetting('googleSyncIntervalMinutes') || 5),
      pastDays: Math.max(1, getSetting('googlePastDays') || 60),
      futureDays: Math.max(1, getSetting('googleFutureDays') || 400),
    };
  },
};

/** Public base URL: the configured App URL, or the address this request came in on. */
export function baseUrl(req: Request): string {
  return config.appUrl || `${req.protocol}://${req.get('host')}`;
}
