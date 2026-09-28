import { useQuery, useQueryClient } from '@tanstack/react-query';
import { FormEvent, ReactNode, useEffect, useState } from 'react';
import { AdminSettings, api } from '../lib/api';
import { useToast } from '../lib/hooks';
import { CopyField, Field, Icon, TimezoneList } from './ui';

type Kind = 'text' | 'url' | 'secret' | 'bool' | 'number' | 'timezone' | 'select' | 'textarea' | 'custom';
interface FieldSpec {
  key: string;
  label: string;
  kind: Kind;
  hint?: ReactNode;
  placeholder?: string;
  options?: { value: string; label: string }[];
  /** Only show this field when the predicate is true (e.g. depends on another field). */
  show?: (vals: Values) => boolean;
}

type Values = Record<string, string | number | boolean>;

/** Admin-only: everything that used to live in .env, editable in the app. */
export function AppSettings() {
  const q = useQuery({ queryKey: ['admin-settings'], queryFn: () => api<AdminSettings>('/admin/settings') });
  if (!q.data) return null;
  const d = q.data;
  return (
    <>
      <h2 className="section-title" id="app-settings">App settings <span className="tag">Admins only</span></h2>

      <SettingsSection
        data={d}
        title="General"
        fields={[
          { key: 'appName', label: 'App name', kind: 'text', placeholder: 'FamilyHub' },
          {
            key: 'appUrl',
            label: 'Public address (App URL)',
            kind: 'url',
            placeholder: d.detectedUrl,
            hint: <>The address your family uses, e.g. <code>https://family.example.com</code>. Sign-in and Google redirect addresses are built from it. Leave empty to use whatever address the browser used.</>,
          },
          { key: 'timezone', label: 'Household time zone', kind: 'timezone', hint: 'Used for repeating events, "today" for chores, and Google sync.' },
        ]}
        extra={(vals, set) =>
          !vals.appUrl && d.detectedUrl ? (
            <button type="button" className="link-btn" onClick={() => set('appUrl', d.detectedUrl)}>
              Use this address ({d.detectedUrl})
            </button>
          ) : null
        }
      />

      <SettingsSection
        data={d}
        title="Sign-in: Authentik (SSO)"
        status={d.effective.oidcEnabled ? { ok: true, text: 'Enabled' } : { ok: false, text: 'Not set up' }}
        intro={
          <>
            <p className="muted small">
              In Authentik, create an <strong>OAuth2/OpenID Provider</strong> (client type <em>Confidential</em>) with this redirect URI, then an Application that uses it.
            </p>
            <CopyField value={d.redirectUris.oidc} />
          </>
        }
        fields={[
          {
            key: 'oidcIssuer',
            label: 'Issuer URL',
            kind: 'url',
            placeholder: 'https://auth.example.com/application/o/familyhub/',
            hint: 'Shown as "OpenID Configuration Issuer" on the provider page in Authentik.',
          },
          { key: 'oidcClientId', label: 'Client ID', kind: 'text' },
          { key: 'oidcClientSecret', label: 'Client secret', kind: 'secret' },
          { key: 'oidcLabel', label: 'Button label', kind: 'text', placeholder: 'Sign in with Authentik' },
          { key: 'oidcAdminGroup', label: 'Admin group (optional)', kind: 'text', placeholder: 'familyhub-admins', hint: 'Members of this Authentik group become admins; others become members. Checked every sign-in.' },
          { key: 'oidcScopes', label: 'Scopes', kind: 'text', placeholder: 'openid profile email' },
          { key: 'oidcAutoCreate', label: 'Create a family member automatically on first SSO sign-in', kind: 'bool', hint: 'If off, an admin must add the person (with their email) first.' },
          {
            key: 'localLogin',
            label: 'Allow email + password sign-in',
            kind: 'bool',
            hint: 'Turning this off requires Authentik to be set up and you to have signed in with it once. Password sign-in stays on automatically while SSO isn’t configured.',
          },
        ]}
        test={{
          label: 'Test connection',
          run: (vals) => api<TestResult>('/admin/test/oidc', 'POST', { issuer: String(vals.oidcIssuer ?? '') || undefined }),
        }}
      />

      <SettingsSection
        data={d}
        title="Google Calendar"
        status={d.effective.googleEnabled ? { ok: true, text: 'Enabled' } : { ok: false, text: 'Not set up' }}
        intro={
          <>
            <ol className="steps small">
              <li>
                In <a href="https://console.cloud.google.com/apis/library/calendar-json.googleapis.com" target="_blank" rel="noreferrer">Google Cloud Console</a>, enable the <strong>Google Calendar API</strong>.
              </li>
              <li>Set up the OAuth consent screen (External), add the calendar scope, then click <strong>Publish app</strong> so access doesn't expire after 7 days.</li>
              <li>Create an <strong>OAuth client ID → Web application</strong> with this authorized redirect URI:</li>
            </ol>
            <CopyField value={d.redirectUris.google} />
          </>
        }
        fields={[
          { key: 'googleClientId', label: 'Client ID', kind: 'text', placeholder: '1234-abc.apps.googleusercontent.com' },
          { key: 'googleClientSecret', label: 'Client secret', kind: 'secret' },
          { key: 'googleSyncIntervalMinutes', label: 'Sync every (minutes)', kind: 'number' },
          { key: 'googlePastDays', label: 'Keep past events (days)', kind: 'number' },
          { key: 'googleFutureDays', label: 'Sync ahead (days)', kind: 'number' },
        ]}
        test={{
          label: 'Test credentials',
          run: (vals) =>
            api<TestResult>('/admin/test/google', 'POST', {
              clientId: String(vals.googleClientId ?? '') || undefined,
              clientSecret: String(vals.googleClientSecret ?? '') || undefined,
            }),
        }}
        footerNote="After saving, each person connects their own Google account in the Google Calendar card above."
      />

      <WeatherSettings data={d} />

      <SettingsSection
        data={d}
        title="Cameras (UniFi Protect)"
        status={d.settings.protectUrl?.value && d.settings.protectApiKey?.isSet ? { ok: true, text: 'Connected' } : { ok: false, text: 'Not set up' }}
        intro={
          <>
            <p className="muted small">
              Shows your UniFi Protect cameras on the Home page and pops up the doorbell camera when someone rings. Requires UniFi Protect 5.3 or newer. Create an API key in
              your UniFi console under <strong>Settings → Control Plane → Integrations</strong> (or <strong>Protect → Settings → Integrations</strong> on some versions).
            </p>
            <p className="muted small">
              Live video runs through the <code>go2rtc</code> container that ships with FamilyHub's docker-compose file. It stays private and is only reachable through
              FamilyHub.
            </p>
          </>
        }
        fields={[
          { key: 'protectUrl', label: 'UniFi console address', kind: 'url', placeholder: 'https://192.168.1.1' },
          { key: 'protectApiKey', label: 'API key', kind: 'secret' },
          {
            key: 'protectVerifyTls',
            label: 'Verify the console certificate',
            kind: 'bool',
            hint: 'Leave off unless your console has a trusted certificate (UniFi consoles normally use a self-signed one).',
          },
          {
            key: 'camerasMode',
            label: 'Default display on Home',
            kind: 'select',
            options: [
              { value: 'snapshots_live', label: 'Snapshots, live video when tapped' },
              { value: 'snapshots', label: 'Snapshots only' },
              { value: 'live', label: 'Live video' },
              { value: 'off', label: 'Hidden' },
            ],
            hint: 'Each person can override this for themselves under Settings → Cameras.',
          },
          { key: 'camerasSelected', label: 'Cameras', kind: 'custom' },
          { key: 'camerasSnapshotSeconds', label: 'Refresh snapshots every (seconds)', kind: 'number' },
          {
            key: 'camerasLiveQuality',
            label: 'Live video quality',
            kind: 'select',
            options: [
              { value: 'medium', label: 'Medium (recommended for tablets)' },
              { value: 'high', label: 'High' },
              { value: 'low', label: 'Low' },
            ],
          },
          { key: 'go2rtcUrl', label: 'Live video relay (go2rtc) URL', kind: 'url', placeholder: 'http://go2rtc:1984', hint: 'Leave as http://go2rtc:1984 when using the included docker-compose file.' },
          { key: 'doorbellPopupEnabled', label: 'Pop up the doorbell camera when it rings', kind: 'bool' },
          { key: 'doorbellPopupSeconds', label: 'Doorbell pop-up stays open for (seconds)', kind: 'number', show: (v) => !!v.doorbellPopupEnabled },
        ]}
        extra={(vals, set) => <CameraPicker vals={vals} set={set} />}
        test={{
          label: 'Test connection',
          run: (vals) =>
            api<TestResult>('/admin/protect/test', 'POST', {
              url: String(vals.protectUrl ?? '') || undefined,
              apiKey: String(vals.protectApiKey ?? '') || undefined,
              verifyTls: !!vals.protectVerifyTls,
              go2rtcUrl: String(vals.go2rtcUrl ?? '') || undefined,
            }),
        }}
      />

      <SettingsSection
        data={d}
        title="Photos (Home screensaver)"
        status={
          d.settings.photosSource?.value && d.settings.photosSource.value !== 'off'
            ? { ok: true, text: 'On' }
            : { ok: false, text: 'Off' }
        }
        intro={
          <p className="muted small">
            When someone's been idle on the Home page, FamilyHub fills the screen with a slideshow of these photos. Each person can turn it off or change the wait time
            under <strong>Settings → Photo slideshow</strong>.
          </p>
        }
        fields={[
          {
            key: 'photosSource',
            label: 'Photo source',
            kind: 'select',
            options: [
              { value: 'off', label: 'Off' },
              { value: 'amazon', label: 'Amazon Photos shared links' },
              { value: 'immich', label: 'Immich' },
              { value: 'both', label: 'Amazon Photos + Immich' },
            ],
          },
          {
            key: 'photosAmazonLinks',
            label: 'Amazon Photos share links',
            kind: 'textarea',
            placeholder: 'https://www.amazon.com/photos/shared/…',
            show: (v) => v.photosSource === 'amazon' || v.photosSource === 'both',
            hint: (
              <>
                One link per line. In Amazon Photos, open an album or group, choose <strong>Share → Copy link</strong>, and allow anyone with the link to view. Amazon has no
                official API, so this reads the same public page as the link; if Amazon changes it, photos may stop loading until FamilyHub is updated.
              </>
            ),
          },
          {
            key: 'immichUrl',
            label: 'Immich server URL',
            kind: 'url',
            placeholder: 'https://photos.example.com',
            show: (v) => v.photosSource === 'immich' || v.photosSource === 'both',
          },
          {
            key: 'immichApiKey',
            label: 'Immich API key',
            kind: 'secret',
            show: (v) => v.photosSource === 'immich' || v.photosSource === 'both',
            hint: 'In Immich: Account settings → API keys → New API key. Read access to albums and assets is enough.',
          },
          { key: 'immichAlbumIds', label: 'Immich albums', kind: 'custom', show: (v) => v.photosSource === 'immich' || v.photosSource === 'both' },
          { key: 'photosSlideSeconds', label: 'Seconds per photo', kind: 'number', show: (v) => v.photosSource !== 'off' },
          { key: 'photosRefreshMinutes', label: 'Check for new photos every (minutes)', kind: 'number', show: (v) => v.photosSource !== 'off' },
        ]}
        extra={(vals, set) =>
          vals.photosSource === 'immich' || vals.photosSource === 'both' ? <ImmichAlbumPicker vals={vals} set={set} /> : null
        }
        test={{
          label: 'Load photos',
          run: async () => {
            const r = await api<{ total: number; counts: { amazon: number; immich: number }; errors: string[] }>('/admin/photos/refresh', 'POST');
            const parts = [r.counts.amazon ? `${r.counts.amazon} from Amazon` : '', r.counts.immich ? `${r.counts.immich} from Immich` : ''].filter(Boolean);
            if (r.errors.length) return { ok: false, message: `${r.total} photos found. ${r.errors.join(' · ')}` };
            if (!r.total) return { ok: false, message: 'No photos found. Save your changes first, then check the links or albums.' };
            return { ok: true, message: `Found ${r.total} photos (${parts.join(', ')}).` };
          },
        }}
        footerNote="Save first, then Load photos to check."
      />

      <section className="card">
        <h2>Security keys</h2>
        <p className="muted small">
          The session secret and the key that encrypts saved secrets and Google tokens are generated automatically and stored in <code>{d.dataDir}/secrets.json</code> on the
          server's data volume. Back that volume up together with the database. If it's lost, you'll need to re-enter the client secrets here and reconnect Google accounts.
        </p>
      </section>
    </>
  );
}

