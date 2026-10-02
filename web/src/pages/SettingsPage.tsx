import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { AppSettings } from '../components/AppSettings';
import { KioskAdmin } from '../components/KioskAdmin';
import { useCameras } from '../components/Cameras';
import { BackupsCard } from '../components/Backups';
import { ExtCalendarsCard } from '../components/ExtCalendars';
import { FamilyGroupsCard } from '../components/FamilyGroups';
import { OccasionsCard, RemindersPrefsCard } from '../components/Occasions';
import { KeyboardSetting } from '../components/Kiosk';
import { Avatar, COLOR_CHOICES, EMOJI_CHOICES, Field, Icon, Modal } from '../components/ui';
import { GoogleStatus, Member, api } from '../lib/api';
import { useAction, useAuthStatus, useMe, useMembers, useToast } from '../lib/hooks';

type TabId =
  | 'profile'
  | 'display'
  | 'family'
  | 'dates'
  | 'google'
  | 'app-general'
  | 'app-signin'
  | 'app-google'
  | 'app-weather'
  | 'app-photos'
  | 'app-cameras'
  | 'app-kiosk'
  | 'app-notifications'
  | 'app-security'
  | 'app-backups';

interface TabDef {
  id: TabId;
  label: string;
  icon: string;
  adminOnly?: boolean;
}

const GROUPS: { title: string; adminOnly?: boolean; tabs: TabDef[] }[] = [
  {
    title: 'You',
    tabs: [
      { id: 'profile', label: 'Profile', icon: 'home' },
      { id: 'display', label: 'Screen & alerts', icon: 'image' },
    ],
  },
  {
    title: 'Family',
    tabs: [
      { id: 'family', label: 'Family members', icon: 'star' },
      { id: 'dates', label: 'Birthdays & dates', icon: 'cake' },
    ],
  },
  {
    title: 'Connections',
    tabs: [{ id: 'google', label: 'Calendars', icon: 'calendar' }],
  },
  {
    title: 'App settings',
    adminOnly: true,
    tabs: [
      { id: 'app-general', label: 'General', icon: 'settings' },
      { id: 'app-signin', label: 'Sign-in', icon: 'logout' },
      { id: 'app-google', label: 'Google API', icon: 'google' },
      { id: 'app-weather', label: 'Weather', icon: 'sun' },
      { id: 'app-photos', label: 'Photos', icon: 'image' },
      { id: 'app-cameras', label: 'Cameras', icon: 'camera' },
      { id: 'app-kiosk', label: 'Kiosk screens', icon: 'lock' },
      { id: 'app-notifications', label: 'Notifications', icon: 'star' },
      { id: 'app-security', label: 'Security', icon: 'lock' },
      { id: 'app-backups', label: 'Backups', icon: 'download' },
    ],
  },
];

// Old links (e.g. /settings#google from the Google sign-in redirect, #app-settings) still land somewhere sensible.
const ALIASES: Record<string, TabId> = { 'app-settings': 'app-general' };

function tabFromHash(isAdmin: boolean): TabId {
  const h = location.hash.replace('#', '');
  const id = (ALIASES[h] ?? h) as TabId;
  const all = GROUPS.filter((g) => isAdmin || !g.adminOnly).flatMap((g) => g.tabs);
  return all.some((t) => t.id === id) ? id : 'profile';
}

