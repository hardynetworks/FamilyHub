/**
 * Backups: a nightly snapshot of the database plus the app's secret keys, kept in BACKUP_DIR
 * (docker-compose maps it to ~/FamilyHub/backups on the server).
 *
 * Each backup is one .tar.gz holding:
 *   database.sql   pg_dump of the whole database (--clean, so restoring replaces everything)
 *   secrets.json   the session secret and encryption key from DATA_DIR (stored passwords and
 *                  tokens in the database are encrypted with it, so it must travel with the data)
 *   backup.json    when and from which version the backup was made
 *
 * Restoring makes a safety backup first, loads the SQL in one transaction, puts the keys back
 * and restarts the app (Docker starts it again).
 */
import { execFile } from 'child_process';
import crypto from 'crypto';
import express, { Router } from 'express';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { promisify } from 'util';
import { z } from 'zod';
import { dataDir, databaseUrl } from './env';
import { config } from './config';
import { getSetting, saveSettings } from './settings';
import { HttpError, parse, utcToWall } from './util';

const run = promisify(execFile);
export const backupDir = process.env.BACKUP_DIR || (process.env.NODE_ENV === 'production' ? '/backups' : path.resolve(process.cwd(), 'backups'));
const NAME_RE = /^familyhub-[A-Za-z0-9_.-]+\.tar\.gz$/;
const MAX_UPLOAD = 1024 * 1024 * 1024; // 1 GB

let lastError: string | null = null;
let lastRun: Date | null = null;
let busy = false;

export interface BackupFile {
  name: string;
  size: number;
  createdAt: string;
}

function stamp(d = new Date()) {
  // Local wall time, e.g. 2026-10-01_0315
  return utcToWall(d, config.timezone).toISOString().slice(0, 16).replace('T', '_').replace(':', '');
}

function ensureDir() {
  fs.mkdirSync(backupDir, { recursive: true });
  fs.accessSync(backupDir, fs.constants.W_OK);
}