interface TestResult {
  ok: boolean;
  message: string;
  warn?: boolean;
}

function SettingsSection({
  data,
  title,
  fields,
  intro,
  status,
  test,
  extra,
  footerNote,
}: {
  data: AdminSettings;
  title: string;
  fields: FieldSpec[];
  intro?: ReactNode;
  status?: { ok: boolean; text: string };
  test?: { label: string; run: (vals: Values) => Promise<TestResult> };
  extra?: (vals: Values, set: (k: string, v: string | number | boolean) => void) => ReactNode;
  footerNote?: string;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const initial = (): Values => {
    const v: Values = {};
    for (const f of fields) {
      const s = data.settings[f.key];
      v[f.key] = f.kind === 'secret' ? '' : (s?.value as string | number | boolean) ?? (f.kind === 'bool' ? false : '');
    }
    return v;
  };
  const [vals, setVals] = useState<Values>(initial);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<TestResult | null>(null);

  // Re-sync when the server data changes (e.g. after saving another section).
  const sig = JSON.stringify(fields.map((f) => data.settings[f.key]));
  useEffect(() => setVals(initial()), [sig]); // eslint-disable-line react-hooks/exhaustive-deps

  const set = (k: string, v: string | number | boolean) => setVals((x) => ({ ...x, [k]: v }));

  const changed = fields.filter((f) => {
    const s = data.settings[f.key];
    if (!s || s.lockedByEnv) return false;
    if (f.kind === 'secret') return vals[f.key] !== '';
    return vals[f.key] !== ((s.value as any) ?? (f.kind === 'bool' ? false : ''));
  });

  const save = async () => {
    setSaving(true);
    try {
      const body: Record<string, unknown> = {};
      for (const f of changed) body[f.key] = f.kind === 'number' ? Number(vals[f.key]) : vals[f.key];
      const next = await api<AdminSettings>('/admin/settings', 'PUT', body);
      qc.setQueryData(['admin-settings'], next);
      qc.invalidateQueries({ queryKey: ['auth'] });
      qc.invalidateQueries({ queryKey: ['google'] });
      toast(`${title} saved`, 'success');
    } catch (e: any) {
      toast(e.message, 'error');
    } finally {
      setSaving(false);
    }
  };

  const clearSecret = async (key: string) => {
    if (!confirm('Remove the saved secret?')) return;
    try {
      const next = await api<AdminSettings>(`/admin/settings/${key}`, 'DELETE');
      qc.setQueryData(['admin-settings'], next);
      qc.invalidateQueries({ queryKey: ['auth'] });
      qc.invalidateQueries({ queryKey: ['google'] });
    } catch (e: any) {
      toast(e.message, 'error');
    }
  };

  const runTest = async () => {
    if (!test) return;
    setTesting(true);
    setResult(null);
    try {
      setResult(await test.run(vals));
    } catch (e: any) {
      setResult({ ok: false, message: e.message });
    } finally {
      setTesting(false);
    }
  };

  return (
    <section className="card">
      <div className="card-head">
        <h2>{title}</h2>
        {status && <span className={`status-pill ${status.ok ? 'ok' : ''}`}>{status.text}</span>}
      </div>
      {intro && <div className="settings-intro">{intro}</div>}
      <div className="form">
        {fields.map((f) => {
          const s = data.settings[f.key];
          if (!s || f.kind === 'custom' || (f.show && !f.show(vals))) return null;
          const locked = s.lockedByEnv;
          const lockHint = locked ? (
            <>
              Set by the <code>{s.env}</code> environment variable. Remove it from your <code>.env</code> to manage this here.
            </>
          ) : (
            f.hint
          );
          if (f.kind === 'bool') {
            return (
              <div key={f.key} className="field">
                <label className="toggle">
                  <input type="checkbox" checked={!!vals[f.key]} disabled={locked} onChange={(e) => set(f.key, e.target.checked)} /> {f.label}
                </label>
                {lockHint && <span className="field-hint">{lockHint}</span>}
              </div>
            );
          }
          if (f.kind === 'select') {
            return (
              <Field key={f.key} label={f.label} hint={lockHint}>
                <select className="input" disabled={locked} value={String(vals[f.key] ?? '')} onChange={(e) => set(f.key, e.target.value)}>
                  {f.options!.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
              </Field>
            );
          }
          if (f.kind === 'textarea') {
            return (
              <Field key={f.key} label={f.label} hint={lockHint}>
                <textarea
                  className="input"
                  rows={3}
                  disabled={locked}
                  placeholder={f.placeholder}
                  value={String(vals[f.key] ?? '')}
                  onChange={(e) => set(f.key, e.target.value)}
                />
              </Field>
            );
          }
          if (f.kind === 'secret') {
            return (
              <Field key={f.key} label={f.label} hint={lockHint}>
                <div className="row">
                  <input
                    className="input"
                    type="password"
                    autoComplete="new-password"
                    disabled={locked}
                    value={String(vals[f.key] ?? '')}
                    placeholder={s.isSet ? '•••••••• saved (type to replace)' : 'Not set'}
                    onChange={(e) => set(f.key, e.target.value)}
                  />
                  {s.isSet && !locked && (
                    <button type="button" className="btn btn-sm btn-danger-ghost" onClick={() => clearSecret(f.key)}>
                      Remove
                    </button>
                  )}
                </div>
              </Field>
            );
          }
          return (
            <Field key={f.key} label={f.label} hint={lockHint}>
              <input
                className="input"
                type={f.kind === 'number' ? 'number' : f.kind === 'url' ? 'url' : 'text'}
                list={f.kind === 'timezone' ? 'tz-list' : undefined}
                min={f.kind === 'number' ? 1 : undefined}
                disabled={locked}
                placeholder={f.placeholder}
                value={String(vals[f.key] ?? '')}
                onChange={(e) => set(f.key, e.target.value)}
              />
              {f.kind === 'timezone' && <TimezoneList />}
            </Field>
          );
        })}
        {extra?.(vals, set)}
      </div>
      {result && <div className={`test-result ${result.ok && !result.warn ? 'ok' : 'bad'}`}>{result.message}</div>}
      <div className="settings-actions">
        {footerNote && <span className="muted small">{footerNote}</span>}
        <span className="spacer" />
        {test && (
          <button type="button" className="btn" onClick={runTest} disabled={testing}>
            <Icon name="check" size={16} /> {testing ? 'Testing…' : test.label}
          </button>
        )}
        <button type="button" className="btn btn-primary" onClick={save} disabled={!changed.length || saving}>
          {saving ? 'Saving…' : 'Save'}
        </button>
      </div>
    </section>
  );
}

function ImmichAlbumPicker({ vals, set }: { vals: Values; set: (k: string, v: string) => void }) {
  const [albums, setAlbums] = useState<{ id: string; name: string; count: number }[] | null>(null);
  const [msg, setMsg] = useState('');
  const [loading, setLoading] = useState(false);
  const selected = String(vals.immichAlbumIds ?? '')
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);

  const load = async () => {
    setLoading(true);
    setMsg('');
    try {
      const r = await api<{ ok: boolean; message?: string; albums: { id: string; name: string; count: number }[] }>('/admin/immich/albums', 'POST', {
        url: String(vals.immichUrl ?? '') || undefined,
        apiKey: String(vals.immichApiKey ?? '') || undefined,
      });
      if (!r.ok) setMsg(r.message ?? 'Could not load albums');
      setAlbums(r.albums);
    } catch (e: any) {
      setMsg(e.message);
    } finally {
      setLoading(false);
    }
  };

  const toggle = (id: string) => {
    const next = selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id];
    set('immichAlbumIds', next.join(','));
  };

  return (
    <div className="field">
      <span className="field-label">Immich albums</span>
      <div className="row">
        <button type="button" className="btn btn-sm" onClick={load} disabled={loading}>
          {loading ? 'Loading…' : albums ? 'Reload albums' : 'Choose albums'}
        </button>
        <span className="muted small">
          {selected.length ? `${selected.length} album${selected.length === 1 ? '' : 's'} selected` : 'None selected: your Immich favorites will be shown'}
        </span>
      </div>
      {msg && <div className="alert">{msg}</div>}
      {albums && (
        <div className="album-list">
          {albums.length === 0 && <span className="muted small">No albums found.</span>}
          {albums.map((a) => (
            <label key={a.id} className="toggle">
              <input type="checkbox" checked={selected.includes(a.id)} onChange={() => toggle(a.id)} /> {a.name}{' '}
              <span className="muted small">({a.count})</span>
            </label>
          ))}
        </div>
      )}
    </div>
  );
}

