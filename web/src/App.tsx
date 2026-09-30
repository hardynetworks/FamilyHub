import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useState } from 'react';
import { NavLink, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { DoorbellPopup } from './components/Cameras';
import { KioskPairPage, KioskShell } from './components/Kiosk';
import { resolveLayout, useApplyTheme, useHomeLayout } from './lib/layout';
import { isFamilyHubOS } from './lib/touchKeyboard';
import { useTouchKeyboard } from './lib/useTouchKeyboard';
import { Avatar, Icon, Spinner } from './components/ui';
import { api } from './lib/api';
import { ToastContext, ToastFn, useAuthStatus } from './lib/hooks';
import { CalendarPage } from './pages/CalendarPage';
import { ChoresPage } from './pages/ChoresPage';
import { HomePage } from './pages/HomePage';
import { ListsPage } from './pages/ListsPage';
import { LoginPage } from './pages/LoginPage';
import { MealsPage } from './pages/MealsPage';
import { SettingsPage } from './pages/SettingsPage';

const NAV = [
  { to: '/', label: 'Home', icon: 'home' },
  { to: '/calendar', label: 'Calendar', icon: 'calendar' },
  { to: '/lists', label: 'Lists', icon: 'list' },
  { to: '/chores', label: 'Chores', icon: 'star' },
  { to: '/meals', label: 'Meals', icon: 'meal' },
  { to: '/settings', label: 'Settings', icon: 'settings' },
];

export function App() {
  const { data: status, isLoading, error } = useAuthStatus();
  const { pathname } = useLocation();
  const [toasts, setToasts] = useState<{ id: number; msg: string; kind: string }[]>([]);
  const toast: ToastFn = useCallback((msg, kind = 'info') => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, msg, kind }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 4500);
  }, []);

  useEffect(() => {
    if (status?.appName) document.title = status.appName;
  }, [status?.appName]);
  useTouchKeyboard(!!status?.device || pathname.startsWith('/kiosk'));

  let body;
  if (isLoading)
    body = (
      <div className="center-screen loading-screen">
        <Spinner />
        {isFamilyHubOS() && <p className="loading-note">This might take a moment. Don’t unplug the device.</p>}
      </div>
    );
  else if (error || !status) body = <div className="center-screen">Can't reach the server. Retrying…</div>;
  else if (pathname.startsWith('/kiosk') && !status.device) body = <KioskPairPage status={status} />;
  else if (status.user && status.device) body = <KioskShell status={status} />;
  else if (!status.user) body = <LoginPage status={status} />;
  else body = <Shell appName={status.appName} />;

  return (
    <ToastContext.Provider value={toast}>
      {body}
      <div className="toasts" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast toast-${t.kind}`}>{t.msg}</div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

function Shell({ appName }: { appName: string }) {
  const { data } = useAuthStatus();
  const qc = useQueryClient();
  const me = data!.user!;
  const layout = useHomeLayout();
  useApplyTheme(layout.isSuccess ? resolveLayout(layout.data).theme : undefined);
  const [sidebar, setSidebar] = useSidebarState();
  const logout = async () => {
    await api('/auth/logout', 'POST');
    qc.clear();
    location.href = '/';
  };
  return (
    <div className={`shell sidebar-${sidebar}`}>
      {sidebar === 'hidden' && (
        <button className="sidebar-reveal" onClick={() => setSidebar('full')} title="Show the menu (Ctrl+\)" aria-label="Show the menu">
          <Icon name="sidebar" size={20} />
        </button>
      )}
      <aside className="sidebar" aria-hidden={sidebar === 'hidden'}>
        <div className="brand">
          <img src="/icon.svg" alt="" width={32} height={32} />
          <span className="brand-name">{appName}</span>
          <button
            className="icon-btn sidebar-toggle"
            onClick={() => setSidebar(sidebar === 'rail' ? 'full' : 'rail')}
            title={sidebar === 'rail' ? 'Expand the menu' : 'Collapse the menu'}
            aria-label={sidebar === 'rail' ? 'Expand the menu' : 'Collapse the menu'}
          >
            <Icon name={sidebar === 'rail' ? 'chevronsRight' : 'chevronsLeft'} size={18} />
          </button>
        </div>
        <nav className="nav">
          {NAV.map((n) => (
            <NavLink key={n.to} to={n.to} end={n.to === '/'} title={n.label} className={({ isActive }) => `nav-link ${isActive ? 'active' : ''}`}>
              <Icon name={n.icon} /> <span>{n.label}</span>
            </NavLink>
          ))}
        </nav>
        <div className="sidebar-foot">
          <button className="nav-link sidebar-hide" onClick={() => setSidebar('hidden')} title="Hide the menu (Ctrl+\)">
            <Icon name="sidebar" /> <span>Hide menu</span>
          </button>
          <div className="sidebar-me">
            <Avatar member={me} size={32} />
            <div className="sidebar-user">
              <div className="sidebar-name">{me.name}</div>
              <button className="link-btn" onClick={logout}>Sign out</button>
            </div>
          </div>
        </div>
      </aside>
      <main className="main">
        <Routes>
          <Route path="/" element={<HomePage />} />
          <Route path="/calendar" element={<CalendarPage />} />
          <Route path="/lists" element={<ListsPage />} />
          <Route path="/lists/:listId" element={<ListsPage />} />
          <Route path="/chores" element={<ChoresPage />} />
          <Route path="/meals" element={<MealsPage />} />
          <Route path="/settings" element={<SettingsPage onLogout={logout} />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
      <DoorbellPopup />
      <nav className="tabbar">
        {NAV.map((n) => (
          <NavLink key={n.to} to={n.to} end={n.to === '/'} className={({ isActive }) => `tab ${isActive ? 'active' : ''}`}>
            <Icon name={n.icon} size={22} />
            <span>{n.label}</span>
          </NavLink>
        ))}
      </nav>
    </div>
  );
}

type SidebarState = 'full' | 'rail' | 'hidden';
/** Desktop menu: full, icons only, or hidden. Remembered per device; Ctrl+\ toggles it. */
function useSidebarState(): [SidebarState, (s: SidebarState) => void] {
  const [state, setState] = useState<SidebarState>(() => {
    try {
      const v = localStorage.getItem('fh.sidebar');
      return v === 'rail' || v === 'hidden' ? v : 'full';
    } catch {
      return 'full';
    }
  });
  const set = useCallback((s: SidebarState) => {
    setState(s);
    try {
      localStorage.setItem('fh.sidebar', s);
    } catch {
      /* private mode */
    }
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === '\\') {
        e.preventDefault();
        setState((cur) => {
          const next = cur === 'hidden' ? 'full' : 'hidden';
          try {
            localStorage.setItem('fh.sidebar', next);
          } catch {
            /* ignore */
          }
          return next;
        });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  return [state, set];
}
