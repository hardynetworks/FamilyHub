/**
 * Parent notifications: email (your own SMTP server), texts through a carrier's email-to-text
 * address, and phone push notifications through ntfy or Pushover.
 */
import nodemailer from 'nodemailer';
import type { UserRow } from './auth';
import { q } from './db';
import { getSetting } from './settings';

export interface Channel {
  channel: string;
  ok: boolean;
  message: string;
}

export interface ParentAlert {
  title: string;
  message: string;
  /** Link that opens the approval page. */
  url?: string;
  /** Links that approve / deny straight from a push notification (POST). */
  approveUrl?: string;
  denyUrl?: string;
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export function smtpConfigured() {
  return !!getSetting('smtpHost') && !!getSetting('smtpFrom');
}

async function sendMail(to: string[], subject: string, text: string, html?: string) {
  const security = getSetting('smtpSecurity');
  const transport = nodemailer.createTransport({
    host: getSetting('smtpHost'),
    port: Number(getSetting('smtpPort')) || 587,
    secure: security === 'tls',
    requireTLS: security === 'starttls',
    ignoreTLS: security === 'none',
    auth: getSetting('smtpUser') ? { user: getSetting('smtpUser'), pass: getSetting('smtpPassword') } : undefined,
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
  });
  await transport.sendMail({ from: getSetting('smtpFrom'), to, subject, text, html });
}

async function sendNtfy(a: ParentAlert) {
  const base = getSetting('ntfyUrl').replace(/\/+$/, '');
  const topic = getSetting('ntfyTopic');
  const actions: any[] = [];
  if (a.approveUrl) actions.push({ action: 'http', label: 'Approve', url: a.approveUrl, method: 'POST', clear: true });
  if (a.denyUrl) actions.push({ action: 'http', label: 'Deny', url: a.denyUrl, method: 'POST', clear: true });
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (getSetting('ntfyToken')) headers.Authorization = `Bearer ${getSetting('ntfyToken')}`;
  const r = await fetch(base + '/', {
    method: 'POST',
    headers,
    body: JSON.stringify({ topic, title: a.title, message: a.message, tags: ['broom'], priority: 4, click: a.url, actions }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!r.ok) throw new Error(`ntfy answered HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
}

async function sendPushover(a: ParentAlert) {
  const body = new URLSearchParams({ token: getSetting('pushoverAppToken'), user: getSetting('pushoverUserKey'), title: a.title, message: a.message });
  if (a.url) {
    body.set('url', a.url);
    body.set('url_title', 'Approve or deny');
  }
  const r = await fetch('https://api.pushover.net/1/messages.json', { method: 'POST', body, signal: AbortSignal.timeout(10_000) });
  if (!r.ok) throw new Error(`Pushover answered HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
}

function alertEmailHtml(a: ParentAlert) {
  const btn = (href: string, label: string, bg: string) =>
    `<a href="${esc(href)}" style="display:inline-block;padding:12px 22px;border-radius:10px;background:${bg};color:#fff;text-decoration:none;font-weight:700;margin-right:8px">${label}</a>`;
  return `<!doctype html><html><body style="margin:0;background:#f3f5fa;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#0f172a">
<div style="max-width:520px;margin:0 auto;padding:28px 20px">
<div style="background:#fff;border-radius:16px;padding:24px;border:1px solid #e2e7f0">
<div style="font-size:13px;color:#5b6478;font-weight:600">${esc(getSetting('familyName') || getSetting('appName'))}</div>
<h1 style="font-size:20px;margin:6px 0 10px">${esc(a.title)}</h1>
<p style="font-size:15px;line-height:1.5;margin:0 0 18px">${esc(a.message)}</p>
${a.url ? btn(a.url + '?a=approve', 'Approve', '#10b981') + btn(a.url + '?a=deny', 'Deny', '#e11d48') : ''}
</div>
<p style="font-size:12px;color:#8e99b3;margin-top:14px">Sent by FamilyHub. Change who gets these in Settings → Screen &amp; alerts.</p>
</div></body></html>`;
}

/** Heads of household who can sign in and should hear about approvals. */
async function parents() {
  return q<UserRow>(`select * from users where role = 'admin' and can_login`);
}

/** Send an alert to every parent on every configured channel. Never throws; returns what happened. */
export async function notifyParents(a: ParentAlert, only?: UserRow[]): Promise<Channel[]> {
  const out: Channel[] = [];
  const people = only ?? (await parents());
  if (smtpConfigured()) {
    const emails = people.filter((p) => p.email && p.prefs?.notifyEmail !== false).map((p) => p.email!);
    if (emails.length) {
      try {
        await sendMail(emails, a.title, `${a.message}${a.url ? `\n\nApprove or deny: ${a.url}` : ''}`, alertEmailHtml(a));
        out.push({ channel: 'Email', ok: true, message: `Sent to ${emails.join(', ')}` });
      } catch (e: any) {
        out.push({ channel: 'Email', ok: false, message: e.message });
      }
    }
    const texts = people.map((p) => p.prefs?.notifyText).filter((t): t is string => !!t);
    if (texts.length) {
      try {
        // Texts are short and plain; carriers drop long or HTML messages.
        await sendMail(texts, '', `${a.title}: ${a.message}${a.url ? ` ${a.url}` : ''}`.slice(0, 300));
        out.push({ channel: 'Text', ok: true, message: `Sent to ${texts.join(', ')}` });
      } catch (e: any) {
        out.push({ channel: 'Text', ok: false, message: e.message });
      }
    }
  }
  if (getSetting('ntfyTopic')) {
    try {
      await sendNtfy(a);
      out.push({ channel: 'ntfy', ok: true, message: `Sent to topic ${getSetting('ntfyTopic')}` });
    } catch (e: any) {
      out.push({ channel: 'ntfy', ok: false, message: e.cause?.code ?? e.message });
    }
  }
  if (getSetting('pushoverAppToken') && getSetting('pushoverUserKey')) {
    try {
      await sendPushover(a);
      out.push({ channel: 'Pushover', ok: true, message: 'Sent' });
    } catch (e: any) {
      out.push({ channel: 'Pushover', ok: false, message: e.message });
    }
  }
  for (const c of out) if (!c.ok) console.warn(`Notification via ${c.channel} failed: ${c.message}`);
  return out;
}

export async function sendTestNotifications(user: UserRow) {
  const results = await notifyParents(
    { title: 'FamilyHub test', message: `Notifications are working, ${user.name.split(' ')[0]}! Chore approvals will arrive like this.` },
    [user],
  );
  if (!results.length) {
    return { ok: false, message: 'Nothing is set up yet: add an email server, an ntfy topic or Pushover keys, and save.', results };
  }
  return { ok: results.every((r) => r.ok), message: results.map((r) => `${r.channel}: ${r.ok ? '✓ ' : '✗ '}${r.message}`).join('\n'), results };
}
