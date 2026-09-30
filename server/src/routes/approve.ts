/**
 * One-tap chore approval from an email, text or push notification (no sign-in needed: the link
 * carries a one-time secret). GET only shows a confirmation page, so mail scanners that open
 * links can't approve anything; approving is a POST from the page's buttons.
 */
import { Request, Response, Router } from 'express';
import { one } from '../db';
import { hashToken } from '../devices';
import { getSetting } from '../settings';
import { reviewCompletion } from './chores';

export const approveRouter = Router();

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const MAX_AGE_DAYS = 14;

function page(res: Response, title: string, body: string, status = 200) {
  res.status(status).setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title><style>
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#0b1020;color:#e8ecf6;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;padding:20px;box-sizing:border-box}
.card{width:100%;max-width:420px;background:#141b2e;border:1px solid rgba(148,163,184,.16);border-radius:20px;padding:28px 24px;text-align:center}
h1{font-size:22px;margin:8px 0}.big{font-size:44px}.muted{color:#8e99b3;font-size:14px}
form{display:flex;gap:10px;margin-top:20px}button{flex:1;border:0;border-radius:12px;padding:14px;font-size:16px;font-weight:700;color:#fff;cursor:pointer}
.ok{background:#10b981}.no{background:#e11d48}.dim{opacity:.55}a{color:#a5b4fc}
</style></head><body><div class="card">${body}</div></body></html>`);
}

async function load(token: string) {
  return one<{ id: string; status: string; points: number; completed_at: Date; title: string; emoji: string | null; name: string | null }>(
    `select cc.id, cc.status, cc.points, cc.completed_at, c.title, c.emoji, u.name
     from chore_completions cc join chores c on c.id = cc.chore_id left join users u on u.id = cc.completed_by
     where cc.review_token_hash = $1`,
    [hashToken(token)],
  );
}

const expired = (d: Date) => Date.now() - new Date(d).getTime() > MAX_AGE_DAYS * 86400_000;
const appLink = () => `<p class="muted"><a href="/chores">Open ${esc(getSetting('appName'))}</a></p>`;

approveRouter.get('/:token', async (req: Request, res: Response) => {
  const c = await load(String(req.params.token));
  if (!c || c.status !== 'pending' || expired(c.completed_at)) {
    return page(res, 'Already handled', `<div class="big">✅</div><h1>Nothing to approve</h1><p class="muted">This chore was already approved or denied, or the link has expired.</p>${appLink()}`, 404);
  }
  const want = String(req.query.a ?? '');
  const who = esc(c.name?.split(' ')[0] ?? 'Someone');
  page(
    res,
    'Approve chore?',
    `<div class="big">${esc(c.emoji ?? '🧹')}</div><h1>${who} finished “${esc(c.title)}”</h1>
<p class="muted">${c.points ? `Worth ${c.points} point${c.points === 1 ? '' : 's'}. ` : ''}Did it get done?</p>
<form method="post"><button class="ok ${want === 'deny' ? 'dim' : ''}" formaction="${esc(req.baseUrl)}/${esc(String(req.params.token))}/approve">Approve</button>
<button class="no ${want === 'approve' ? 'dim' : ''}" formaction="${esc(req.baseUrl)}/${esc(String(req.params.token))}/deny">Not yet</button></form>`,
  );
});

approveRouter.post('/:token/:action', async (req: Request, res: Response) => {
  const action = String(req.params.action);
  if (action !== 'approve' && action !== 'deny') return res.status(404).end();
  const c = await load(String(req.params.token));
  const wantsHtml = (req.headers.accept ?? '').includes('text/html');
  if (!c || c.status !== 'pending' || expired(c.completed_at)) {
    if (!wantsHtml) return res.status(409).json({ ok: false, message: 'Already handled or expired' });
    return page(res, 'Already handled', `<div class="big">✅</div><h1>Already handled</h1><p class="muted">Someone already approved or denied this chore.</p>${appLink()}`, 409);
  }
  await reviewCompletion({ tokenHash: hashToken(String(req.params.token)) }, action === 'approve', null);
  const who = esc(c.name?.split(' ')[0] ?? 'They');
  if (!wantsHtml) return res.json({ ok: true, status: action === 'approve' ? 'approved' : 'rejected' });
  if (action === 'approve') {
    page(res, 'Approved', `<div class="big">🎉</div><h1>Approved!</h1><p class="muted">${who} gets ${c.points} point${c.points === 1 ? '' : 's'} for “${esc(c.title)}”.</p>${appLink()}`);
  } else {
    page(res, 'Sent back', `<div class="big">↩️</div><h1>Sent back</h1><p class="muted">“${esc(c.title)}” is back on ${who}'s list to finish.</p>${appLink()}`);
  }
});
