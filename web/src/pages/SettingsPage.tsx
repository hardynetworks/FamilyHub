import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { AppSettings } from '../components/AppSettings';
import { useCameras } from '../components/Cameras';
import { Avatar, COLOR_CHOICES, EMOJI_CHOICES, Field, Icon, Modal } from '../components/ui';
import { GoogleStatus, Member, api } from '../lib/api';
import { useAction, useAuthStatus, useMe, useMembers, useToast } from '../lib/hooks';

export function SettingsPage({ onLogout }: { onLogout: () => void }) {
  const me = useMe();
  const status = useAuthStatus().data!;
  const toast = useToast();

  useEffect(() => {
    const p = new URLSearchParams(location.search);
    if (p.get('google') === 'connected') toast('Google account connected', 'success');
    if (p.get('googleError')) toast(`Google connection failed: ${p.get('googleError')}`, 'error');
    if (p.toString()) history.replaceState(null, '', '/settings' + location.hash);
  }, [toast]);

  return (
    <div className="page page-settings">
      <header className="page-head">
        <h1>Settings</h1>
        <button className="btn" onClick={onLogout}>
          <Icon name="logout" size={16} /> Sign out
        </button>
      </header>
      <ProfileCard />
      <SlideshowPrefsCard />
      <CameraPrefsCard />
      <FamilyCard />
      <GoogleCard />
      {me.role === 'admin' && <AppSettings />}
      <section className="card">
        <h2>About</h2>
        <p className="muted small">
          {status.appName} · time zone {status.timezone} · signed in as {me.email ?? me.name}
          {me.linkedSso ? ' (SSO)' : ''}
        </p>
      </section>
    </div>
  );
}

function ProfileCard() {
  const me = useMe();
  const qc = useQueryClient();
  const [edit, setEdit] = useState(false);
  return (
    <section className="card">
      <div className="card-head">
        <h2>My profile</h2>
        <button className="btn btn-sm" onClick={() => setEdit(true)}>Edit</button>
      </div>
      <div className="row">
        <Avatar member={me} size={48} />
        <div>
          <div className="strong">{me.name}</div>
          <div className="muted small">{me.email}{me.role === 'admin' ? ' · Admin' : ''}</div>
        </div>
      </div>
      {edit && <MemberModal member={me} self onClose={() => { setEdit(false); qc.invalidateQueries({ queryKey: ['auth'] }); }} />}
    </section>
  );
}

function SlideshowPrefsCard() {
  const me = useMe();
  const qc = useQueryClient();
  const toast = useToast();
  const [minutes, setMinutes] = useState(String(me.prefs.slideshowIdleMinutes));
  const save = async (prefs: Partial<Member['prefs']>) => {
    try {
      await api(`/members/${me.id}`, 'PATCH', { prefs });
      await qc.invalidateQueries({ queryKey: ['auth'] });
      toast('Slideshow setting saved', 'success');
    } catch (e: any) {
      toast(e.message, 'error');
    }
  };
  const commitMinutes = () => {
    const n = Math.round(Number(minutes));
    if (!Number.isFinite(n) || n < 1 || n > 240) {
      setMinutes(String(me.prefs.slideshowIdleMinutes));
      return toast('Enter a number of minutes between 1 and 240', 'error');
    }
    if (n !== me.prefs.slideshowIdleMinutes) save({ slideshowIdleMinutes: n });
  };
  return (
    <section className="card">
      <div className="card-head">
        <h2>
          <Icon name="image" size={18} /> Photo slideshow
        </h2>
      </div>
      <div className="form">
        <label className="toggle">
          <input type="checkbox" checked={me.prefs.slideshowEnabled} onChange={(e) => save({ slideshowEnabled: e.target.checked })} /> Show a photo slideshow on the Home page
          when I'm idle
        </label>
        {me.prefs.slideshowEnabled && (
          <Field label="Start after (minutes of inactivity)">
            <input
              className="input input-narrow"
              type="number"
              min={1}
              max={240}
              value={minutes}
              onChange={(e) => setMinutes(e.target.value)}
              onBlur={commitMinutes}
              onKeyDown={(e) => e.key === 'Enter' && commitMinutes()}
            />
          </Field>
        )}
        <p className="muted small">
          These settings are yours only. Touching the screen, clicking or pressing a key closes the slideshow. An admin chooses where the photos come from under App settings →
          Photos.
        </p>
      </div>
    </section>
  );
}