interface GeoResult {
  name: string;
  region: string;
  label: string;
  latitude: number;
  longitude: number;
}

/** Household weather location + units (Open-Meteo). */
function WeatherSettings({ data }: { data: AdminSettings }) {
  const qc = useQueryClient();
  const toast = useToast();
  const st = data.settings;
  const locked = ['weatherLocationName', 'weatherLatitude', 'weatherLongitude'].some((k) => st[k]?.lockedByEnv);
  const current = String(st.weatherLocationName?.value ?? '');
  const hasLocation = String(st.weatherLatitude?.value ?? '') !== '';
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<GeoResult[] | null>(null);
  const [busy, setBusy] = useState(false);

  const save = async (patch: Record<string, unknown>, msg: string) => {
    try {
      const next = await api<AdminSettings>('/admin/settings', 'PUT', patch);
      qc.setQueryData(['admin-settings'], next);
      qc.invalidateQueries({ queryKey: ['weather'] });
      toast(msg, 'success');
    } catch (e: any) {
      toast(e.message, 'error');
    }
  };

  const search = async (e?: FormEvent) => {
    e?.preventDefault();
    if (query.trim().length < 2) return;
    setBusy(true);
    try {
      setResults(await api<GeoResult[]>(`/admin/weather/search?q=${encodeURIComponent(query.trim())}`));
    } catch (err: any) {
      toast(err.message, 'error');
    } finally {
      setBusy(false);
    }
  };

  const useMyLocation = () => {
    if (!navigator.geolocation) return toast('This browser cannot share its location', 'error');
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const lat = pos.coords.latitude.toFixed(4);
        const lon = pos.coords.longitude.toFixed(4);
        save({ weatherLocationName: `My location (${lat}, ${lon})`, weatherLatitude: lat, weatherLongitude: lon }, 'Weather location saved');
      },
      (err) => toast(`Couldn't get your location: ${err.message}`, 'error'),
      { timeout: 10_000 },
    );
  };

  return (
    <section className="card">
      <div className="card-head">
        <h2>Weather</h2>
        <span className={`status-pill ${hasLocation && st.weatherEnabled?.value ? 'ok' : ''}`}>{hasLocation ? (st.weatherEnabled?.value ? 'On' : 'Off') : 'No location'}</span>
      </div>
      <p className="muted small settings-intro">
        Local weather on the Home page and the photo slideshow, from{' '}
        <a href="https://open-meteo.com" target="_blank" rel="noreferrer">
          Open-Meteo
        </a>{' '}
        (free, no account needed).
      </p>
      <div className="form">
        <label className="toggle">
          <input
            type="checkbox"
            checked={!!st.weatherEnabled?.value}
            disabled={st.weatherEnabled?.lockedByEnv}
            onChange={(e) => save({ weatherEnabled: e.target.checked }, e.target.checked ? 'Weather turned on' : 'Weather turned off')}
          />{' '}
          Show weather
        </label>
        <Field label="Location" hint={locked ? 'Set by environment variables.' : undefined}>
          <div className="wx-location">{hasLocation ? <strong>{current || `${st.weatherLatitude?.value}, ${st.weatherLongitude?.value}`}</strong> : <span className="muted">Not set</span>}</div>
        </Field>
        {!locked && (
          <>
            <form className="row" onSubmit={search}>
              <input className="input" placeholder="Search city or ZIP code" value={query} onChange={(e) => setQuery(e.target.value)} />
              <button className="btn" disabled={busy || query.trim().length < 2}>
                {busy ? 'Searching…' : 'Search'}
              </button>
            </form>
            <button type="button" className="link-btn" onClick={useMyLocation}>
              Use this device's location
            </button>
            {results && (
              <div className="wx-results">
                {results.length === 0 && <span className="muted small">No places found. Try a nearby city.</span>}
                {results.map((r) => (
                  <button
                    type="button"
                    key={`${r.latitude},${r.longitude}`}
                    className="manage-row"
                    onClick={() => {
                      setResults(null);
                      setQuery('');
                      save(
                        { weatherLocationName: r.label, weatherLatitude: String(r.latitude), weatherLongitude: String(r.longitude) },
                        `Weather location set to ${r.name}`,
                      );
                    }}
                  >
                    <span className="grow">
                      <div>{r.name}</div>
                      <div className="muted small">{r.region}</div>
                    </span>
                  </button>
                ))}
              </div>
            )}
          </>
        )}
        <Field label="Units">
          <div className="seg">
            {(['fahrenheit', 'celsius'] as const).map((u) => (
              <button
                type="button"
                key={u}
                className={st.weatherUnits?.value === u ? 'on' : ''}
                disabled={st.weatherUnits?.lockedByEnv}
                onClick={() => st.weatherUnits?.value !== u && save({ weatherUnits: u }, 'Units saved')}
              >
                {u === 'fahrenheit' ? '°F' : '°C'}
              </button>
            ))}
          </div>
        </Field>
      </div>
    </section>
  );
}

