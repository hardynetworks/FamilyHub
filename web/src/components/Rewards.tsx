/** Reward balances, the rewards list, redeeming (with a parent's OK), bonuses and payouts. */
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Member, Reward, RewardsData, api } from '../lib/api';
import { useMe, useMembers, useToast } from '../lib/hooks';
import { useKiosk } from '../lib/kiosk';
import { Avatar, Empty, Field, Icon, Modal } from './ui';

export function useRewards() {
  return useQuery({ queryKey: ['rewards'], queryFn: () => api<RewardsData>('/rewards'), refetchInterval: 60_000 });
}

export const money = (points: number, ppd: number) => (ppd > 0 ? `$${(points / ppd).toFixed(2)}` : null);

const REWARD_EMOJIS = ['🎮', '📺', '🍦', '🍕', '🎬', '🛝', '🧸', '📚', '🎨', '⚽', '🛏️', '💵', '🎁', '🍪', '🚲', '🏊'];

function useIsParent() {
  const me = useMe();
  const kiosk = useKiosk();
  return me.role === 'admin' && !kiosk.active;
}

export function RewardsSection() {
  const data = useRewards();
  const { byId } = useMembers();
  const isParent = useIsParent();
  const qc = useQueryClient();
  const toast = useToast();
  const [redeem, setRedeem] = useState<Reward | null>(null);
  const [adjust, setAdjust] = useState(false);
  const [manage, setManage] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const d = data.data;
  const ppd = d?.pointsPerDollar ?? 0;

  const review = async (id: string, approve: boolean) => {
    try {
      await api(`/rewards/redemptions/${id}`, 'POST', { approve });
      qc.invalidateQueries({ queryKey: ['rewards'] });
    } catch (e: any) {
      toast(e.message, 'error');
    }
  };

  return (
    <section className="card rewards-card">
      <div className="card-head-row">
        <h2>Rewards 🎁</h2>
        {isParent && (
          <div className="row-wrap">
            <button className="btn btn-sm" onClick={() => setAdjust(true)}>
              <Icon name="plus" size={14} /> Bonus or payout
            </button>
            <button className="btn btn-sm" onClick={() => setManage(true)}>
              <Icon name="edit" size={14} /> Edit rewards
            </button>
          </div>
        )}
      </div>

      <div className="balance-row">
        {(d?.balances ?? []).map((b) => {
          const m = byId.get(b.memberId);
          if (!m) return null;
          return (
            <div key={b.memberId} className="balance-tile" style={{ borderColor: m.color }}>
              <Avatar member={m} size={40} />
              <div className="balance-name">{m.name.split(' ')[0]}</div>
              <div className="balance-points">{b.balance}</div>
              <div className="muted small">
                points{money(b.balance, ppd) ? ` · ${money(b.balance, ppd)}` : ''}
                {b.pending ? ` · ${b.pending} waiting` : ''}
              </div>
            </div>
          );
        })}
        {d && d.balances.length === 0 && <p className="muted small">Points show up here once kids finish chores.</p>}
      </div>

      {(d?.pending ?? []).length > 0 && (
        <div className="reward-pending">
          <h3>Waiting for a parent's OK</h3>
          {d!.pending.map((p) => (
            <div key={p.id} className="reward-pending-row">
              <Avatar member={byId.get(p.memberId)} size={28} />
              <span className="grow">
                <strong>{byId.get(p.memberId)?.name.split(' ')[0] ?? 'Someone'}</strong> wants {p.emoji ? `${p.emoji} ` : ''}
                {p.title} <span className="muted">({p.cost} pts)</span>
              </span>
              {isParent ? (
                <>
                  <button className="btn btn-sm btn-primary" onClick={() => review(p.id, true)}>
                    Approve
                  </button>
                  <button className="btn btn-sm" onClick={() => review(p.id, false)}>
                    Not now
                  </button>
                </>
              ) : (
                <span className="muted small">⏳</span>
              )}
            </div>
          ))}
        </div>
      )}

      <div className="reward-grid">
        {(d?.rewards ?? [])
          .filter((r) => r.active)
          .map((r) => (
            <button key={r.id} className="reward-tile" onClick={() => setRedeem(r)}>
              <span className="reward-emoji">{r.emoji || '🎁'}</span>
              <span className="reward-title">{r.title}</span>
              <span className="reward-cost">
                {r.cost} pts{money(r.cost, ppd) ? <span className="muted"> · {money(r.cost, ppd)}</span> : null}
              </span>
            </button>
          ))}
      </div>
      {d && d.rewards.filter((r) => r.active).length === 0 && (
        <Empty icon="🎁" title="No rewards yet">
          {isParent ? 'Tap “Edit rewards” to add things kids can spend points on.' : 'A parent can add rewards to spend points on.'}
        </Empty>
      )}

      {(d?.history ?? []).length > 0 && (
        <button className="link-btn" onClick={() => setShowHistory((s) => !s)}>
          {showHistory ? 'Hide history' : 'Show history'}
        </button>
      )}
      {showHistory && (
        <div className="reward-history">
          {d!.history.map((h, i) => (
            <div key={i} className="reward-history-row">
              <Avatar member={byId.get(h.memberId)} size={22} />
              <span className="grow">
                {h.kind === 'redeem' ? `${h.emoji ? h.emoji + ' ' : ''}${h.title}` : h.title || (h.kind === 'payout' ? 'Paid out' : 'Bonus')}
                {h.status === 'pending' && <span className="muted"> · waiting</span>}
                {h.status === 'rejected' && <span className="muted"> · not approved</span>}
              </span>
              <span className={h.points >= 0 ? 'pts-plus' : 'pts-minus'}>{h.points > 0 ? `+${h.points}` : h.points}</span>
              <span className="muted small">{new Date(h.at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</span>
            </div>
          ))}
        </div>
      )}

      {redeem && d && <RedeemModal reward={redeem} data={d} onClose={() => setRedeem(null)} />}
      {adjust && d && <AdjustModal data={d} onClose={() => setAdjust(false)} />}
      {manage && d && <ManageRewards data={d} onClose={() => setManage(false)} />}
    </section>
  );
}

function RedeemModal({ reward, data, onClose }: { reward: Reward; data: RewardsData; onClose: () => void }) {
  const { byId } = useMembers();
  const qc = useQueryClient();
  const toast = useToast();
  const isParent = useIsParent();
  const people = data.balances.map((b) => ({ b, m: byId.get(b.memberId) })).filter((x): x is { b: (typeof data.balances)[number]; m: Member } => !!x.m);
  const [who, setWho] = useState<string>(people.length === 1 ? people[0].m.id : '');
  const [busy, setBusy] = useState(false);
  const chosen = people.find((p) => p.m.id === who);
  const short = chosen ? reward.cost - chosen.b.available : 0;
  const go = async () => {
    setBusy(true);
    try {
      const r = await api<{ pending: boolean }>(`/rewards/${reward.id}/redeem`, 'POST', { memberId: who });
      toast(r.pending ? 'Asked a parent! 🙌' : 'Done! Enjoy 🎉', 'success');
      qc.invalidateQueries({ queryKey: ['rewards'] });
      onClose();
    } catch (e: any) {
      toast(e.message, 'error');
      setBusy(false);
    }
  };
  return (
    <Modal
      title={`${reward.emoji || '🎁'} ${reward.title}`}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" onClick={go} disabled={busy || !who || short > 0}>
            {isParent ? 'Use the points' : 'Ask a parent'}
          </button>
        </>
      }
    >
      <p>
        Costs <strong>{reward.cost} points</strong>
        {money(reward.cost, data.pointsPerDollar) ? ` (${money(reward.cost, data.pointsPerDollar)})` : ''}. Who's getting it?
      </p>
      <div className="who-picks">
        {people.map(({ b, m }) => (
          <button key={m.id} className={`who-pick ${who === m.id ? 'on' : ''}`} onClick={() => setWho(m.id)}>
            <Avatar member={m} size={44} />
            <span>{m.name.split(' ')[0]}</span>
            <span className="muted small">{b.available} pts</span>
          </button>
        ))}
      </div>
      {short > 0 && <p className="note">Needs {short} more point{short === 1 ? '' : 's'}. Keep doing chores! 💪</p>}
    </Modal>
  );
}

function AdjustModal({ data, onClose }: { data: RewardsData; onClose: () => void }) {
  const { members, byId } = useMembers();
  const qc = useQueryClient();
  const toast = useToast();
  const kids = members.filter((m) => m.memberType === 'child' || data.balances.some((b) => b.memberId === m.id));
  const [who, setWho] = useState(kids[0]?.id ?? '');
  const [kind, setKind] = useState<'bonus' | 'payout'>('bonus');
  const [amount, setAmount] = useState('');
  const [inDollars, setInDollars] = useState(data.pointsPerDollar > 0);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const bal = data.balances.find((b) => b.memberId === who);
  const go = async () => {
    setBusy(true);
    try {
      const n = Number(amount);
      const body: Record<string, unknown> = { memberId: who, kind, note: note || null };
      if (kind === 'payout' && inDollars) body.dollars = n;
      else body.points = Math.round(n);
      await api('/rewards/adjust', 'POST', body);
      toast(kind === 'bonus' ? 'Bonus added ⭐' : 'Payout recorded', 'success');
      qc.invalidateQueries({ queryKey: ['rewards'] });
      onClose();
    } catch (e: any) {
      toast(e.message, 'error');
      setBusy(false);
    }
  };
  return (
    <Modal
      title="Bonus or payout"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" onClick={go} disabled={busy || !who || !(Number(amount) > 0)}>
            Save
          </button>
        </>
      }
    >
      <div className="form">
        <div className="seg">
          <button type="button" className={kind === 'bonus' ? 'on' : ''} onClick={() => setKind('bonus')}>
            ⭐ Bonus points
          </button>
          <button type="button" className={kind === 'payout' ? 'on' : ''} onClick={() => setKind('payout')}>
            💵 Paid out
          </button>
        </div>
        <Field label="Who">
          <select className="input" value={who} onChange={(e) => setWho(e.target.value)}>
            {kids.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </select>
        </Field>
        {bal && (
          <p className="muted small">
            {byId.get(who)?.name.split(' ')[0]} has {bal.balance} points{money(bal.balance, data.pointsPerDollar) ? ` (${money(bal.balance, data.pointsPerDollar)})` : ''}.
          </p>
        )}
        <div className="grid-2">
          <Field label={kind === 'payout' && inDollars ? 'Amount paid ($)' : 'Points'}>
            <input className="input" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^\d.]/g, ''))} placeholder={kind === 'payout' && inDollars ? '5.00' : '10'} />
          </Field>
          {kind === 'payout' && data.pointsPerDollar > 0 && (
            <label className="check-row" style={{ alignSelf: 'end' }}>
              <input type="checkbox" checked={inDollars} onChange={(e) => setInDollars(e.target.checked)} />
              <span>Enter dollars ({data.pointsPerDollar} pts = $1)</span>
            </label>
          )}
        </div>
        <Field label="Note (optional)">
          <input className="input" value={note} onChange={(e) => setNote(e.target.value)} maxLength={200} placeholder={kind === 'bonus' ? 'e.g. Helped with groceries' : 'e.g. Cash for the movies'} />
        </Field>
      </div>
    </Modal>
  );
}

