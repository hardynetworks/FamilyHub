/**
 * Reminders, sent through the Android app (push) and email (Mailjet):
 *  - events with a reminder ("15 minutes before") go to the people on the event,
 *  - to-dos due today go to whoever they're assigned to, at the morning reminder time,
 *  - birthdays and anniversaries go to the grown-ups a few days before and on the day.
 * Each reminder is sent once (reminders_sent remembers it), also after a restart.
 */
import { Router } from 'express';
import { z } from 'zod';
import { config } from './config';
import { q } from './db';
import { notifyPeople } from './notify';
import { defaultEmoji, listOccasions, nextOccurrence, occasionLabel, yearsLabel } from './occasions';
import { EventRow, expand } from './routes/events';
import { getSetting, saveSettings } from './settings';
import { parse, todayInTz, utcToWall } from './util';

const CATCH_UP_MS = 20 * 60_000; // send late reminders up to 20 minutes after they were due (e.g. after a restart)
const MAX_LEAD_MIN = 40320; // 4 weeks

async function once(key: string): Promise<boolean> {
  const r = await q('insert into reminders_sent (key) values ($1) on conflict do nothing returning key', [key]);
  return r.length > 0;
}

function appUrl(path: string) {
  const base = (config.appUrl || '').replace(/\/+$/, '');
  return base ? `${base}${path}` : undefined;
}

const fmtTime = (d: Date) => new Intl.DateTimeFormat('en-US', { timeZone: config.timezone, hour: 'numeric', minute: '2-digit' }).format(d);
const fmtDay = (d: Date) => new Intl.DateTimeFormat('en-US', { timeZone: config.timezone, weekday: 'long', month: 'short', day: 'numeric' }).format(d);

function whenText(start: Date, allDay: boolean): string {
  const today = todayInTz();
  const day = allDay ? start.toISOString().slice(0, 10) : utcToWall(start, config.timezone).toISOString().slice(0, 10);
  const tomorrow = new Date(Date.parse(today) + 86400_000).toISOString().slice(0, 10);
  const dayText = day === today ? 'Today' : day === tomorrow ? 'Tomorrow' : fmtDay(allDay ? new Date(day + 'T12:00:00Z') : start);
  if (allDay) return `${dayText} (all day)`;
  const mins = Math.round((start.getTime() - Date.now()) / 60_000);
  if (mins >= 0 && mins < 60) return mins <= 1 ? `Starting now (${fmtTime(start)})` : `In ${mins} minutes (${fmtTime(start)})`;
  return `${dayText} at ${fmtTime(start)}`;
}

/** Who hears about an event: the people on it, else whoever made it, else the heads of household. */
async function eventRecipients(r: EventRow): Promise<string[]> {
  if (r.member_ids?.length) return r.member_ids;
  if (r.created_by) return [r.created_by];
  return (await q<{ id: string }>(`select id from users where role = 'admin' and can_login`)).map((x) => x.id);
}

async function eventReminders() {
  const now = Date.now();
  const from = new Date(now - CATCH_UP_MS);
  const until = new Date(now + MAX_LEAD_MIN * 60_000 + 60_000);
  const rows = await q<EventRow>(
    `select * from events where reminder_minutes is not null
       and ((rrule is null and start_at >= $1 and start_at <= $2) or (rrule is not null and start_at <= $2))`,
    [from, until],
  );
  for (const r of rows) {
    const lead = r.reminder_minutes! * 60_000;
    const occs = r.rrule ? expand(r, new Date(now - CATCH_UP_MS + lead), new Date(now + lead + 60_000)) : [{ start: r.start_at, end: r.end_at }];
    for (const o of occs) {
      const fireAt = o.start.getTime() - lead;
      if (fireAt > now || fireAt < now - CATCH_UP_MS) continue;
      if (!(await once(`event:${r.id}:${o.start.getTime()}:${r.reminder_minutes}`))) continue;
      const to = await eventRecipients(r);
      await notifyPeople(to, {
        title: `⏰ ${r.title}`,
        message: `${whenText(o.start, r.all_day)}${r.location ? `\n📍 ${r.location}` : ''}`,
        url: appUrl('/calendar'),
      });
    }
  }
}

