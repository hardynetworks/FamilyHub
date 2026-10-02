/** Settings → Calendars: Apple iCloud (and other CalDAV) calendars, and .ics calendar links. */
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { ExtCalendarAccount, api } from '../lib/api';
import { useMembers, useToast } from '../lib/hooks';
import { Field, Icon, Modal } from './ui';

const ago = (s: string | null) => {
  if (!s) return 'not synced yet';
  const m = Math.round((Date.now() - new Date(s).getTime()) / 60_000);
  return m < 1 ? 'synced just now' : m < 60 ? `synced ${m} min ago` : `synced ${Math.round(m / 60)} h ago`;
};

export function ExtCalendarsCard() {
  const qc = useQueryClient();
  const toast = useToast();
  const { members } = useMembers();
  const accounts = useQuery({ queryKey: ['ext-calendars'], queryFn: () => api<ExtCalendarAccount[]>('/ext-calendars'), refetchInterval: 30_000 });
  const [adding, setAdding] = useState<'icloud' | 'caldav' | 'ics' | null>(null);
  const [password, setPassword] = useState<ExtCalendarAccount | null>(null);
  const [syncing, setSyncing] = useState<string | null>(null);

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['ext-calendars'] });
    qc.invalidateQueries({ queryKey: ['events'] });
    qc.invalidateQueries({ queryKey: ['event-targets'] });
  };
  const patchCal = async (id: string, body: Record<string, unknown>) => {
    try {
      await api(`/ext-calendars/calendars/${id}`, 'PATCH', body);
      refresh();
    } catch (e: any) {
      toast(e.message, 'error');
    }
  };
  const syncNow = async (a: ExtCalendarAccount) => {
    setSyncing(a.id);
    try {
      await api(`/ext-calendars/accounts/${a.id}/sync`, 'POST');
      toast('Calendars are up to date', 'success');
    } catch (e: any) {
      toast(e.message, 'error');
    } finally {
      setSyncing(null);
      refresh();
    }
  };
  const remove = async (a: ExtCalendarAccount) => {
    if (!confirm(`Remove ${a.name}? Its events disappear from FamilyHub (nothing is deleted from ${a.kind === 'ics' ? 'the link' : 'the account'}).`)) return;
    try {
      await api(`/ext-calendars/accounts/${a.id}`, 'DELETE');
      refresh();
    } catch (e: any) {
      toast(e.message, 'error');
    }
  };

  return (
    <section className="card">
      <h2>Apple iCloud &amp; other calendars</h2>
      <p className="muted small">
        Show Apple iCloud calendars (two-way: events you add here appear on iPhones and Macs too), other CalDAV calendars (Nextcloud, Fastmail…), or subscribe to a
        calendar link (.ics / webcal) from a school, sports team or holiday list.
      </p>
      <div className="row-wrap">
        <button className="btn btn-primary" onClick={() => setAdding('icloud')}>
          🍎 Add iCloud calendars
        </button>
        <button className="btn" onClick={() => setAdding('ics')}>
          <Icon name="plus" size={16} /> Subscribe to a calendar link
        </button>
        <button className="btn" onClick={() => setAdding('caldav')}>
          Other CalDAV server
        </button>
      </div>

      {(accounts.data ?? []).map((a) => (
        <div key={a.id} className="ext-account">
          <div className="ext-account-head">
            <span className="ext-account-icon">{a.provider === 'icloud' ? '🍎' : a.kind === 'ics' ? '🔗' : '📅'}</span>
            <div className="grow">
              <div className="ext-account-name">{a.name}</div>
              <div className="muted small">{a.kind === 'ics' ? 'Calendar link · view only' : a.provider === 'icloud' ? 'Apple iCloud' : a.url}</div>
            </div>
            {a.canEdit && (
              <>
                <button className="btn btn-sm" onClick={() => syncNow(a)} disabled={syncing === a.id}>
                  <Icon name="refresh" size={14} /> {syncing === a.id ? 'Syncing…' : 'Sync now'}
                </button>
                {a.kind === 'caldav' && (
                  <button className="btn btn-sm" onClick={() => setPassword(a)}>
                    Password
                  </button>
                )}
                <button className="icon-btn" onClick={() => remove(a)} aria-label={`Remove ${a.name}`}>
                  <Icon name="trash" size={16} />
                </button>
              </>
            )}
          </div>
          {a.lastError && <div className="alert">{a.lastError}</div>}
          {a.calendars.map((c) => (
            <div key={c.id} className="ext-cal-row">
              <label className="check-row grow">
                <input type="checkbox" checked={c.syncEnabled} disabled={!a.canEdit} onChange={(e) => patchCal(c.id, { syncEnabled: e.target.checked })} />
                <span className="cal-dot" style={{ background: c.color ?? 'var(--accent)' }} />
                <span>
                  {c.name}
                  <span className="muted small">
                    {' '}
                    · {c.writable && a.kind === 'caldav' ? 'two-way' : 'view only'} · {c.syncEnabled ? ago(c.lastSyncedAt) : 'not shown'}
                  </span>
                  {c.lastError && <span className="small" style={{ color: 'var(--danger)', display: 'block' }}>{c.lastError}</span>}
                </span>
              </label>
              <select
                className="input input-sm"
                value={c.memberId ?? ''}
                disabled={!a.canEdit}
                onChange={(e) => patchCal(c.id, { memberId: e.target.value || null })}
                aria-label={`Whose calendar is ${c.name}`}
              >
                <option value="">Whole family</option>
                {members.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))}
              </select>
            </div>
          ))}
        </div>
      ))}

      {adding && <AddModal kind={adding} onClose={() => setAdding(null)} onDone={refresh} />}
      {password && <PasswordModal account={password} onClose={() => setPassword(null)} onDone={refresh} />}
    </section>
  );
}

