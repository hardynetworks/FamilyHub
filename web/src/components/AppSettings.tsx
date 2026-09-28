import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ReactNode, useEffect, useState } from 'react';
import { AdminSettings, api } from '../lib/api';
import { useToast } from '../lib/hooks';
import { CopyField, Field, Icon, TimezoneList } from './ui';

type Kind = 'text' | 'url' | 'secret' | 'bool' | 'number' | 'timezone';
interface FieldSpec {
  key: string;
  label: string;
  kind: Kind;
  hint?: ReactNode;
  placeholder?: string;
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
          if (!s) return null;
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