/** Choose which cameras appear on Home, and their order. Nothing selected = all cameras. */
function CameraPicker({ vals, set }: { vals: Values; set: (k: string, v: string) => void }) {
  const [cameras, setCameras] = useState<{ id: string; name: string; state: string }[] | null>(null);
  const [msg, setMsg] = useState('');
  const [loading, setLoading] = useState(false);
  const selected = String(vals.camerasSelected ?? '')
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);

  const load = async () => {
    setLoading(true);
    setMsg('');
    try {
      const r = await api<{ ok: boolean; message: string; cameras: { id: string; name: string; state: string }[] }>('/admin/protect/test', 'POST', {
        url: String(vals.protectUrl ?? '') || undefined,
        apiKey: String(vals.protectApiKey ?? '') || undefined,
        verifyTls: !!vals.protectVerifyTls,
      });
      if (!r.ok) setMsg(r.message);
      setCameras(r.cameras);
    } catch (e: any) {
      setMsg(e.message);
    } finally {
      setLoading(false);
    }
  };

  const write = (ids: string[]) => set('camerasSelected', ids.join(','));
  const move = (i: number, dir: -1 | 1) => {
    const next = [...selected];
    const j = i + dir;
    if (j < 0 || j >= next.length) return;
    [next[i], next[j]] = [next[j], next[i]];
    write(next);
  };
  const nameOf = (id: string) => cameras?.find((c) => c.id === id)?.name ?? id;

  return (
    <div className="field">
      <span className="field-label">Cameras on Home</span>
      <div className="row">
        <button type="button" className="btn btn-sm" onClick={load} disabled={loading}>
          {loading ? 'Loading…' : cameras ? 'Reload cameras' : 'Choose cameras'}
        </button>
        <span className="muted small">{selected.length ? `${selected.length} selected, in this order` : 'None selected: all cameras are shown'}</span>
      </div>
      {msg && <div className="alert">{msg}</div>}
      {cameras && (
        <div className="cam-picker">
          {selected.map((id, i) => (
            <div key={id} className="cam-picker-row">
              <span className="cam-picker-num">{i + 1}</span>
              <span className="grow">{nameOf(id)}</span>
              <button type="button" className="icon-btn" onClick={() => move(i, -1)} disabled={i === 0} aria-label="Move up">
                <Icon name="up" size={16} />
              </button>
              <button type="button" className="icon-btn" onClick={() => move(i, 1)} disabled={i === selected.length - 1} aria-label="Move down">
                <Icon name="down" size={16} />
              </button>
              <button type="button" className="icon-btn" onClick={() => write(selected.filter((x) => x !== id))} aria-label="Remove">
                <Icon name="x" size={16} />
              </button>
            </div>
          ))}
          {cameras
            .filter((c) => !selected.includes(c.id))
            .map((c) => (
              <div key={c.id} className="cam-picker-row is-off">
                <span className="cam-picker-num" />
                <span className="grow">
                  {c.name}
                  {c.state !== 'CONNECTED' && <span className="muted small"> (offline)</span>}
                </span>
                <button type="button" className="btn btn-sm" onClick={() => write([...selected, c.id])}>
                  <Icon name="plus" size={14} /> Add
                </button>
              </div>
            ))}
          {cameras.length === 0 && <span className="muted small">No cameras found.</span>}
        </div>
      )}
    </div>
  );
}