/** Has today's morning reminder time passed? */
function morningDue(): { due: boolean; today: string } {
  const today = todayInTz();
  const time = String(getSetting('reminderTime') || '').trim();
  if (!/^\d{1,2}:\d{2}$/.test(time)) return { due: false, today };
  const [h, m] = time.split(':').map(Number);
  const now = utcToWall(new Date(), config.timezone).toISOString().slice(11, 16);
  return { due: now >= `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`, today };
}

async function todoReminders(today: string) {
  const items = await q<{ id: string; text: string; assignee_id: string | null; created_by: string | null; list_name: string }>(
    `select i.id, i.text, i.assignee_id, i.created_by, l.name as list_name from list_items i join lists l on l.id = i.list_id
     where not i.checked and i.due_date = $1`,
    [today],
  );
  const admins = (await q<{ id: string }>(`select id from users where role = 'admin' and can_login`)).map((x) => x.id);
  const byPerson = new Map<string, { id: string; text: string; list_name: string }[]>();
  for (const it of items) {
    if (!(await once(`todo:${it.id}:${today}`))) continue;
    const people = it.assignee_id ? [it.assignee_id] : it.created_by ? [it.created_by] : admins;
    for (const p of people) {
      if (!byPerson.has(p)) byPerson.set(p, []);
      byPerson.get(p)!.push(it);
    }
  }
  for (const [person, list] of byPerson) {
    const lines = list.map((i) => `• ${i.text}${i.list_name ? ` (${i.list_name})` : ''}`).join('\n');
    await notifyPeople([person], {
      title: list.length === 1 ? `📝 Due today: ${list[0].text}` : `📝 ${list.length} to-dos due today`,
      message: lines,
      url: appUrl('/lists'),
    });
  }
}

async function occasionReminders(today: string) {
  const grownUps = await q<{ id: string }>(`select id from users where member_type = 'adult' and can_login`);
  for (const o of await listOccasions()) {
    const n = nextOccurrence(o, today);
    const onDay = n.daysUntil === 0;
    if (!onDay && n.daysUntil !== o.remind_days) continue;
    if (!(await once(`occasion:${o.id}:${n.date}:${n.daysUntil}`))) continue;
    // Keep birthday surprises: the birthday person doesn't get the "coming up" reminder.
    const to = grownUps.map((u) => u.id).filter((id) => onDay || id !== o.member_id);
    const extra = yearsLabel(o, n.years);
    const label = occasionLabel(o);
    await notifyPeople(to, {
      title: `${defaultEmoji(o)} ${onDay ? `Today is ${label}!` : `${label} in ${n.daysUntil} day${n.daysUntil === 1 ? '' : 's'}`}`,
      message: `${onDay ? 'Today' : fmtDay(new Date(n.date + 'T12:00:00Z'))}${extra ? ` · ${extra}` : ''}`,
      url: appUrl('/calendar'),
    });
  }
}

let morningDoneFor = '';

async function tick() {
  await eventReminders().catch((e) => console.warn('Event reminders failed:', e.message));
  const m = morningDue();
  if (m.due && morningDoneFor !== m.today) {
    morningDoneFor = m.today;
    await todoReminders(m.today).catch((e) => console.warn('To-do reminders failed:', e.message));
    await occasionReminders(m.today).catch((e) => console.warn('Birthday reminders failed:', e.message));
    await q(`delete from reminders_sent where sent_at < now() - interval '90 days'`).catch(() => {});
  }
}

export function startReminders() {
  const loop = async () => {
    await tick();
    setTimeout(loop, 60_000);
  };
  setTimeout(loop, 15_000);
}

/** Settings → Screen & alerts → Reminders (heads of household): the morning reminder time. Mounted behind requireAdmin. */
export const remindersAdminRouter = Router();
remindersAdminRouter.get('/', (_req, res) => {
  res.json({ time: getSetting('reminderTime') });
});
remindersAdminRouter.put('/', async (req, res) => {
  const { time } = parse(z.object({ time: z.string().regex(/^(|\d{1,2}:\d{2})$/) }), req.body);
  await saveSettings({ reminderTime: time });
  res.json({ ok: true });
});
