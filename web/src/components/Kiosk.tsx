/**
 * Kiosk mode: a paired wall tablet / Raspberry Pi screen.
 *
 * Full screen, no sidebar or Settings, screen kept awake, returns to Home when idle, reconnects
 * and reloads itself after network drops, server updates and once a night. A small lock button
 * opens a PIN pad; after the PIN a grown-up can unlock all pages, customize Home, reload or sign
 * the screen out.
 */
import { useQueryClient } from '@tanstack/react-query';
import { Component, FormEvent, ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { NavLink, Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { AuthStatus, KioskPage, api } from '../lib/api';
import { useToast } from '../lib/hooks';
import { KioskContext } from '../lib/kiosk';
import { resolveLayout, useApplyTheme, useHomeLayout } from '../lib/layout';
import { CalendarPage } from '../pages/CalendarPage';
import { ChoresPage } from '../pages/ChoresPage';
import { HomePage } from '../pages/HomePage';
import { ListsPage } from '../pages/ListsPage';
import { MealsPage } from '../pages/MealsPage';
import { DoorbellPopup } from './Cameras';
import { Field, Icon, Modal } from './ui';

const PAGES: { key: KioskPage; to: string; label: string; icon: string; element: ReactNode; extra?: string }[] = [
  { key: 'calendar', to: '/calendar', label: 'Calendar', icon: 'calendar', element: <CalendarPage /> },
  { key: 'lists', to: '/lists', label: 'Lists', icon: 'list', element: <ListsPage />, extra: '/lists/:listId' },
  { key: 'chores', to: '/chores', label: 'Chores', icon: 'star', element: <ChoresPage /> },
  { key: 'meals', to: '/meals', label: 'Meals', icon: 'meal', element: <MealsPage /> },
];
const UNLOCK_MINUTES = 5;

export function KioskShell({ status }: { status: AuthStatus }) {
  const device = status.device!;
  const opts = device.options;
  const navigate = useNavigate();
  const [unlocked, setUnlocked] = useState(false);
  const [pinOpen, setPinOpen] = useState(false);
  const [menu, setMenu] = useState<{ pin: string } | null>(null);
  const layout = useHomeLayout();
  useApplyTheme(layout.isSuccess ? resolveLayout(layout.data).theme : undefined);

  useKioskBody(opts.hideCursor);
  useWakeLock();
  useReturnHome(unlocked ? 0 : opts.returnHomeSeconds);
  useNightlyReload(opts.reloadNightly);
  useReloadOnUpdate(status.version);
  const online = useConnectionWatch();
  const fullscreen = useFullscreen();

  // Unlocking lasts a few minutes, then the screen locks itself and goes Home.
  useEffect(() => {
    if (!unlocked) return;
    const t = setTimeout(() => {
      setUnlocked(false);
      navigate('/');
    }, UNLOCK_MINUTES * 60_000);
    return () => clearTimeout(t);
  }, [unlocked, navigate]);

  const pages = PAGES.filter((p) => unlocked || opts.pages.includes(p.key));
  const openLock = () => (status.kioskPinSet ? setPinOpen(true) : setMenu({ pin: '' }));
  const lockNow = () => {
    setUnlocked(false);
    navigate('/');
  };

  return (
    <KioskContext.Provider value={{ active: true, unlocked }}>
      <div className={`kiosk-shell ${pages.length ? 'has-nav' : ''}`}>
        <main className="main kiosk-main">
          <KioskErrorBoundary>
            <Routes>
              <Route path="/" element={<HomePage />} />
              {pages.map((p) => (
                <Route key={p.key} path={p.to} element={p.element} />
              ))}
              {pages
                .filter((p) => p.extra)
                .map((p) => (
                  <Route key={p.extra} path={p.extra} element={p.element} />
                ))}
              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
          </KioskErrorBoundary>
        </main>

        {pages.length > 0 ? (
          <nav className="kiosk-nav">
            <NavLink to="/" end className={({ isActive }) => `tab ${isActive ? 'active' : ''}`}>
              <Icon name="home" size={24} />
              <span>Home</span>
            </NavLink>
            {pages.map((p) => (
              <NavLink key={p.key} to={p.to} className={({ isActive }) => `tab ${isActive ? 'active' : ''}`}>
                <Icon name={p.icon} size={24} />
                <span>{p.label}</span>
              </NavLink>
            ))}
            {unlocked ? (
              <button className="tab kiosk-unlocked" onClick={lockNow} title="Lock the screen again">
                <Icon name="lock" size={24} />
                <span>Lock now</span>
              </button>
            ) : (
              <button className="tab kiosk-lock" onClick={openLock} aria-label="Kiosk menu">
                <Icon name="lock" size={20} />
              </button>
            )}
          </nav>
        ) : (
          <button className="kiosk-lock-float" onClick={unlocked ? lockNow : openLock} aria-label={unlocked ? 'Lock now' : 'Kiosk menu'}>
            <Icon name="lock" size={18} />
          </button>
        )}

        {!online && <div className="kiosk-offline">Can’t reach {status.appName}. Reconnecting…</div>}
        {fullscreen.needsTap && !unlocked && !pinOpen && !menu && (
          <button className="kiosk-start" onClick={fullscreen.enter}>
            <img src="/icon.svg" alt="" width={72} height={72} />
            <span className="kiosk-start-title">{status.familyName || status.appName}</span>
            <span className="muted">Tap anywhere to start</span>
          </button>
        )}
        <DoorbellPopup />

        {pinOpen && (
          <PinPad
            onClose={() => setPinOpen(false)}
            onUnlocked={(pin) => {
              setPinOpen(false);
              setMenu({ pin });
            }}
          />
        )}
        {menu && (
          <KioskMenu
            name={device.name}
            pin={menu.pin}
            fullscreen={fullscreen}
            onClose={() => setMenu(null)}
            onUnlock={() => {
              setUnlocked(true);
              setMenu(null);
            }}
          />
        )}
      </div>
    </KioskContext.Provider>
  );
}

function PinPad({ onClose, onUnlocked }: { onClose: () => void; onUnlocked: (pin: string) => void }) {
  const [pin, setPin] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (value: string) => {
    if (!value || busy) return;
    setBusy(true);
    try {
      await api('/kiosk/unlock', 'POST', { pin: value });
      onUnlocked(value);
    } catch (e: any) {
      setError(e.message);
      setPin('');
    } finally {
      setBusy(false);
    }
  };
  const press = (d: string) => {
    setError('');
    setPin((p) => (p.length < 8 ? p + d : p));
  };
  return (
    <Modal title="Enter the kiosk PIN" onClose={onClose}>
      <div className="pinpad">
        <div className={`pin-dots ${error ? 'is-error' : ''}`} aria-live="polite">
          {pin ? '•'.repeat(pin.length) : error || 'PIN'}
        </div>
        <div className="pin-keys">
          {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((d) => (
            <button key={d} className="pin-key" onClick={() => press(d)}>
              {d}
            </button>
          ))}
          <button className="pin-key pin-key-alt" onClick={() => setPin((p) => p.slice(0, -1))} aria-label="Delete">
            ⌫
          </button>
          <button className="pin-key" onClick={() => press('0')}>
            0
          </button>
          <button className="pin-key pin-key-go" onClick={() => submit(pin)} disabled={!pin || busy} aria-label="Unlock">
            <Icon name="check" size={22} />
          </button>
        </div>
      </div>
    </Modal>
  );
}

function KioskMenu({
  name,
  pin,
  fullscreen,
  onClose,
  onUnlock,
}: {
  name: string;
  pin: string;
  fullscreen: ReturnType<typeof useFullscreen>;
  onClose: () => void;
  onUnlock: () => void;
}) {
  const toast = useToast();
  const [confirmSignOut, setConfirmSignOut] = useState(false);
  const signOut = async () => {
    try {
      await api('/kiosk/forget', 'POST', { pin });
      location.href = '/kiosk';
    } catch (e: any) {
      toast(e.message, 'error');
    }
  };
  return (
    <Modal title={`${name}: kiosk menu`} onClose={onClose}>
      <div className="kiosk-menu">
        <button className="btn btn-block btn-primary" onClick={onUnlock}>
          <Icon name="lock" size={16} /> Unlock all pages for {UNLOCK_MINUTES} minutes
        </button>
        <p className="muted small">While unlocked you can open every page and use Customize on Home. Settings are managed from a phone or computer.</p>
        {fullscreen.supported && (
          <button
            className="btn btn-block"
            onClick={() => {
              onClose();
              fullscreen.isFullscreen ? document.exitFullscreen().catch(() => {}) : fullscreen.enter();
            }}
          >
            {fullscreen.isFullscreen ? 'Leave full screen' : 'Go full screen'}
          </button>
        )}
        <button className="btn btn-block" onClick={() => location.reload()}>
          <Icon name="refresh" size={16} /> Reload the screen
        </button>
        {confirmSignOut ? (
          <div className="kiosk-confirm">
            <p className="small">
              This screen will stop showing {name}. To use it again, a head of household needs to make a new pairing code in Settings → Kiosk screens.
            </p>
            <div className="kiosk-confirm-actions">
              <button className="btn" onClick={() => setConfirmSignOut(false)}>
                Keep it
              </button>
              <button className="btn btn-danger" onClick={signOut}>
                Sign this screen out
              </button>
            </div>
          </div>
        ) : (
          <button className="btn btn-block" onClick={() => setConfirmSignOut(true)}>
            <Icon name="logout" size={16} /> Sign this screen out…
          </button>
        )}
      </div>
    </Modal>
  );
}

/** /kiosk: turn this browser into a kiosk screen with a pairing code. */
export function KioskPairPage({ status }: { status: AuthStatus }) {
  const [code, setCode] = useState(() => new URLSearchParams(location.search).get('code') ?? '');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = useCallback(async (value: string) => {
    setBusy(true);
    setError('');
    try {
      await api('/kiosk/pair', 'POST', { code: value });
      location.replace('/');
    } catch (e: any) {
      setError(e.message);
      setBusy(false);
    }
  }, []);
  // A link with ?code= pairs straight away.
  const auto = useRef(false);
  useEffect(() => {
    if (!auto.current && code.replace(/[^a-z0-9]/gi, '').length >= 8) {
      auto.current = true;
      submit(code);
    }
  }, [code, submit]);
  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    submit(code);
  };
  return (
    <div className="login-wrap">
      <div className="login-card">
        <img src="/icon.svg" alt="" width={64} height={64} />
        <h1>Set up a kiosk screen</h1>
        <p className="muted small">
          A head of household can add this screen in <strong>Settings → Kiosk screens</strong> on their phone or computer. Enter the pairing code it shows.
        </p>
        {status.user && (
          <div className="notice">
            You’re signed in as {status.user.name} in this browser. Pairing turns this browser into a kiosk screen and signs you out here.
          </div>
        )}
        {error && <div className="alert">{error}</div>}
        <form onSubmit={onSubmit} className="form">
          <Field label="Pairing code">
            <input
              className="input pair-code-input"
              value={code}
              onChange={(e) => setCode(e.target.value.toUpperCase())}
              placeholder="ABCD-2345"
              autoComplete="off"
              autoCapitalize="characters"
              spellCheck={false}
              autoFocus
            />
          </Field>
          <button className="btn btn-block btn-primary" disabled={busy || !code.trim()}>
            {busy ? 'Pairing…' : 'Pair this screen'}
          </button>
        </form>
        <p className="muted small">
          <a href="/">Back to sign in</a>
        </p>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Kiosk behaviour hooks
// ---------------------------------------------------------------------------------------------

function useKioskBody(hideCursor: boolean) {
  useEffect(() => {
    const b = document.body;
    b.classList.add('kiosk');
    b.classList.toggle('kiosk-nocursor', hideCursor);
    const noMenu = (e: Event) => e.preventDefault();
    document.addEventListener('contextmenu', noMenu);
    return () => {
      b.classList.remove('kiosk', 'kiosk-nocursor');
      document.removeEventListener('contextmenu', noMenu);
    };
  }, [hideCursor]);
}

/** Keep the screen on (Screen Wake Lock API; needs HTTPS). Re-acquired whenever the page becomes visible or is touched. */
function useWakeLock() {
  useEffect(() => {
    let lock: any = null;
    let stopped = false;
    const acquire = async () => {
      if (stopped || lock || document.hidden) return;
      try {
        lock = await (navigator as any).wakeLock?.request('screen');
        lock?.addEventListener('release', () => (lock = null));
      } catch {
        /* not supported or not allowed right now; try again later */
      }
    };
    acquire();
    const onVisible = () => !document.hidden && acquire();
    document.addEventListener('visibilitychange', onVisible);
    document.addEventListener('fullscreenchange', onVisible);
    document.addEventListener('pointerdown', onVisible);
    const t = setInterval(acquire, 60_000);
    return () => {
      stopped = true;
      clearInterval(t);
      document.removeEventListener('visibilitychange', onVisible);
      document.removeEventListener('fullscreenchange', onVisible);
      document.removeEventListener('pointerdown', onVisible);
      lock?.release?.().catch(() => {});
    };
  }, []);
}

/** Go back to Home after `seconds` without a touch (0 = never). */
function useReturnHome(seconds: number) {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  useEffect(() => {
    if (!seconds || pathname === '/') return;
    let t = setTimeout(() => navigate('/'), seconds * 1000);
    const reset = () => {
      clearTimeout(t);
      t = setTimeout(() => navigate('/'), seconds * 1000);
    };
    const events = ['pointerdown', 'keydown', 'wheel', 'touchmove'];
    events.forEach((e) => window.addEventListener(e, reset, { passive: true }));
    return () => {
      clearTimeout(t);
      events.forEach((e) => window.removeEventListener(e, reset));
    };
  }, [seconds, pathname, navigate]);
}

/** Reload around 3:30 am so a browser left running for weeks stays healthy. */
function useNightlyReload(enabled: boolean) {
  useEffect(() => {
    if (!enabled) return;
    const next = new Date();
    next.setHours(3, 30, 0, 0);
    if (next.getTime() <= Date.now() + 60_000) next.setDate(next.getDate() + 1);
    const t = setTimeout(() => location.reload(), next.getTime() - Date.now());
    return () => clearTimeout(t);
  }, [enabled]);
}

/** Pick up app updates: when the server restarts with a new version, reload the screen. */
function useReloadOnUpdate(version: string | undefined) {
  const qc = useQueryClient();
  const first = useRef(version);
  useEffect(() => {
    if (first.current && version && version !== first.current) location.reload();
  }, [version]);
  useEffect(() => {
    const t = setInterval(() => qc.invalidateQueries({ queryKey: ['auth'] }), 5 * 60_000);
    return () => clearInterval(t);
  }, [qc]);
}

/** Watch the connection to the server. Short drops refresh the data; long ones reload the page. */
function useConnectionWatch() {
  const qc = useQueryClient();
  const [online, setOnline] = useState(true);
  useEffect(() => {
    let offlineSince = 0;
    let stopped = false;
    const check = async () => {
      let ok = false;
      try {
        const r = await fetch('/api/health', { cache: 'no-store', signal: AbortSignal.timeout(8000) });
        ok = r.ok;
      } catch {
        ok = false;
      }
      if (stopped) return;
      if (!ok) {
        if (!offlineSince) offlineSince = Date.now();
        setOnline(false);
      } else if (offlineSince) {
        const longDrop = Date.now() - offlineSince > 5 * 60_000;
        offlineSince = 0;
        setOnline(true);
        if (longDrop) location.reload();
        else qc.invalidateQueries();
      }
    };
    const t = setInterval(check, 20_000);
    window.addEventListener('online', check);
    window.addEventListener('offline', check);
    return () => {
      stopped = true;
      clearInterval(t);
      window.removeEventListener('online', check);
      window.removeEventListener('offline', check);
    };
  }, [qc]);
  return online;
}

/**
 * Full screen needs a tap (browsers only allow it after a touch), so show a "Tap to start" cover
 * when the page isn't already filling the screen. Skipped when installed as an app or when the
 * browser was started in kiosk mode (Raspberry Pi: chromium --kiosk).
 */
function useFullscreen() {
  const supported = typeof document !== 'undefined' && !!document.fullscreenEnabled && !!document.documentElement.requestFullscreen;
  const [isFullscreen, setIsFullscreen] = useState(!!document.fullscreenElement);
  const [declined, setDeclined] = useState(false);
  const [, force] = useState(0);
  useEffect(() => {
    const onChange = () => setIsFullscreen(!!document.fullscreenElement);
    const onResize = () => force((n) => n + 1);
    document.addEventListener('fullscreenchange', onChange);
    window.addEventListener('resize', onResize);
    return () => {
      document.removeEventListener('fullscreenchange', onChange);
      window.removeEventListener('resize', onResize);
    };
  }, []);
  const installed = window.matchMedia('(display-mode: fullscreen), (display-mode: standalone)').matches;
  const fillsScreen = window.innerWidth >= screen.width - 4 && window.innerHeight >= screen.height - 4;
  const enter = () => {
    document.documentElement.requestFullscreen({ navigationUI: 'hide' }).catch(() => setDeclined(true));
  };
  return { supported, isFullscreen, enter, needsTap: supported && !installed && !isFullscreen && !fillsScreen && !declined };
}

/** If a page crashes, show a short message and reload instead of leaving a blank screen on the wall. */
class KioskErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch() {
    setTimeout(() => location.reload(), 15_000);
  }
  render() {
    if (this.state.failed) return <div className="center-screen">Something went wrong. Restarting in a moment…</div>;
    return this.props.children;
  }
}
