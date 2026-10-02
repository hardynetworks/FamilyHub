/**
 * Minimal iCalendar (RFC 5545) reading and writing for CalDAV calendars (iCloud and others) and
 * .ics subscriptions. Handles what calendars actually use for events: VEVENT with DTSTART/DTEND
 * or DURATION (dates, UTC, floating and TZID times), RRULE, EXDATE, RECURRENCE-ID, STATUS,
 * SUMMARY, DESCRIPTION, LOCATION and UID.
 */
import { config, isValidTimezone } from './config';
import { wallToUtc } from './util';

export interface IcsEvent {
  uid: string;
  title: string;
  description: string | null;
  location: string | null;
  start: Date;
  end: Date;
  allDay: boolean;
  rrule: string | null;
  exdates: Date[];
  recurrenceId: Date | null;
  cancelled: boolean;
  /** FamilyHub member ids saved by FamilyHub itself (X-FAMILYHUB-MEMBERS). */
  memberIds: string[] | null;
}

interface Prop {
  name: string;
  params: Record<string, string>;
  value: string;
}

/** Windows / Outlook time zone names that show up in .ics files, mapped to IANA names. */
const WINDOWS_TZ: Record<string, string> = {
  'Eastern Standard Time': 'America/New_York',
  'Central Standard Time': 'America/Chicago',
  'Mountain Standard Time': 'America/Denver',
  'US Mountain Standard Time': 'America/Phoenix',
  'Pacific Standard Time': 'America/Los_Angeles',
  'Alaskan Standard Time': 'America/Anchorage',
  'Hawaiian Standard Time': 'Pacific/Honolulu',
  'Atlantic Standard Time': 'America/Halifax',
  'Newfoundland Standard Time': 'America/St_Johns',
  'GMT Standard Time': 'Europe/London',
  'Greenwich Standard Time': 'Atlantic/Reykjavik',
  'W. Europe Standard Time': 'Europe/Berlin',
  'Romance Standard Time': 'Europe/Paris',
  'Central Europe Standard Time': 'Europe/Budapest',
  'Central European Standard Time': 'Europe/Warsaw',
  'E. Europe Standard Time': 'Europe/Chisinau',
  'FLE Standard Time': 'Europe/Kiev',
  'GTB Standard Time': 'Europe/Bucharest',
  'AUS Eastern Standard Time': 'Australia/Sydney',
  'E. Australia Standard Time': 'Australia/Brisbane',
  'Cen. Australia Standard Time': 'Australia/Adelaide',
  'W. Australia Standard Time': 'Australia/Perth',
  'New Zealand Standard Time': 'Pacific/Auckland',
  'India Standard Time': 'Asia/Kolkata',
  'China Standard Time': 'Asia/Shanghai',
  'Tokyo Standard Time': 'Asia/Tokyo',
  'Singapore Standard Time': 'Asia/Singapore',
  UTC: 'UTC',
  'Coordinated Universal Time': 'UTC',
};