export function listBackups(): BackupFile[] {
  let names: string[] = [];
  try {
    names = fs.readdirSync(backupDir).filter((n) => NAME_RE.test(n));
  } catch {
    return [];
  }
  return names
    .map((name) => {
      const st = fs.statSync(path.join(backupDir, name));
      return { name, size: st.size, createdAt: st.mtime.toISOString() };
    })
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

function prune() {
  const keep = Math.max(1, Math.min(365, Number(getSetting('backupKeep')) || 14));
  // Only automatic and manual backups count towards the limit; uploads and safety copies stay until deleted.
  const auto = listBackups().filter((b) => /^familyhub-\d{4}-\d{2}-\d{2}_\d{4}\.tar\.gz$/.test(b.name));
  for (const b of auto.slice(keep)) fs.rmSync(path.join(backupDir, b.name), { force: true });
}

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'familyhub-backup-'));
  try {
    return await fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** Make a backup now. `label` is added to the file name for special copies (e.g. before-restore). */
export async function createBackup(label?: string): Promise<BackupFile> {
  if (busy) throw new HttpError(409, 'A backup or restore is already running');
  busy = true;
  try {
    ensureDir();
    const name = `familyhub-${stamp()}${label ? '-' + label : ''}.tar.gz`;
    await withTempDir(async (tmp) => {
      await run('pg_dump', ['--dbname', databaseUrl, '--clean', '--if-exists', '--no-owner', '--no-privileges', '--file', path.join(tmp, 'database.sql')], {
        maxBuffer: 16 * 1024 * 1024,
        timeout: 10 * 60_000,
      });
      const secretsFile = path.join(dataDir, 'secrets.json');
      if (fs.existsSync(secretsFile)) fs.copyFileSync(secretsFile, path.join(tmp, 'secrets.json'));
      fs.writeFileSync(path.join(tmp, 'backup.json'), JSON.stringify({ app: 'FamilyHub', createdAt: new Date().toISOString(), timezone: config.timezone }, null, 2));
      const files = fs.readdirSync(tmp);
      const out = path.join(backupDir, name + '.part');
      await run('tar', ['-czf', out, '-C', tmp, ...files], { timeout: 10 * 60_000 });
      fs.renameSync(out, path.join(backupDir, name));
    });
    if (!label) prune();
    lastError = null;
    lastRun = new Date();
    const st = fs.statSync(path.join(backupDir, name));
    return { name, size: st.size, createdAt: st.mtime.toISOString() };
  } catch (e: any) {
    lastError = friendlyError(e);
    throw e instanceof HttpError ? e : new HttpError(500, lastError);
  } finally {
    busy = false;
  }
}

function friendlyError(e: any): string {
  const msg = String(e?.stderr || e?.message || e);
  if (e?.code === 'EACCES' || /permission denied/i.test(msg)) {
    return `Can't write to the backups folder. On the server run: sudo chown -R 1000:1000 ~/FamilyHub/backups`;
  }
  if (e?.code === 'ENOENT' && /pg_dump|tar|psql/.test(msg)) return 'The backup tools are missing from this FamilyHub image. Update to the latest image.';
  return msg.trim().split('\n').slice(-3).join(' ').slice(0, 500);
}

/** Restore a backup file from the backups folder, then restart the app. */
export async function restoreBackup(name: string): Promise<void> {
  if (!NAME_RE.test(name)) throw new HttpError(400, 'Unknown backup');
  const file = path.join(backupDir, name);
  if (!fs.existsSync(file)) throw new HttpError(404, 'Backup not found');
  // Check the file before touching anything.
  await withTempDir(async (tmp) => {
    try {
      await run('tar', ['-xzf', file, '-C', tmp], { timeout: 10 * 60_000 });
    } catch {
      throw new HttpError(400, "That file isn't a FamilyHub backup (it couldn't be unpacked).");
    }
    if (!fs.existsSync(path.join(tmp, 'database.sql')) || !fs.existsSync(path.join(tmp, 'backup.json'))) {
      throw new HttpError(400, "That file isn't a FamilyHub backup.");
    }
  });
  await createBackup('before-restore');
  if (busy) throw new HttpError(409, 'A backup or restore is already running');
  busy = true;
  try {
    await withTempDir(async (tmp) => {
      await run('tar', ['-xzf', file, '-C', tmp], { timeout: 10 * 60_000 });
      await run('psql', ['--dbname', databaseUrl, '--single-transaction', '--set', 'ON_ERROR_STOP=1', '--quiet', '--file', path.join(tmp, 'database.sql')], {
        maxBuffer: 64 * 1024 * 1024,
        timeout: 30 * 60_000,
      });
      const secrets = path.join(tmp, 'secrets.json');
      if (fs.existsSync(secrets) && !(process.env.SESSION_SECRET && process.env.ENCRYPTION_KEY)) {
        fs.copyFileSync(secrets, path.join(dataDir, 'secrets.json'));
      }
    });
  } catch (e: any) {
    lastError = friendlyError(e);
    throw e instanceof HttpError ? e : new HttpError(500, `Restore failed, nothing was changed: ${lastError}`);
  } finally {
    busy = false;
  }
  // Start fresh with the restored data and keys (Docker restarts the container).
  setTimeout(() => {
    console.log('Backup restored; restarting FamilyHub.');
    process.exit(0);
  }, 1500);
}

/** Nightly backup at the configured local time. */
export function startBackupSchedule() {
  let lastDay = '';
  const tick = async () => {
    try {
      const time = String(getSetting('backupTime') || '').trim();
      if (/^\d{1,2}:\d{2}$/.test(time)) {
        const wall = utcToWall(new Date(), config.timezone).toISOString();
        const day = wall.slice(0, 10);
        const now = wall.slice(11, 16);
        const [h, m] = time.split(':').map(Number);
        const target = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
        if (now >= target && lastDay !== day) {
          lastDay = day;
          const already = listBackups().some((b) => b.name.startsWith(`familyhub-${day}_`) && !b.name.includes('-before-restore'));
          if (!already) await createBackup();
        }
      }
    } catch (e: any) {
      console.warn('Nightly backup failed:', lastError ?? e.message);
    }
    setTimeout(tick, 60_000);
  };
  setTimeout(tick, 30_000);
}

// ---- Routes (mounted at /api/admin/backups behind requireAdmin) --------------------------------
export const backupsRouter = Router();

backupsRouter.get('/', (_req, res) => {
  let writable = true;
  try {
    ensureDir();
  } catch {
    writable = false;
  }
  res.json({
    backups: listBackups(),
    folder: process.env.BACKUP_HOST_DIR || '~/FamilyHub/backups',
    writable,
    busy,
    lastError: writable ? lastError : `Can't write to the backups folder. On the server run: sudo chown -R 1000:1000 ~/FamilyHub/backups`,
    lastRun,
    time: getSetting('backupTime'),
    keep: getSetting('backupKeep'),
  });
});

backupsRouter.post('/', async (_req, res) => {
  res.json(await createBackup());
});

backupsRouter.put('/settings', async (req, res) => {
  const b = parse(z.object({ time: z.string().regex(/^(|\d{1,2}:\d{2})$/), keep: z.number().int().min(1).max(365) }), req.body);
  await saveSettings({ backupTime: b.time || '', backupKeep: b.keep });
  res.json({ ok: true });
});

backupsRouter.get('/:name/download', (req, res) => {
  const name = String(req.params.name);
  if (!NAME_RE.test(name)) throw new HttpError(400, 'Unknown backup');
  const file = path.join(backupDir, name);
  if (!fs.existsSync(file)) throw new HttpError(404, 'Backup not found');
  res.download(file, name);
});

backupsRouter.delete('/:name', (req, res) => {
  const name = String(req.params.name);
  if (!NAME_RE.test(name)) throw new HttpError(400, 'Unknown backup');
  fs.rmSync(path.join(backupDir, name), { force: true });
  res.json({ ok: true });
});

backupsRouter.post('/:name/restore', async (req, res) => {
  const { confirm } = parse(z.object({ confirm: z.literal('RESTORE') }), req.body);
  void confirm;
  await restoreBackup(String(req.params.name));
  res.json({ ok: true, restarting: true });
});

/**
 * Upload a backup file (e.g. from another server); it's saved to the folder, then restored from the
 * list. Mounted before the JSON-only CSRF check, so it requires its own custom header instead
 * (browsers can't send that cross-site without a CORS preflight, which is never granted).
 */
export const backupUploadRouter = Router();
backupUploadRouter.post('/', express.raw({ type: () => true, limit: MAX_UPLOAD }), async (req, res) => {
  if (req.headers['x-familyhub-upload'] !== '1') throw new HttpError(400, 'Bad upload');
  const body = req.body as Buffer;
  if (!Buffer.isBuffer(body) || body.length < 100) throw new HttpError(400, 'Choose a backup file to upload');
  if (body[0] !== 0x1f || body[1] !== 0x8b) throw new HttpError(400, "That file isn't a FamilyHub backup (.tar.gz).");
  ensureDir();
  const name = `familyhub-${stamp()}-uploaded-${crypto.randomBytes(3).toString('hex')}.tar.gz`;
  fs.writeFileSync(path.join(backupDir, name), body);
  res.json({ name });
});