function AddModal({ kind, onClose, onDone }: { kind: 'icloud' | 'caldav' | 'ics'; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const { members } = useMembers();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [url, setUrl] = useState('');
  const [name, setName] = useState('');
  const [memberId, setMemberId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const save = async () => {
    setBusy(true);
    setError('');
    try {
      if (kind === 'icloud') await api('/ext-calendars/icloud', 'POST', { email, password });
      else if (kind === 'caldav') await api('/ext-calendars/caldav', 'POST', { url, username: email, password, name: name || undefined });
      else {
        const r = await api<{ events: number }>('/ext-calendars/ics', 'POST', { url, name, memberId: memberId || null });
        toast(`Subscribed: ${r.events} event${r.events === 1 ? '' : 's'} found`, 'success');
      }
      onDone();
      onClose();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  const title = kind === 'icloud' ? 'Add iCloud calendars' : kind === 'caldav' ? 'Add a CalDAV calendar' : 'Subscribe to a calendar link';
  const ready = kind === 'ics' ? url.trim() && name.trim() : kind === 'icloud' ? email.trim() && password.trim() : url.trim() && email.trim() && password;
  return (
    <Modal
      title={title}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" onClick={save} disabled={busy || !ready}>
            {busy ? 'Connecting…' : kind === 'ics' ? 'Subscribe' : 'Connect'}
          </button>
        </>
      }
    >
      <div className="form">
        {error && <div className="alert">{error}</div>}
        {kind === 'icloud' && (
          <>
            <div className="note">
              Apple needs an <strong>app-specific password</strong> for this (not your normal Apple ID password):
              <ol className="steps-list">
                <li>
                  Go to{' '}
                  <a href="https://account.apple.com" target="_blank" rel="noreferrer">
                    account.apple.com
                  </a>{' '}
                  and sign in.
                </li>
                <li>
                  Open <strong>Sign-In and Security → App-Specific Passwords</strong> and create one called “FamilyHub”.
                </li>
                <li>Copy the password it shows (like abcd-efgh-ijkl-mnop) into the box below.</li>
              </ol>
            </div>
            <Field label="Apple ID (email)">
              <input className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="off" />
            </Field>
            <Field label="App-specific password">
              <input className="input" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="abcd-efgh-ijkl-mnop" autoComplete="off" spellCheck={false} />
            </Field>
            <p className="muted small">All the calendars on that Apple ID are added and shown on your calendar. You can turn any of them off afterwards.</p>
          </>
        )}
        {kind === 'caldav' && (
          <>
            <Field label="Server address" hint="For example https://cloud.example.com/remote.php/dav (Nextcloud) or https://caldav.fastmail.com">
              <input className="input" type="url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://" />
            </Field>
            <Field label="User name">
              <input className="input" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="off" />
            </Field>
            <Field label="Password" hint="Use an app password if your provider offers them.">
              <input className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" />
            </Field>
            <Field label="Name (optional)">
              <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Work calendar" />
            </Field>
          </>
        )}
        {kind === 'ics' && (
          <>
            <Field label="Calendar link" hint="Paste the .ics or webcal:// link the school, team or website gives you. FamilyHub checks it every 15 minutes.">
              <input className="input" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="webcal://… or https://….ics" spellCheck={false} />
            </Field>
            <Field label="Name">
              <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Lincoln Elementary" maxLength={80} />
            </Field>
            <Field label="Whose calendar is it?">
              <select className="input" value={memberId} onChange={(e) => setMemberId(e.target.value)}>
                <option value="">Whole family</option>
                {members.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))}
              </select>
            </Field>
          </>
        )}
      </div>
    </Modal>
  );
}

function PasswordModal({ account, onClose, onDone }: { account: ExtCalendarAccount; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      await api(`/ext-calendars/accounts/${account.id}/password`, 'PUT', { password });
      toast('Password updated', 'success');
      onDone();
      onClose();
    } catch (e: any) {
      toast(e.message, 'error');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      title={`New password for ${account.name}`}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" onClick={save} disabled={busy || !password.trim()}>
            Save
          </button>
        </>
      }
    >
      <Field label={account.provider === 'icloud' ? 'New app-specific password' : 'New password'}>
        <input className="input" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="off" autoFocus />
      </Field>
    </Modal>
  );
}
