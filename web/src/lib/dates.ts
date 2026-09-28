export const pad = (n: number) => String(n).padStart(2, '0');

/** Local calendar date as YYYY-MM-DD. */
export function ymd(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function hm(d: Date): string {
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Parse YYYY-MM-DD as a local date (midnight). */
export function parseYmd(s: string): Date {
  const [y, m, d] = s.slice(0, 10).split('-').map(Number);
  return new Date(y, m - 1, d);
}

export function addDays(d: Date, n: number): Date {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}

export function addDaysYmd(s: string, n: number): string {
  return ymd(addDays(parseYmd(s), n));
}

export function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

export function startOfWeek(d: Date, weekStartsOn = 0): Date {
  const x = startOfDay(d);
  const diff = (x.getDay() - weekStartsOn + 7) % 7;
  return addDays(x, -diff);
}

export const today = () => ymd(new Date());

const fmtCache = new Map<string, Intl.DateTimeFormat>();
export function fmt(d: Date | string, opts: Intl.DateTimeFormatOptions): string {
  const key = JSON.stringify(opts);
  let f = fmtCache.get(key);
  if (!f) fmtCache.set(key, (f = new Intl.DateTimeFormat(undefined, opts)));
  return f.format(typeof d === 'string' ? (d.length === 10 ? parseYmd(d) : new Date(d)) : d);
}

export const fmtTime = (d: Date | string) => fmt(d, { hour: 'numeric', minute: '2-digit' });
export const fmtDayLong = (d: Date | string) => fmt(d, { weekday: 'long', month: 'long', day: 'numeric' });
export const fmtDayShort = (d: Date | string) => fmt(d, { weekday: 'short', month: 'short', day: 'numeric' });
export const fmtWeekday = (d: Date | string) => fmt(d, { weekday: 'short' });

export function relativeDayLabel(s: string): string {
  const t = today();
  if (s === t) return 'Today';
  if (s === addDaysYmd(t, 1)) return 'Tomorrow';
  if (s === addDaysYmd(t, -1)) return 'Yesterday';
  return fmtDayShort(s);
}

export const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// ---------- Simple RRULE helpers for the event form ----------
export type Repeat = 'none' | 'daily' | 'weekly' | 'biweekly' | 'monthly' | 'yearly';

export function buildRrule(repeat: Repeat, until: string | null): string | null {
  if (repeat === 'none') return null;
  const base: Record<Exclude<Repeat, 'none'>, string> = {
    daily: 'FREQ=DAILY',
    weekly: 'FREQ=WEEKLY',
    biweekly: 'FREQ=WEEKLY;INTERVAL=2',
    monthly: 'FREQ=MONTHLY',
    yearly: 'FREQ=YEARLY',
  };
  let r = base[repeat];
  if (until) r += `;UNTIL=${until.replace(/-/g, '')}T235959Z`;
  return r;
}

export function parseRrule(r: string | null): { repeat: Repeat; until: string | null } {
  if (!r) return { repeat: 'none', until: null };
  const parts = Object.fromEntries(r.split(';').map((p) => p.split('=')));
  const interval = Number(parts.INTERVAL ?? 1);
  let repeat: Repeat = 'weekly';
  if (parts.FREQ === 'DAILY') repeat = 'daily';
  else if (parts.FREQ === 'WEEKLY') repeat = interval === 2 ? 'biweekly' : 'weekly';
  else if (parts.FREQ === 'MONTHLY') repeat = 'monthly';
  else if (parts.FREQ === 'YEARLY') repeat = 'yearly';
  const u = parts.UNTIL as string | undefined;
  const until = u ? `${u.slice(0, 4)}-${u.slice(4, 6)}-${u.slice(6, 8)}` : null;
  return { repeat, until };
}

export function describeRrule(r: string | null): string {
  const { repeat, until } = parseRrule(r);
  if (repeat === 'none') return '';
  const label = { daily: 'Every day', weekly: 'Every week', biweekly: 'Every 2 weeks', monthly: 'Every month', yearly: 'Every year' }[repeat];
  return until ? `${label} until ${fmtDayShort(until)}` : label;
}
