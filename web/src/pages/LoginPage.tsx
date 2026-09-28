import { useQueryClient } from '@tanstack/react-query';
import { FormEvent, useState } from 'react';
import { Field, TimezoneList } from '../components/ui';
import { AuthStatus, api } from '../lib/api';

export function LoginPage({ status }: { status: AuthStatus }) {
  const qc = useQueryClient();
  const params = new URLSearchParams(location.search);
  const [error, setError] = useState(params.get('error') ?? '');
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [appName, setAppName] = useState(status.appName);
  const [familyName, setFamilyName] = useState('');
  const [timezone, setTimezone] = useState(Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC');
  const setup = status.needsSetup && status.localLogin;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api(setup ? '/auth/setup' : '/auth/login', 'POST', setup ? { name, email, password, appName, familyName: familyName || undefined, timezone, appUrl: location.origin } : { email, password });
      history.replaceState(null, '', '/');
      await qc.invalidateQueries();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login-wrap">
      <div className="login-card">
        <img src="/icon.svg" alt="" width={64} height={64} />
        <h1>{status.appName}</h1>
        <p className="muted">{setup ? "Welcome! Create the first admin account for your family." : 'Your family, all in one place.'}</p>

        {error && <div className="alert">{error}</div>}

        {status.oidc.enabled && (
          <a className="btn btn-primary btn-block" href="/api/auth/oidc/login">
            {status.oidc.label}
          </a>
        )}
        {status.oidc.enabled && status.localLogin && <div className="divider"><span>or</span></div>}

        {status.localLogin && (
          <form className="form" onSubmit={submit}>
            {setup && (
              <Field label="Your name">
                <input className="input" value={name} onChange={(e) => setName(e.target.value)} required autoComplete="name" />
              </Field>
            )}
            {setup && (
              <Field label="Family name" hint="Optional, e.g. The Hardy Family. You'll be the head of household.">
                <input className="input" value={familyName} onChange={(e) => setFamilyName(e.target.value)} />
              </Field>
            )}
            {setup && (
              <div className="grid-2">
                <Field label="App name">
                  <input className="input" value={appName} onChange={(e) => setAppName(e.target.value)} placeholder="FamilyHub" />
                </Field>
                <Field label="Time zone">
                  <input className="input" list="tz-list" value={timezone} onChange={(e) => setTimezone(e.target.value)} />
                </Field>
                <TimezoneList />
              </div>
            )}
            <Field label="Email">
              <input className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoComplete="username" />
            </Field>
            <Field label="Password" hint={setup ? 'At least 8 characters.' : undefined}>
              <input
                className="input"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                minLength={setup ? 8 : 1}
                autoComplete={setup ? 'new-password' : 'current-password'}
              />
            </Field>
            <button className={`btn btn-block ${status.oidc.enabled ? '' : 'btn-primary'}`} disabled={busy}>
              {busy ? 'Please wait…' : setup ? 'Create account' : 'Sign in'}
            </button>
          </form>
        )}
        {status.needsSetup && !status.localLogin && <p className="muted small">The first person to sign in becomes the family admin.</p>}
        {setup && <p className="muted small">Authentik and Google Calendar can be set up afterwards in Settings → App settings.</p>}
      </div>
    </div>
  );
}
