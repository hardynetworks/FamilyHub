/**
 * Static, process-level settings that must exist before the database is reachable.
 * This module must not import any other app module (it sits at the bottom of the import graph).
 *
 * The session secret and encryption key are generated automatically on first start and kept in
 * DATA_DIR/secrets.json (a Docker volume), so nobody has to invent or paste them. Setting
 * SESSION_SECRET / ENCRYPTION_KEY in the environment still overrides the generated values.
 */
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

export const isProd = process.env.NODE_ENV === 'production';
export const port = Number(process.env.PORT ?? 3000);
export const databaseUrl = process.env.DATABASE_URL ?? 'postgres://familyhub:familyhub@localhost:5432/familyhub';
export const staticDir = process.env.STATIC_DIR ?? path.resolve(__dirname, '../../web/dist');
export const dataDir = process.env.DATA_DIR || (isProd ? '/data' : path.resolve(process.cwd(), 'data'));

interface Secrets {
  sessionSecret: string;
  encryptionKey: string;
}

function loadOrCreateSecrets(): Secrets {
  const file = path.join(dataDir, 'secrets.json');
  let stored: Partial<Secrets> = {};
  try {
    stored = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    /* first start */
  }
  const next: Secrets = {
    sessionSecret: stored.sessionSecret || crypto.randomBytes(48).toString('base64url'),
    encryptionKey: stored.encryptionKey || crypto.randomBytes(32).toString('base64url'),
  };
  if (next.sessionSecret !== stored.sessionSecret || next.encryptionKey !== stored.encryptionKey) {
    try {
      fs.mkdirSync(dataDir, { recursive: true });
      fs.writeFileSync(file, JSON.stringify(next, null, 2), { mode: 0o600 });
      console.log(`Generated app secrets in ${file}. Back this file up together with the database.`);
    } catch (e: any) {
      console.error(`FATAL: could not write ${file} (${e.message}). Mount a writable volume at ${dataDir} or set SESSION_SECRET and ENCRYPTION_KEY.`);
      process.exit(1);
    }
  }
  return next;
}

const envSession = process.env.SESSION_SECRET;
const envKey = process.env.ENCRYPTION_KEY;
const generated = envSession && envKey ? null : loadOrCreateSecrets();

export const sessionSecret = envSession || generated!.sessionSecret;
// Backwards compatible: an env SESSION_SECRET without ENCRYPTION_KEY was previously used as the key.
export const encryptionKey = envKey || envSession || generated!.encryptionKey;