function ManageRewards({ data, onClose }: { data: RewardsData; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [ppd, setPpd] = useState(String(data.pointsPerDollar));
  const [editing, setEditing] = useState<Reward | 'new' | null>(null);
  const savePpd = async () => {
    try {
      await api('/rewards/settings', 'PUT', { pointsPerDollar: Number(ppd) || 0 });
      qc.invalidateQueries({ queryKey: ['rewards'] });
      toast('Saved', 'success');
    } catch (e: any) {
      toast(e.message, 'error');
    }
  };
  return (
    <Modal title="Rewards" onClose={onClose} footer={<button className="btn" onClick={onClose}>Done</button>}>
      <div className="form">
        <div className="row-wrap" style={{ alignItems: 'flex-end' }}>
          <Field label="Points that make $1" hint="Shows balances in dollars too. 0 = points only.">
            <input className="input" inputMode="numeric" value={ppd} onChange={(e) => setPpd(e.target.value.replace(/[^\d.]/g, ''))} style={{ maxWidth: 120 }} />
          </Field>
          {Number(ppd) !== data.pointsPerDollar && (
            <button className="btn btn-sm" onClick={savePpd}>
              Save
            </button>
          )}
        </div>
        <div className="card-head-row">
          <h3 style={{ margin: 0 }}>Rewards list</h3>
          <button className="btn btn-sm btn-primary" onClick={() => setEditing('new')}>
            <Icon name="plus" size={14} /> Add a reward
          </button>
        </div>
        {data.rewards.map((r) => (
          <button key={r.id} className={`occasion-row ${r.active ? '' : 'is-off'}`} onClick={() => setEditing(r)}>
            <span className="occasion-emoji">{r.emoji || '🎁'}</span>
            <span className="grow">
              <span className="occasion-title">{r.title}</span>
              <span className="muted small">
                {r.cost} points{r.active ? '' : ' · hidden'}
              </span>
            </span>
            <Icon name="edit" size={16} />
          </button>
        ))}
        {data.rewards.length === 0 && <p className="muted small">Ideas: 30 minutes of screen time (20 pts), pick dinner (30), stay up 30 min late (40), $5 (50).</p>}
      </div>
      {editing && <RewardModal reward={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
    </Modal>
  );
}

function RewardModal({ reward, onClose }: { reward: Reward | null; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [title, setTitle] = useState(reward?.title ?? '');
  const [emoji, setEmoji] = useState(reward?.emoji ?? '🎁');
  const [cost, setCost] = useState(String(reward?.cost ?? 20));
  const [active, setActive] = useState(reward?.active ?? true);
  const save = async () => {
    try {
      const body = { title: title.trim(), emoji, cost: Math.max(1, Math.round(Number(cost) || 1)), active };
      if (reward) await api(`/rewards/${reward.id}`, 'PUT', body);
      else await api('/rewards', 'POST', body);
      qc.invalidateQueries({ queryKey: ['rewards'] });
      onClose();
    } catch (e: any) {
      toast(e.message, 'error');
    }
  };
  const remove = async () => {
    if (!reward || !confirm(`Delete “${reward.title}”?`)) return;
    await api(`/rewards/${reward.id}`, 'DELETE').catch((e) => toast(e.message, 'error'));
    qc.invalidateQueries({ queryKey: ['rewards'] });
    onClose();
  };
  return (
    <Modal
      title={reward ? 'Edit reward' : 'New reward'}
      onClose={onClose}
      footer={
        <>
          {reward && (
            <button className="btn btn-danger-ghost" onClick={remove}>
              <Icon name="trash" size={16} /> Delete
            </button>
          )}
          <span className="spacer" />
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" onClick={save} disabled={!title.trim()}>
            Save
          </button>
        </>
      }
    >
      <div className="form">
        <Field label="Reward">
          <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={80} placeholder="e.g. 30 minutes of screen time" />
        </Field>
        <Field label="Costs (points)">
          <input className="input" inputMode="numeric" value={cost} onChange={(e) => setCost(e.target.value.replace(/\D/g, ''))} style={{ maxWidth: 140 }} />
        </Field>
        <Field label="Icon">
          <div className="swatches">
            {REWARD_EMOJIS.map((e) => (
              <button type="button" key={e} className={`emoji-pick ${emoji === e ? 'on' : ''}`} onClick={() => setEmoji(e)}>
                {e}
              </button>
            ))}
          </div>
        </Field>
        <label className="check-row">
          <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} />
          <span>Show it in the rewards list</span>
        </label>
      </div>
    </Modal>
  );
}

/** Home widget: everyone's points at a glance. */
export function RewardsWidget() {
  const data = useRewards();
  const { byId } = useMembers();
  const ppd = data.data?.pointsPerDollar ?? 0;
  return (
    <section className="card widget-fill">
      <div className="card-head">
        <h2>Points 🎁</h2>
        <Link to="/chores" className="link-btn">
          Rewards
        </Link>
      </div>
      <div className="widget-scroll">
        {data.data && data.data.balances.length === 0 && <Empty icon="⭐" title="No points yet" />}
        {data.data?.balances.map((b) => {
          const m = byId.get(b.memberId);
          if (!m) return null;
          return (
            <div key={b.memberId} className="points-row">
              <Avatar member={m} size={30} />
              <span className="grow">{m.name.split(' ')[0]}</span>
              <strong className="points-big">{b.balance}</strong>
              {money(b.balance, ppd) && <span className="muted small">{money(b.balance, ppd)}</span>}
            </div>
          );
        })}
      </div>
    </section>
  );
}