function resolveTz(tzid: string | undefined): string {
  if (!tzid) return config.timezone;
  let t = tzid.replace(/^"|"$/g, '').replace(/^\/[^/]+\/[^/]+\//, ''); // strip "/mozilla.org/20050126_1/" style prefixes
  if (WINDOWS_TZ[t]) t = WINDOWS_TZ[t];
  return isValidTimezone(t) ? t : config.timezone;
}

/** Unfold lines and split into properties. */
function lines(text: string): Prop[] {
  const raw = text.replace(/\r\n|\r/g, '\n').replace(/\n[ \t]/g, '').split('\n');
  const out: Prop[] = [];
  for (const line of raw) {
    if (!line.trim()) continue;
    // name;param=value;param="v:a;l":value  (colons/semicolons inside quotes don't split)
    let i = 0;
    let inQuote = false;
    let colon = -1;
    for (; i < line.length; i++) {
      const c = line[i];
      if (c === '"') inQuote = !inQuote;
      else if (c === ':' && !inQuote) {
        colon = i;
        break;
      }
    }
    if (colon < 0) continue;
    const head = line.slice(0, colon);
    const value = line.slice(colon + 1);
    const parts: string[] = [];
    let cur = '';
    inQuote = false;
    for (const c of head) {
      if (c === '"') inQuote = !inQuote;
      if (c === ';' && !inQuote) {
        parts.push(cur);
        cur = '';
      } else cur += c;
    }
    parts.push(cur);
    const params: Record<string, string> = {};
    for (const p of parts.slice(1)) {
      const eq = p.indexOf('=');
      if (eq > 0) params[p.slice(0, eq).toUpperCase()] = p.slice(eq + 1).replace(/^"|"$/g, '');
    }
    out.push({ name: parts[0].toUpperCase(), params, value });
  }
  return out;
}

export function unescapeText(v: string): string {
  return v.replace(/\\([\\;,nN])/g, (_m, c: string) => (c === 'n' || c === 'N' ? '\n' : c));
}

export function escapeText(v: string): string {
  return v.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
}

/** Parse a DATE or DATE-TIME value. */
export function parseIcsDate(value: string, params: Record<string, string>): { date: Date; allDay: boolean } | null {
  const v = value.trim();
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/.exec(v);
  if (!m) return null;
  const [, y, mo, d, h, mi, s, z] = m;
  if (params.VALUE === 'DATE' || h === undefined) {
    return { date: new Date(Date.UTC(+y, +mo - 1, +d)), allDay: true };
  }
  const wall = new Date(Date.UTC(+y, +mo - 1, +d, +h, +mi, +(s ?? 0)));
  if (z) return { date: wall, allDay: false };
  return { date: wallToUtc(wall, resolveTz(params.TZID)), allDay: false };
}

/** ISO 8601 duration (P1D, PT1H30M, P1W, -PT15M) in milliseconds. */
export function parseDuration(v: string): number | null {
  const m = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(v.trim());
  if (!m) return null;
  const [, sign, w, d, h, mi, s] = m;
  const ms = ((+(w ?? 0) * 7 + +(d ?? 0)) * 86400 + +(h ?? 0) * 3600 + +(mi ?? 0) * 60 + +(s ?? 0)) * 1000;
  return sign === '-' ? -ms : ms;
}

/** All VEVENTs in an iCalendar document (VTIMEZONE and other components are skipped). */
export function parseIcs(text: string): IcsEvent[] {
  const events: IcsEvent[] = [];
  let depth: string[] = [];
  let cur: Prop[] | null = null;
  for (const p of lines(text)) {
    if (p.name === 'BEGIN') {
      depth.push(p.value.toUpperCase());
      if (p.value.toUpperCase() === 'VEVENT' && depth.length <= 2) cur = [];
      continue;
    }
    if (p.name === 'END') {
      const what = p.value.toUpperCase();
      if (what === 'VEVENT' && cur) {
        const ev = buildEvent(cur);
        if (ev) events.push(ev);
        cur = null;
      }
      const i = depth.lastIndexOf(what);
      depth = i >= 0 ? depth.slice(0, i) : depth;
      continue;
    }
    // Only the event's own properties (not those of a VALARM inside it).
    if (cur && depth[depth.length - 1] === 'VEVENT') cur.push(p);
  }
  return events;
}

function buildEvent(props: Prop[]): IcsEvent | null {
  const get = (n: string) => props.find((p) => p.name === n);
  const startP = get('DTSTART');
  if (!startP) return null;
  const start = parseIcsDate(startP.value, startP.params);
  if (!start) return null;
  let end: Date;
  const endP = get('DTEND') ?? get('DUE');
  const parsedEnd = endP ? parseIcsDate(endP.value, endP.params) : null;
  const durP = get('DURATION');
  const dur = durP ? parseDuration(durP.value) : null;
  if (parsedEnd) end = parsedEnd.date;
  else if (dur !== null) end = new Date(start.date.getTime() + dur);
  else end = new Date(start.date.getTime() + (start.allDay ? 86400_000 : 0));
  if (end < start.date) end = new Date(start.date.getTime() + (start.allDay ? 86400_000 : 0));
  if (start.allDay && end.getTime() === start.date.getTime()) end = new Date(start.date.getTime() + 86400_000);

  const exdates: Date[] = [];
  for (const p of props.filter((x) => x.name === 'EXDATE')) {
    for (const v of p.value.split(',')) {
      const d = parseIcsDate(v, p.params);
      if (d) exdates.push(d.date);
    }
  }
  const ridP = get('RECURRENCE-ID');
  const rid = ridP ? parseIcsDate(ridP.value, ridP.params) : null;
  const rruleP = get('RRULE');
  let rrule = rruleP ? rruleP.value.trim().toUpperCase() : null;
  if (rrule && !/FREQ=/.test(rrule)) rrule = null;
  // UNTIL as a plain date on a timed event confuses the expander; give it a time.
  if (rrule) rrule = rrule.replace(/UNTIL=(\d{8})(;|$)/, (_m, d: string, end2: string) => (start.allDay ? `UNTIL=${d}${end2}` : `UNTIL=${d}T235959Z${end2}`));
  const members = get('X-FAMILYHUB-MEMBERS');
  return {
    uid: get('UID')?.value.trim() || `${startP.value}-${get('SUMMARY')?.value ?? ''}`,
    title: unescapeText(get('SUMMARY')?.value ?? '').trim() || '(No title)',
    description: get('DESCRIPTION') ? unescapeText(get('DESCRIPTION')!.value) : null,
    location: get('LOCATION') ? unescapeText(get('LOCATION')!.value) || null : null,
    start: start.date,
    end,
    allDay: start.allDay,
    rrule,
    exdates,
    recurrenceId: rid?.date ?? null,
    cancelled: (get('STATUS')?.value ?? '').toUpperCase() === 'CANCELLED',
    memberIds: members ? members.value.split(',').map((s) => s.trim()).filter(Boolean) : null,
  };
}

// ---- Writing ---------------------------------------------------------------------------------

const pad = (n: number) => String(n).padStart(2, '0');
const icsUtc = (d: Date) =>
  `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;
const icsDate = (d: Date) => `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}`;

/** Fold a content line at 75 octets (RFC 5545 3.1). */
function fold(line: string): string {
  const bytes = Buffer.from(line, 'utf8');
  if (bytes.length <= 75) return line;
  const out: string[] = [];
  let chunk = '';
  let size = 0;
  for (const ch of line) {
    const n = Buffer.byteLength(ch, 'utf8');
    if (size + n > (out.length ? 74 : 75)) {
      out.push(chunk);
      chunk = '';
      size = 0;
    }
    chunk += ch;
    size += n;
  }
  out.push(chunk);
  return out.join('\r\n ');
}

export interface IcsWriteInput {
  uid: string;
  title: string;
  description?: string | null;
  location?: string | null;
  start: Date;
  end: Date;
  allDay: boolean;
  rrule?: string | null;
  exdates?: Date[];
  memberIds: string[];
}

export function buildIcs(ev: IcsWriteInput): string {
  const L: string[] = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//FamilyHub//EN', 'CALSCALE:GREGORIAN', 'BEGIN:VEVENT'];
  L.push(`UID:${ev.uid}`);
  L.push(`DTSTAMP:${icsUtc(new Date())}`);
  if (ev.allDay) {
    L.push(`DTSTART;VALUE=DATE:${icsDate(ev.start)}`);
    L.push(`DTEND;VALUE=DATE:${icsDate(ev.end)}`);
  } else {
    L.push(`DTSTART:${icsUtc(ev.start)}`);
    L.push(`DTEND:${icsUtc(ev.end)}`);
  }
  if (ev.rrule) L.push(`RRULE:${ev.rrule}`);
  if (ev.rrule && ev.exdates?.length) {
    L.push(ev.allDay ? `EXDATE;VALUE=DATE:${ev.exdates.map(icsDate).join(',')}` : `EXDATE:${ev.exdates.map(icsUtc).join(',')}`);
  }
  L.push(`SUMMARY:${escapeText(ev.title)}`);
  if (ev.description) L.push(`DESCRIPTION:${escapeText(ev.description)}`);
  if (ev.location) L.push(`LOCATION:${escapeText(ev.location)}`);
  L.push(`X-FAMILYHUB-MEMBERS:${ev.memberIds.join(',')}`);
  L.push('END:VEVENT', 'END:VCALENDAR');
  return L.map(fold).join('\r\n') + '\r\n';
}
