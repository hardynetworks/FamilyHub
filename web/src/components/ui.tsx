import { ReactNode, useEffect, useRef, useState } from 'react';
import { Member } from '../lib/api';

export function Modal({ title, onClose, children, footer, wide }: { title: string; onClose: () => void; children: ReactNode; footer?: ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    ref.current?.querySelector<HTMLElement>('input, textarea, select')?.focus();
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal ${wide ? 'modal-wide' : ''}`} role="dialog" aria-modal="true" aria-label={title} ref={ref}>
        <header className="modal-head">
          <h2>{title}</h2>
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            <Icon name="x" />
          </button>
        </header>
        <div className="modal-body">{children}</div>
        {footer && <footer className="modal-foot">{footer}</footer>}
      </div>
    </div>
  );
}

export function Avatar({ member, size = 28 }: { member?: Member | null; size?: number }) {
  if (!member) return <span className="avatar avatar-empty" style={{ width: size, height: size }} />;
  const label = member.avatar || member.name.slice(0, 1).toUpperCase();
  return (
    <span className="avatar" title={member.name} style={{ width: size, height: size, background: member.color, fontSize: size * 0.48 }}>
      {label}
    </span>
  );
}

export function MemberPicker({ members, value, onChange, multi = true }: { members: Member[]; value: string[]; onChange: (v: string[]) => void; multi?: boolean }) {
  return (
    <div className="chip-row">
      {members.map((m) => {
        const on = value.includes(m.id);
        return (
          <button
            type="button"
            key={m.id}
            className={`chip ${on ? 'chip-on' : ''}`}
            style={on ? { background: m.color, borderColor: m.color, color: '#fff' } : { borderColor: m.color }}
            onClick={() => onChange(multi ? (on ? value.filter((x) => x !== m.id) : [...value, m.id]) : on ? [] : [m.id])}
          >
            {m.avatar && <span>{m.avatar}</span>} {m.name}
          </button>
        );
      })}
    </div>
  );
}

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: ReactNode }) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      {children}
      {hint && <span className="field-hint">{hint}</span>}
    </label>
  );
}

export function Empty({ icon, title, children }: { icon?: string; title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      {icon && <div className="empty-icon">{icon}</div>}
      <div className="empty-title">{title}</div>
      {children && <div className="empty-body">{children}</div>}
    </div>
  );
}

export function Spinner() {
  return <div className="spinner" aria-label="Loading" />;
}

const paths: Record<string, string> = {
  home: 'M3 10.5 12 3l9 7.5V21a1 1 0 0 1-1 1h-5v-7H9v7H4a1 1 0 0 1-1-1z',
  calendar: 'M7 2v3M17 2v3M3 9h18M5 5h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2z',
  list: 'M9 6h11M9 12h11M9 18h11M4 6h.01M4 12h.01M4 18h.01',
  star: 'm12 3 2.8 5.7 6.2.9-4.5 4.4 1 6.2L12 17.3 6.5 20.2l1-6.2L3 9.6l6.2-.9z',
  meal: 'M4 3v8a3 3 0 0 0 6 0V3M7 3v18M17 3c-2 0-3 2.5-3 6s1 4 3 4v8',
  settings: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z',
  plus: 'M12 5v14M5 12h14',
  x: 'M18 6 6 18M6 6l12 12',
  check: 'M20 6 9 17l-5-5',
  left: 'm15 18-6-6 6-6',
  right: 'm9 18 6-6-6-6',
  trash: 'M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14',
  edit: 'M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z',
  refresh: 'M21 12a9 9 0 1 1-2.6-6.4M21 3v6h-6',
  cart: 'M3 3h2l2.4 12.4a2 2 0 0 0 2 1.6h8.8a2 2 0 0 0 2-1.6L22 7H6M10 21h.01M18 21h.01',
  logout: 'M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9',
  pin: 'M12 21s-7-6.2-7-12a7 7 0 0 1 14 0c0 5.8-7 12-7 12zM12 11a2 2 0 1 0 0-4 2 2 0 0 0 0 4z',
  repeat: 'm17 2 4 4-4 4M3 11V9a3 3 0 0 1 3-3h15M7 22l-4-4 4-4M21 13v2a3 3 0 0 1-3 3H3',
  up: 'm18 15-6-6-6 6',
  down: 'm6 9 6 6 6-6',
  camera: 'M23 7l-7 5 7 5V7zM3 5h11a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2z',
  image: 'M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2zM8.5 10a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3zM21 15l-5-5L5 21',
  google: 'M21 12.2c0-.7-.1-1.4-.2-2H12v3.9h5a4.3 4.3 0 0 1-1.9 2.8v2.3h3A9 9 0 0 0 21 12.2zM12 21a8.9 8.9 0 0 0 6.1-2.3l-3-2.3a5.5 5.5 0 0 1-8.2-2.9H3.8v2.4A9 9 0 0 0 12 21zM6.9 13.5a5.4 5.4 0 0 1 0-3.4V7.7H3.8a9 9 0 0 0 0 8.1zM12 6.6a4.9 4.9 0 0 1 3.5 1.4l2.6-2.6A8.8 8.8 0 0 0 12 3a9 9 0 0 0-8.2 4.7l3.1 2.4A5.4 5.4 0 0 1 12 6.6z',
};

export function Icon({ name, size = 20 }: { name: keyof typeof paths | string; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={paths[name] ?? ''} />
    </svg>
  );
}

/** <datalist id="tz-list"> with every IANA time zone the browser knows. */
export function TimezoneList() {
  const zones: string[] = (Intl as any).supportedValuesOf?.('timeZone') ?? [];
  return (
    <datalist id="tz-list">
      {zones.map((z) => (
        <option key={z} value={z} />
      ))}
    </datalist>
  );
}

export function CopyField({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="copy-field">
      <code>{value}</code>
      <button
        type="button"
        className="btn btn-sm"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(value);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          } catch {
            /* clipboard unavailable (e.g. plain http) */
          }
        }}
      >
        {copied ? 'Copied' : 'Copy'}
      </button>
    </div>
  );
}

export const EMOJI_CHOICES = ['🏠', '👩', '👨', '👧', '👦', '👶', '👵', '👴', '🐶', '🐱', '⭐', '🌈', '⚽', '🎨', '🎮', '🎸', '📚', '🦄', '🚀', '🌻'];
export const COLOR_CHOICES = ['#5b7cfa', '#f06a6a', '#2bb673', '#f5a623', '#a65bfa', '#1fb5c9', '#ec5fa8', '#8a6d3b', '#607080'];