function CameraPrefsCard() {
  const me = useMe();
  const qc = useQueryClient();
  const toast = useToast();
  const cams = useCameras();
  if (!cams.data?.enabled) return null;
  const save = async (prefs: Partial<Member['prefs']>) => {
    try {
      await api(`/members/${me.id}`, 'PATCH', { prefs });
      await qc.invalidateQueries({ queryKey: ['auth'] });
      await qc.invalidateQueries({ queryKey: ['cameras'] });
      toast('Camera setting saved', 'success');
    } catch (e: any) {
      toast(e.message, 'error');
    }
  };
  return (
    <section className="card">
      <div className="card-head">
        <h2>
          <Icon name="camera" size={18} /> Cameras
        </h2>
      </div>
      <div className="form">
        <Field label="Show cameras on my Home page as">
          <select className="input" value={me.prefs.camerasMode} onChange={(e) => save({ camerasMode: e.target.value as Member['prefs']['camerasMode'] })}>
            <option value="default">Family default</option>
            <option value="snapshots_live">Snapshots, live video when tapped</option>
            <option value="snapshots">Snapshots only</option>
            <option value="live">Live video</option>
            <option value="off">Hidden</option>
          </select>
        </Field>
        <label className="toggle">
          <input type="checkbox" checked={me.prefs.doorbellPopup} onChange={(e) => save({ doorbellPopup: e.target.checked })} /> Pop up the doorbell camera on my screens
          when someone rings
        </label>
        <p className="muted small">Live video uses more data and battery than snapshots; "Snapshots, live when tapped" is a good fit for phones and wall tablets.</p>
      </div>
    </section>
  );
}

