/** Settings → App settings → Backups: nightly backups, download, upload and restore. */
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { BackupsData, api } from '../lib/api';
import { useToast } from '../lib/hooks';
import { Empty, Field, Icon, Modal } from './ui';

const fmtSize = (n: number) => (n > 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
const fmtWhen = (s: string) => new Date(s).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

function kindOf(name: string) {
  if (name.includes('-before-restore')) return 'Safety copy (made before a restore)';
  if (name.includes('-uploaded-')) return 'Uploaded';
  return null;
}

export function BackupsCard() {
  const qc = useQueryClient();
  const toast = useToast();
  const data = useQuery({ queryKey: ['backups'], queryFn: () => api<BackupsData>('/admin/backups'), refetchInterval: 20_000 });
  const [busy, setBusy] = useState(false);
  const [restore, setRestore] = useState<string | null>(null);
  const [time, setTime] = useState<string | null>(null);
  const [keep, setKeep] = useState<number | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const d = data.data;

  const refresh = () => qc.invalidateQueries({ queryKey: ['backups'] });
  const backupNow = async () => {
    setBusy(true);
    try {
      await api('/admin/backups', 'POST');
      toast('Backup saved', 'success');
      refresh();
    } catch (e: any) {
      toast(e.message, 'error');
    } finally {
      setBusy(false);
    }
  };
  const remove = async (name: string) => {
    if (!confirm(`Delete ${name}?`)) return;
    try {
      await api(`/admin/backups/${encodeURIComponent(name)}`, 'DELETE');
      refresh();
    } catch (e: any) {
      toast(e.message, 'error');
    }
  };
  const upload = async (f: File) => {
    setBusy(true);
    try {
      const r = await fetch('/api/admin/backups/upload', {
        method: 'POST',
        headers: { 'Content-Type': 'application/gzip', 'X-FamilyHub-Upload': '1' },
        body: f,
        credentials: 'same-origin',
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || `Upload failed (${r.status})`);
      toast('Uploaded. Choose Restore next to it to use it.', 'success');
      refresh();
    } catch (e: any) {
      toast(e.message, 'error');
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };
  const saveSchedule = async () => {
    try {
      await api('/admin/backups/settings', 'PUT', { time: time ?? d?.time ?? '03:15', keep: keep ?? d?.keep ?? 14 });
      toast('Backup schedule saved', 'success');
      setTime(null);
      setKeep(null);
      refresh();
    } catch (e: any) {
      toast(e.message, 'error');
    }
  };

  return (
    <>
      <section className="card">
        <h2>Backups</h2>
        <p className="muted small">
          Every night FamilyHub saves the whole database and its secret keys to <code>{d?.folder ?? '~/FamilyHub/backups'}</code> on the server. Copy that folder
          somewhere else now and then (another computer, a USB drive or cloud storage), so a dead disk can't take your backups with it.
        </p>
        {d && !d.writable && <div className="alert">{d.lastError}</div>}
        {d && d.writable && d.lastError && <div className="alert">Last backup failed: {d.lastError}</div>}
        <div className="row-wrap">
          <button className="btn btn-primary" onClick={backupNow} disabled={busy || !d?.writable}>
            <Icon name="download" size={16} /> {busy ? 'Working…' : 'Back up now'}
          </button>
          <button className="btn" onClick={() => fileRef.current?.click()} disabled={busy}>
            <Icon name="upload" size={16} /> Upload a backup…
          </button>
          <input ref={fileRef} type="file" accept=".gz,.tar.gz,application/gzip" hidden onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])} />
        </div>
        <div className="grid-2" style={{ marginTop: 14 }}>
          <Field label="Nightly backup time" hint="Leave empty to turn nightly backups off.">
            <input className="input" type="time" value={time ?? d?.time ?? ''} onChange={(e) => setTime(e.target.value)} />
          </Field>
          <Field label="Keep this many">
            <input className="input" type="number" min={1} max={365} value={keep ?? d?.keep ?? 14} onChange={(e) => setKeep(Number(e.target.value))} />
          </Field>
        </div>
        {(time !== null || keep !== null) && (
          <button className="btn btn-sm" onClick={saveSchedule}>
            Save schedule
          </button>
        )}
      </section>

      <section className="card">
        <h2>Saved backups</h2>
        {d && d.backups.length === 0 && <Empty icon="🗄️" title="No backups yet">The first one is made tonight, or tap Back up now.</Empty>}
        <div className="backup-list">
          {d?.backups.map((b) => (
            <div key={b.name} className="backup-row">
              <div className="grow">
                <div className="backup-name">{fmtWhen(b.createdAt)}</div>
                <div className="muted small">
                  {fmtSize(b.size)}
                  {kindOf(b.name) ? ` · ${kindOf(b.name)}` : ''}
                </div>
              </div>
              <a className="btn btn-sm" href={`/api/admin/backups/${encodeURIComponent(b.name)}/download`} download>
                <Icon name="download" size={14} /> Download
              </a>
              <button className="btn btn-sm" onClick={() => setRestore(b.name)}>
                Restore…
              </button>
              <button className="icon-btn" onClick={() => remove(b.name)} aria-label={`Delete ${b.name}`}>
                <Icon name="trash" size={16} />
              </button>
            </div>
          ))}
        </div>
      </section>
      {restore && <RestoreModal name={restore} onClose={() => setRestore(null)} />}
    </>
  );
}

function RestoreModal({ name, onClose }: { name: string; onClose: () => void }) {
  const toast = useToast();
  const [typed, setTyped] = useState('');
  const [state, setState] = useState<'idle' | 'busy' | 'restarting'>('idle');
  const go = async () => {
    setState('busy');
    try {
      await api(`/admin/backups/${encodeURIComponent(name)}/restore`, 'POST', { confirm: 'RESTORE' });
      setState('restarting');
      // The server restarts; reload once it's back.
      const started = Date.now();
      const wait = async () => {
        await new Promise((r) => setTimeout(r, 3000));
        try {
          const r = await fetch('/api/health', { cache: 'no-store' });
          if (r.ok && Date.now() - started > 6000) return location.reload();
        } catch {
          /* still restarting */
        }
        wait();
      };
      wait();
    } catch (e: any) {
      toast(e.message, 'error');
      setState('idle');
    }
  };
  return (
    <Modal
      title="Restore this backup?"
      onClose={state === 'idle' ? onClose : () => {}}
      footer={
        state === 'idle' ? (
          <>
            <button className="btn" onClick={onClose}>
              Cancel
            </button>
            <button className="btn btn-danger" disabled={typed.trim().toUpperCase() !== 'RESTORE'} onClick={go}>
              Restore
            </button>
          </>
        ) : undefined
      }
    >
      {state === 'restarting' ? (
        <div className="center-col">
          <div className="spinner" />
          <p>Restored! FamilyHub is restarting. This page reloads by itself in a moment.</p>
        </div>
      ) : (
        <div className="form">
          <p>
            Everything in FamilyHub is replaced with this backup ({name}). Changes made since then are lost. A safety copy of the current data is saved first, so
            you can go back.
          </p>
          <p className="muted small">Everyone may need to sign in again afterwards.</p>
          <Field label='Type RESTORE to confirm'>
            <input className="input" value={typed} onChange={(e) => setTyped(e.target.value)} autoFocus disabled={state === 'busy'} />
          </Field>
          {state === 'busy' && <p className="muted">Restoring… this can take a minute.</p>}
        </div>
      )}
    </Modal>
  );
}