export function SettingsPage({ onLogout }: { onLogout: () => void }) {
  const me = useMe();
  const status = useAuthStatus().data!;
  const toast = useToast();
  const isAdmin = me.role === 'admin';
  const [tab, setTab] = useState<TabId>(() => tabFromHash(isAdmin));

  useEffect(() => {
    const p = new URLSearchParams(location.search);
    if (p.get('google') === 'connected') toast('Google account connected', 'success');
    if (p.get('googleError')) toast(`Google connection failed: ${p.get('googleError')}`, 'error');
    if (p.toString()) history.replaceState(null, '', '/settings' + location.hash);
    const onHash = () => setTab(tabFromHash(isAdmin));
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, [toast, isAdmin]);

  const go = (id: TabId) => {
    setTab(id);
    history.replaceState(null, '', `/settings#${id}`);
    window.scrollTo({ top: 0 });
  };
  const groups = GROUPS.filter((g) => isAdmin || !g.adminOnly);
  const current = groups.flatMap((g) => g.tabs).find((t) => t.id === tab);

  return (
    <div className="page page-settings">
      <header className="page-head">
        <h1>Settings</h1>
        <button className="btn" onClick={onLogout}>
          <Icon name="logout" size={16} /> Sign out
        </button>
      </header>
      <div className="settings-layout">
        <nav className="settings-nav" aria-label="Settings sections">
          {groups.map((g) => (
            <div key={g.title} className="settings-group">
              <div className="settings-group-title">
                {g.title}
                {g.adminOnly && <span className="tag">Head of household</span>}
              </div>
              {g.tabs.map((t) => (
                <button key={t.id} className={`settings-tab ${tab === t.id ? 'active' : ''}`} onClick={() => go(t.id)} aria-current={tab === t.id ? 'page' : undefined}>
                  <Icon name={t.icon} size={18} /> <span>{t.label}</span>
                </button>
              ))}
            </div>
          ))}
        </nav>
        <div className="settings-content">
          <h2 className="settings-content-title">{current?.label}</h2>
          {tab === 'profile' && (
            <>
              <ProfileCard />
              {(window as any).FamilyHubAndroid && (
                <section className="card">
                  <h2>Android app</h2>
                  <p className="muted small">Connected to {(window as any).FamilyHubAndroid.serverUrl?.()}</p>
                  <div>
                    <button className="btn" onClick={() => (window as any).FamilyHubAndroid.changeServer()}>
                      Change server
                    </button>
                  </div>
                </section>
              )}
              <section className="card">
                <h2>About</h2>
                <p className="muted small">
                  {status.appName} · time zone {status.timezone} · signed in as {me.email ?? me.name}
                  {me.linkedSso ? ' (SSO)' : ''}
                </p>
              </section>
            </>
          )}
          {tab === 'display' && (
            <>
              <section className="card">
                <h2>Home page</h2>
                <p className="muted small">
                  To rearrange your Home page, change its colours or text size, open <strong>Home</strong> and tap <strong>Customize</strong>.
                </p>
              </section>
              <section className="card">
                <h2>This device</h2>
                <p className="muted small">For touch screens without a keyboard. Auto turns it on for FamilyHub OS and Linux kiosk screens; phones and tablets use their own keyboard.</p>
                <KeyboardSetting kiosk={false} />
              </section>
              <RemindersPrefsCard />
              <SlideshowPrefsCard />
              <CameraPrefsCard />
              {isAdmin && <AlertPrefsCard />}
            </>
          )}
          {tab === 'family' && <FamilyManager />}
          {tab === 'dates' && <OccasionsCard />}
          {tab === 'google' && (
            <>
              <GoogleCard />
              <ExtCalendarsCard />
            </>
          )}
          {tab === 'app-backups' && <BackupsCard />}
          {tab === 'app-general' && <AppSettings section="general" />}
          {tab === 'app-signin' && <AppSettings section="signin" />}
          {tab === 'app-google' && <AppSettings section="google" />}
          {tab === 'app-weather' && <AppSettings section="weather" />}
          {tab === 'app-photos' && <AppSettings section="photos" />}
          {tab === 'app-cameras' && <AppSettings section="cameras" />}
          {tab === 'app-kiosk' && <KioskAdmin />}
          {tab === 'app-notifications' && <AppSettings section="notifications" />}
          {tab === 'app-security' && <AppSettings section="security" />}
        </div>
      </div>
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
          <div className="muted small">{me.email}{me.role === 'admin' ? ' · Head of household' : ''}</div>
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

function roleLabel(m: Member) {
  if (m.role === 'admin') return 'Head of household';
  return m.memberType === 'child' ? 'Child' : 'Adult';
}

function loginLabel(m: Member) {
  if (!m.canLogin) return 'No login';
  if (m.linkedSso) return 'Signs in with SSO';
  if (m.hasPassword) return 'Signs in with password';
  return 'Hasn\u2019t signed in yet';
}

/** The family: head of household adds, edits and removes everyone, including kids without logins. */
function FamilyManager() {
  const me = useMe();
  const { members } = useMembers();
  const status = useAuthStatus().data!;
  const qc = useQueryClient();
  const toast = useToast();
  const isHead = me.role === 'admin';
  const [editing, setEditing] = useState<Member | { new: 'adult' | 'child' } | null>(null);
  const [familyName, setFamilyName] = useState(status.familyName ?? '');

  const saveFamilyName = async () => {
    if ((status.familyName ?? '') === familyName.trim()) return;
    try {
      await api('/admin/settings', 'PUT', { familyName: familyName.trim() });
      await qc.invalidateQueries({ queryKey: ['auth'] });
      toast('Family name saved', 'success');
    } catch (e: any) {
      toast(e.message, 'error');
    }
  };

  const groups: { title: string; list: Member[] }[] = [
    { title: 'Heads of household', list: members.filter((m) => m.role === 'admin') },
    { title: 'Adults', list: members.filter((m) => m.role !== 'admin' && m.memberType !== 'child') },
    { title: 'Children', list: members.filter((m) => m.role !== 'admin' && m.memberType === 'child') },
  ];

  return (
    <>
      <section className="card family-hero">
        <div className="family-hero-row">
          <div className="family-avatars">
            {members.slice(0, 8).map((m) => (
              <Avatar key={m.id} member={m} size={44} />
            ))}
          </div>
          <div className="grow">
            {isHead ? (
              <Field label="Family name">
                <input
                  className="input"
                  value={familyName}
                  placeholder="e.g. The Hardy Family"
                  onChange={(e) => setFamilyName(e.target.value)}
                  onBlur={saveFamilyName}
                  onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
                />
              </Field>
            ) : (
              <div className="family-name">{status.familyName || 'Our family'}</div>
            )}
            <div className="muted small">
              {members.length} member{members.length === 1 ? '' : 's'} · {members.filter((m) => m.memberType === 'child' && m.role !== 'admin').length} children
            </div>
          </div>
        </div>
        {isHead && (
          <div className="family-actions">
            <button className="btn btn-primary" onClick={() => setEditing({ new: 'adult' })}>
              <Icon name="plus" size={16} /> Add an adult
            </button>
            <button className="btn" onClick={() => setEditing({ new: 'child' })}>
              <Icon name="plus" size={16} /> Add a child
            </button>
          </div>
        )}
        {!isHead && <p className="muted small">Only a head of household can add or change family members.</p>}
      </section>

      {groups
        .filter((g) => g.list.length)
        .map((g) => (
          <section key={g.title} className="card">
            <h2>{g.title}</h2>
            <div className="member-grid">
              {g.list.map((m) => (
                <button key={m.id} className="member-card" onClick={() => (isHead || m.id === me.id) && setEditing(m)} disabled={!isHead && m.id !== me.id}>
                  <Avatar member={m} size={52} />
                  <div className="member-card-name">
                    {m.name} {m.id === me.id && <span className="muted small">(you)</span>}
                  </div>
                  <div className="member-card-role" style={{ color: m.color }}>
                    {roleLabel(m)}
                  </div>
                  <div className="muted small">{loginLabel(m)}</div>
                  {m.email && <div className="muted small member-card-email">{m.email}</div>}
                </button>
              ))}
            </div>
          </section>
        ))}

      <FamilyGroupsCard isHead={isHead} />

      <section className="card">
        <h2>How roles work</h2>
        <ul className="muted small roles-help">
          <li>
            <strong>Head of household</strong>: manages the family, app settings and connections. You can have more than one.
          </li>
          <li>
            <strong>Adult</strong>: full use of calendar, lists, chores and meals, and can change their own profile.
          </li>
          <li>
            <strong>Child</strong>: shown on the calendar and chore charts. Can have a login, but doesn't need one.
          </li>
          <li>People who sign in with SSO (Authentik) are matched to a family member by email.</li>
        </ul>
      </section>

      {editing && (
        <MemberModal
          member={'new' in editing ? null : editing}
          newType={'new' in editing ? editing.new : undefined}
          self={!('new' in editing) && editing.id === me.id}
          onClose={() => setEditing(null)}
        />
      )}
    </>
  );
}

function MemberModal({ member, self, newType, onClose }: { member: Member | null; self?: boolean; newType?: 'adult' | 'child'; onClose: () => void }) {
  const me = useMe();
  const status = useAuthStatus().data!;
  const isAdmin = me.role === 'admin';
  const [name, setName] = useState(member?.name ?? '');
  const [email, setEmail] = useState(member?.email ?? '');
  const [role, setRole] = useState(member?.role ?? 'member');
  const [color, setColor] = useState(member?.color ?? COLOR_CHOICES[0]);
  const [avatar, setAvatar] = useState(member?.avatar ?? '');
  const [memberType, setMemberType] = useState<'adult' | 'child'>(member?.memberType ?? newType ?? 'adult');
  const [canLogin, setCanLogin] = useState(member?.canLogin ?? newType !== 'child');
  const [password, setPassword] = useState('');
  const [currentPassword, setCurrentPassword] = useState('');
  const inv = [['members'], ['auth']];

  const body = () => {
    const b: Record<string, unknown> = { name, color, avatar: avatar || null };
    if (isAdmin) Object.assign(b, { email: email || null, role, canLogin, memberType: role === 'admin' ? 'adult' : memberType });
    if (password) b.password = password;
    if (password && self && member?.hasPassword && !isAdmin) b.currentPassword = currentPassword;
    return b;
  };
  const save = useAction(() => (member ? api(`/members/${member.id}`, 'PATCH', body()) : api('/members', 'POST', body())), inv, onClose);
  const del = useAction(() => api(`/members/${member!.id}`, 'DELETE'), inv, onClose);
  const unlink = useAction(() => api(`/members/${member!.id}`, 'PATCH', { unlinkSso: true }), inv, onClose);

  return (
    <Modal
      title={member ? (self ? 'My profile' : `Edit ${member.name}`) : memberType === 'child' ? 'Add a child' : 'Add an adult'}
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
            <Field label="Role in the family">
              <div className="seg">
                <button type="button" className={role !== 'admin' && memberType === 'adult' ? 'on' : ''} onClick={() => (setRole('member'), setMemberType('adult'))}>
                  Adult
                </button>
                <button type="button" className={role !== 'admin' && memberType === 'child' ? 'on' : ''} onClick={() => (setRole('member'), setMemberType('child'))}>
                  Child
                </button>
                <button type="button" className={role === 'admin' ? 'on' : ''} onClick={() => setRole('admin')}>
                  Head of household
                </button>
              </div>
            </Field>
            <label className="toggle">
              <input type="checkbox" checked={canLogin} onChange={(e) => setCanLogin(e.target.checked)} /> Can sign in to FamilyHub
            </label>
            {canLogin && (
              <Field label="Email" hint="Used to sign in with a password, and to match their Authentik account.">
                <input className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
              </Field>
            )}
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
              Add your Google OAuth client under <a href="#app-google">App settings → Google API</a>.
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

/** Where a head of household gets chore-approval requests: email and/or a text (email-to-text address). */
function AlertPrefsCard() {
  const me = useMe();
  const qc = useQueryClient();
  const toast = useToast();
  const [text, setText] = useState(me.prefs.notifyText ?? '');
  const save = async (prefs: Partial<Member['prefs']>) => {
    try {
      await api(`/members/${me.id}`, 'PATCH', { prefs });
      await qc.invalidateQueries({ queryKey: ['auth'] });
      qc.invalidateQueries({ queryKey: ['members'] });
      toast('Saved', 'success');
    } catch (e: any) {
      toast(e.message, 'error');
    }
  };
  return (
    <section className="card">
      <h2>Chore approval alerts</h2>
      <p className="muted small">When a child marks a chore done, you'll get a message with Approve / Not yet buttons. Email and texts are sent through Mailjet, set up under App settings → Notifications.</p>
      <div className="form">
        <label className="toggle">
          <input type="checkbox" checked={me.prefs.notifyEmail !== false} disabled={!me.email} onChange={(e) => save({ notifyEmail: e.target.checked })} /> Email me
          {me.email ? ` at ${me.email}` : ' (add an email address to your profile first)'}
        </label>
        <Field
          label="Text me (email-to-text address)"
          hint={
            <>
              Your number at your carrier's gateway, e.g. <code>5551234567@vtext.com</code> (Verizon), <code>@tmomail.net</code> (T-Mobile), <code>@txt.att.net</code> (AT&amp;T). Some
              carriers are phasing this out. Leave empty for no texts.
            </>
          }
        >
          <div className="row">
            <input className="input" value={text} onChange={(e) => setText(e.target.value.trim())} placeholder="5551234567@vtext.com" inputMode="email" />
            <button className="btn" onClick={() => save({ notifyText: text })} disabled={text === (me.prefs.notifyText ?? '')}>
              Save
            </button>
          </div>
        </Field>
      </div>
    </section>
  );
}