function FamilyCard() {
  const me = useMe();
  const { members } = useMembers();
  const [editing, setEditing] = useState<Member | 'new' | null>(null);
  const isAdmin = me.role === 'admin';
  return (
    <section className="card">
      <div className="card-head">
        <h2>Family members</h2>
        {isAdmin && (
          <button className="btn btn-sm" onClick={() => setEditing('new')}>
            <Icon name="plus" size={16} /> Add member
          </button>
        )}
      </div>
      <p className="muted small">
        Add everyone in the household, including kids who don't need their own login, so you can assign events and chores. People who sign in with
        SSO are matched to a member by email.
      </p>
      <ul className="member-list">
        {members.map((m) => (
          <li key={m.id}>
            <button className="manage-row" onClick={() => isAdmin && setEditing(m)} disabled={!isAdmin}>
              <Avatar member={m} size={36} />
              <span className="grow">
                <div>{m.name} {m.id === me.id && <span className="muted small">(you)</span>}</div>
                <div className="muted small">
                  {[m.email, m.role === 'admin' ? 'Admin' : null, !m.canLogin ? 'No login' : m.linkedSso ? 'SSO' : m.hasPassword ? 'Password' : 'Not signed in yet'].filter(Boolean).join(' · ')}
                </div>
              </span>
            </button>
          </li>
        ))}
      </ul>
      {editing && <MemberModal member={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
    </section>
  );
}

function MemberModal({ member, self, onClose }: { member: Member | null; self?: boolean; onClose: () => void }) {
  const me = useMe();
  const status = useAuthStatus().data!;
  const isAdmin = me.role === 'admin';
  const [name, setName] = useState(member?.name ?? '');
  const [email, setEmail] = useState(member?.email ?? '');
  const [role, setRole] = useState(member?.role ?? 'member');
  const [color, setColor] = useState(member?.color ?? COLOR_CHOICES[0]);
  const [avatar, setAvatar] = useState(member?.avatar ?? '');
  const [canLogin, setCanLogin] = useState(member?.canLogin ?? true);
  const [password, setPassword] = useState('');
  const [currentPassword, setCurrentPassword] = useState('');
  const inv = [['members'], ['auth']];

  const body = () => {
    const b: Record<string, unknown> = { name, color, avatar: avatar || null };
    if (isAdmin) Object.assign(b, { email: email || null, role, canLogin });
    if (password) b.password = password;
    if (password && self && member?.hasPassword && !isAdmin) b.currentPassword = currentPassword;
    return b;
  };
  const save = useAction(() => (member ? api(`/members/${member.id}`, 'PATCH', body()) : api('/members', 'POST', body())), inv, onClose);
  const del = useAction(() => api(`/members/${member!.id}`, 'DELETE'), inv, onClose);
  const unlink = useAction(() => api(`/members/${member!.id}`, 'PATCH', { unlinkSso: true }), inv, onClose);

  return (
    <Modal
      title={member ? (self ? 'My profile' : `Edit ${member.name}`) : 'Add family member'}
      onClose={onClose}
      footer={
        <>
          {member && isAdmin && member.id !== me.id && (
            <button className="btn btn-danger-ghost" onClick={() => confirm(`Remove ${member.name}?`) && del.mutate()}>
              <Icon name="trash" size={16} /> Remove
            </button>
          )}
          <span className="spacer" />
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={!name.trim() || save.isPending} onClick={() => save.mutate()}>Save</button>
        </>
      }
    >
      <div className="form">
        <div className="row">
          <Avatar member={{ ...(member ?? ({} as Member)), name: name || '?', color, avatar: avatar || null }} size={56} />
          <Field label="Name">
            <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
        </div>
        <Field label="Colour">
          <div className="swatches">
            {COLOR_CHOICES.map((c) => (
              <button type="button" key={c} className={`swatch ${color === c ? 'on' : ''}`} style={{ background: c }} onClick={() => setColor(c)} aria-label={c} />
            ))}
          </div>
        </Field>
        <Field label="Avatar">
          <div className="swatches">
            <button type="button" className={`emoji-pick ${!avatar ? 'on' : ''}`} onClick={() => setAvatar('')}>Aa</button>
            {EMOJI_CHOICES.map((e) => (
              <button type="button" key={e} className={`emoji-pick ${avatar === e ? 'on' : ''}`} onClick={() => setAvatar(e)}>{e}</button>
            ))}
          </div>
        </Field>
        {isAdmin && (
          <>
            <div className="grid-2">
              <Field label="Email" hint="Used for password login and to match SSO accounts.">
                <input className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
              </Field>
              <Field label="Role">
                <select className="input" value={role} onChange={(e) => setRole(e.target.value as Member['role'])}>
                  <option value="member">Member</option>
                  <option value="admin">Admin</option>
                </select>
              </Field>
            </div>
            <label className="toggle">
              <input type="checkbox" checked={canLogin} onChange={(e) => setCanLogin(e.target.checked)} /> Can sign in
            </label>
          </>
        )}
        {status.localLogin && canLogin && (
          <>
            {self && member?.hasPassword && !isAdmin && (
              <Field label="Current password">
                <input className="input" type="password" value={currentPassword} onChange={(e) => setCurrentPassword(e.target.value)} autoComplete="current-password" />
              </Field>
            )}
            <Field label={member?.hasPassword ? 'New password' : 'Password (optional)'} hint="Leave blank to keep it unchanged. At least 8 characters.">
              <input className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} minLength={8} autoComplete="new-password" />
            </Field>
          </>
        )}
        {member?.linkedSso && isAdmin && (
          <button type="button" className="link-btn" onClick={() => unlink.mutate()}>Unlink SSO account</button>
        )}
      </div>
    </Modal>
  );
}

function GoogleCard() {
  const me = useMe();
  const { members } = useMembers();
  const toast = useToast();
  const g = useQuery({ queryKey: ['google'], queryFn: () => api<GoogleStatus>('/google/status') });
  const inv = [['google'], ['events'], ['event-targets']];
  const patchCal = useAction((v: { id: string; syncEnabled?: boolean; memberId?: string | null }) => api(`/google/calendars/${v.id}`, 'PATCH', v), inv);
  const syncNow = useAction(() => api<{ ok: number; failed: number }>('/google/sync', 'POST'), inv, (r) =>
    toast(r.failed ? `Synced ${r.ok}, ${r.failed} failed` : `Synced ${r.ok} calendar${r.ok === 1 ? '' : 's'}`, r.failed ? 'error' : 'success'),
  );
  const refresh = useAction((id: string) => api(`/google/connections/${id}/refresh`, 'POST'), inv);
  const disconnect = useAction((id: string) => api(`/google/connections/${id}`, 'DELETE'), inv);

  return (
    <section className="card" id="google">
      <div className="card-head">
        <h2>
          <Icon name="google" size={18} /> Google Calendar
        </h2>
        {g.data?.enabled && (
          <div className="row">
            <button className="btn btn-sm" onClick={() => syncNow.mutate()} disabled={syncNow.isPending}>
              <Icon name="refresh" size={14} /> {syncNow.isPending ? 'Syncing…' : 'Sync now'}
            </button>
            <a className="btn btn-sm btn-primary" href="/api/google/connect">Connect account</a>
          </div>
        )}
      </div>
      {g.data && !g.data.enabled && (
        <p className="note">
          Google sync isn't set up yet.{' '}
          {me.role === 'admin' ? (
            <>
              Add your Google OAuth client under <a href="#app-settings">App settings → Google Calendar</a> below.
            </>
          ) : (
            'Ask a family admin to add the Google OAuth client in Settings.'
          )}
        </p>
      )}
      {g.data?.enabled && g.data.connections.length === 0 && (
        <p className="muted small">
          Connect a Google account, then choose which calendars to show and who they belong to. Events sync both ways every {g.data.intervalMinutes} minutes, and changes made here are
          sent to Google immediately.
        </p>
      )}
      {g.data?.connections.map((c) => {
        const canManage = c.userId === me.id || me.role === 'admin';
        return (
          <div key={c.id} className="gconn">
            <div className="gconn-head">
              <div>
                <div className="strong">{c.googleEmail}</div>
                <div className="muted small">Connected by {c.userName}</div>
              </div>
              <span className="spacer" />
              {canManage && (
                <>
                  <button className="icon-btn" title="Refresh calendar list" onClick={() => refresh.mutate(c.id)}><Icon name="refresh" size={16} /></button>
                  <button className="btn btn-sm btn-danger-ghost" onClick={() => confirm(`Disconnect ${c.googleEmail}? Its events will be removed from FamilyHub (not from Google).`) && disconnect.mutate(c.id)}>
                    Disconnect
                  </button>
                </>
              )}
            </div>
            {c.error && <div className="alert">{c.error} <a href="/api/google/connect">Reconnect</a></div>}
            <table className="gcal-table">
              <thead>
                <tr>
                  <th>Sync</th>
                  <th>Calendar</th>
                  <th>Belongs to</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {c.calendars.map((k) => (
                  <tr key={k.id}>
                    <td>
                      <input type="checkbox" checked={k.syncEnabled} disabled={!canManage} onChange={(e) => patchCal.mutate({ id: k.id, syncEnabled: e.target.checked })} aria-label={`Sync ${k.name}`} />
                    </td>
                    <td>
                      <span className="dot" style={{ background: k.color ?? '#999' }} /> {k.name}
                      {k.accessRole === 'reader' || k.accessRole === 'freeBusyReader' ? <span className="muted small"> (read-only)</span> : null}
                    </td>
                    <td>
                      <select className="input input-sm" value={k.memberId ?? ''} disabled={!canManage} onChange={(e) => patchCal.mutate({ id: k.id, memberId: e.target.value || null })}>
                        <option value="">Whole family</option>
                        {members.map((m) => (
                          <option key={m.id} value={m.id}>{m.name}</option>
                        ))}
                      </select>
                    </td>
                    <td className="small">
                      {k.error ? <span className="error-text" title={k.error}>Error</span> : k.syncEnabled ? (k.lastSyncedAt ? <span className="muted">Synced {new Date(k.lastSyncedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</span> : <span className="muted">Pending</span>) : <span className="muted">Off</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
      })}
    </section>
  );
}
