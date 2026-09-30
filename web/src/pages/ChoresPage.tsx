import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Avatar, Empty, Field, Icon, Modal } from '../components/ui';
import { Chore, ChoreApproval, Member, api, qs } from '../lib/api';
import { WEEKDAYS, addDaysYmd, fmtDayLong, fmtTime, parseYmd, relativeDayLabel, startOfWeek, today, ymd } from '../lib/dates';
import { useAction, useAuthStatus, useMe, useMembers } from '../lib/hooks';

export function ChoresPage() {
  const { members, byId } = useMembers();
  const [date, setDate] = useState(today());
  const [manage, setManage] = useState(false);
  const day = useQuery({ queryKey: ['chores', 'day', date], queryFn: () => api<{ chores: Chore[] }>(`/chores/day${qs({ date })}`) });
  const weekStart = ymd(startOfWeek(parseYmd(date)));
  const weekEnd = addDaysYmd(weekStart, 6);
  const board = useQuery({
    queryKey: ['chores', 'leaderboard', weekStart],
    queryFn: () => api<{ memberId: string; points: number; count: number }[]>(`/chores/leaderboard${qs({ start: weekStart, end: weekEnd })}`),
  });
  const toggle = useAction((c: Chore) => api(`/chores/${c.id}/toggle`, 'POST', { date, done: !c.done }), [['chores']]);

  const chores = day.data?.chores ?? [];
  const groups: { member: Member | null; items: Chore[] }[] = [
    ...members.map((m) => ({ member: m, items: chores.filter((c) => c.assigneeId === m.id) })),
    { member: null, items: chores.filter((c) => !c.assigneeId) },
  ].filter((g) => g.items.length);
  const maxPts = Math.max(1, ...(board.data ?? []).map((b) => b.points));

  return (
    <div className="page">
      <header className="page-head">
        <h1>Chores</h1>
        <div className="date-nav">
          <button className="icon-btn" onClick={() => setDate(addDaysYmd(date, -1))} aria-label="Previous day"><Icon name="left" /></button>
          <button className="btn btn-sm" onClick={() => setDate(today())}>{relativeDayLabel(date)}</button>
          <button className="icon-btn" onClick={() => setDate(addDaysYmd(date, 1))} aria-label="Next day"><Icon name="right" /></button>
        </div>
        <button className="btn" onClick={() => setManage(true)}>
          <Icon name="edit" size={16} /> Manage chores
        </button>
      </header>
      <p className="muted">{fmtDayLong(date)}</p>
      <ApprovalsCard />

      <div className="chores-layout">
        <div className="chore-columns">
          {groups.length === 0 && !day.isLoading && (
            <Empty icon="🧹" title="No chores for this day">
              Use “Manage chores” to set up daily or weekly jobs for everyone.
            </Empty>
          )}
          {groups.map((g) => {
            const doneCount = g.items.filter((c) => c.done).length;
            return (
              <section key={g.member?.id ?? 'none'} className="card chore-card" style={{ borderTopColor: g.member?.color ?? 'var(--line)' }}>
                <div className="chore-card-head">
                  <Avatar member={g.member} size={36} />
                  <div>
                    <div className="chore-card-name">{g.member?.name ?? 'Anyone'}</div>
                    <div className="muted small">{doneCount}/{g.items.length} done</div>
                  </div>
                </div>
                <div className="progress"><div style={{ width: `${(doneCount / g.items.length) * 100}%`, background: g.member?.color }} /></div>
                {g.items.map((c) => (
                  <button
                    key={c.id}
                    className={`chore-tile ${c.status === 'approved' ? 'is-done' : ''} ${c.status === 'pending' ? 'is-pending' : ''}`}
                    onClick={() => toggle.mutate(c)}
                    title={c.status === 'pending' ? 'Waiting for a parent to approve. Tap to undo.' : undefined}
                  >
                    <span className="chore-emoji">{c.emoji || '✔️'}</span>
                    <span className="chore-title">
                      {c.title}
                      {c.status === 'pending' && <span className="chore-state">⏳ Waiting for OK</span>}
                      {c.status === 'rejected' && <span className="chore-state is-back">↩️ Sent back, try again</span>}
                    </span>
                    <span className="pts">+{c.points}</span>
                    <span className="chore-check">{c.status === 'approved' ? <Icon name="check" size={16} /> : c.status === 'pending' ? '⏳' : null}</span>
                  </button>
                ))}
              </section>
            );
          })}
        </div>

        <aside className="card leaderboard">
          <h2>This week ⭐</h2>
          {(board.data ?? []).length === 0 && <p className="muted small">No points yet this week.</p>}
          {(board.data ?? []).map((b, i) => {
            const m = byId.get(b.memberId);
            return (
              <div key={b.memberId} className="lb-row">
                <span className="lb-rank">{['🥇', '🥈', '🥉'][i] ?? i + 1}</span>
                <Avatar member={m} size={26} />
                <div className="lb-body">
                  <div className="row">
                    <span>{m?.name ?? 'Someone'}</span>
                    <span className="spacer" />
                    <strong>{b.points}</strong>
                  </div>
                  <div className="progress"><div style={{ width: `${(b.points / maxPts) * 100}%`, background: m?.color }} /></div>
                </div>
              </div>
            );
          })}
        </aside>
      </div>
      {manage && <ManageChores onClose={() => setManage(false)} />}
    </div>
  );
}

function ManageChores({ onClose }: { onClose: () => void }) {
  const { byId } = useMembers();
  const all = useQuery({ queryKey: ['chores', 'all'], queryFn: () => api<Chore[]>('/chores') });
  const [editing, setEditing] = useState<Chore | 'new' | null>(null);
  const describe = (c: Chore) =>
    c.frequency === 'daily' ? 'Every day' : c.frequency === 'weekly' ? c.daysOfWeek.map((d) => WEEKDAYS[d]).join(', ') : c.dueDate ? `Once, ${relativeDayLabel(c.dueDate)}` : 'Once';
  if (editing) return <ChoreForm chore={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />;
  return (
    <Modal
      title="Manage chores"
      onClose={onClose}
      wide
      footer={
        <>
          <span className="spacer" />
          <button className="btn btn-primary" onClick={() => setEditing('new')}>
            <Icon name="plus" size={16} /> Add chore
          </button>
        </>
      }
    >
      {(all.data ?? []).length === 0 && <Empty icon="🧹" title="No chores yet" />}
      <ul className="manage-list">
        {(all.data ?? []).map((c) => (
          <li key={c.id} className={c.active ? '' : 'is-inactive'}>
            <button className="manage-row" onClick={() => setEditing(c)}>
              <span className="chore-emoji">{c.emoji || '✔️'}</span>
              <span className="grow">
                <div>{c.title}</div>
                <div className="muted small">
                  {describe(c)} · {c.points} pt{c.points === 1 ? '' : 's'} {c.active ? '' : '· paused'}
                </div>
              </span>
              <Avatar member={c.assigneeId ? byId.get(c.assigneeId) : null} size={26} />
            </button>
          </li>
        ))}
      </ul>
    </Modal>
  );
}

function ChoreForm({ chore, onClose }: { chore: Chore | null; onClose: () => void }) {
  const { members } = useMembers();
  const [title, setTitle] = useState(chore?.title ?? '');
  const [emoji, setEmoji] = useState(chore?.emoji ?? '🧹');
  const [assigneeId, setAssigneeId] = useState(chore?.assigneeId ?? '');
  const [points, setPoints] = useState(chore?.points ?? 1);
  const [frequency, setFrequency] = useState<Chore['frequency']>(chore?.frequency ?? 'daily');
  const [days, setDays] = useState<number[]>(chore?.daysOfWeek ?? [new Date().getDay()]);
  const [dueDate, setDueDate] = useState(chore?.dueDate ?? today());
  const [active, setActive] = useState(chore?.active ?? true);
  const body = () => ({ title, emoji: emoji || null, assigneeId: assigneeId || null, points, frequency, daysOfWeek: frequency === 'weekly' ? days : [], dueDate: frequency === 'once' ? dueDate : null, active });
  const save = useAction(() => (chore ? api(`/chores/${chore.id}`, 'PUT', body()) : api('/chores', 'POST', body())), [['chores']], onClose);
  const del = useAction(() => api(`/chores/${chore!.id}`, 'DELETE'), [['chores']], onClose);
  return (
    <Modal
      title={chore ? 'Edit chore' : 'New chore'}
      onClose={onClose}
      footer={
        <>
          {chore && (
            <button className="btn btn-danger-ghost" onClick={() => confirm('Delete this chore and its history?') && del.mutate()}>
              <Icon name="trash" size={16} /> Delete
            </button>
          )}
          <span className="spacer" />
          <button className="btn" onClick={onClose}>Back</button>
          <button className="btn btn-primary" disabled={!title.trim() || save.isPending} onClick={() => save.mutate()}>Save</button>
        </>
      }
    >
      <div className="form">
        <div className="grid-2 grid-emoji">
          <Field label="Icon">
            <input className="input emoji-input" value={emoji} onChange={(e) => setEmoji(e.target.value)} maxLength={4} />
          </Field>
          <Field label="Chore">
            <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Feed the dog" />
          </Field>
        </div>
        <div className="grid-2">
          <Field label="Who">
            <select className="input" value={assigneeId} onChange={(e) => setAssigneeId(e.target.value)}>
              <option value="">Anyone</option>
              {members.map((m) => (
                <option key={m.id} value={m.id}>{m.name}</option>
              ))}
            </select>
          </Field>
          <Field label="Points">
            <input className="input" type="number" min={0} max={1000} value={points} onChange={(e) => setPoints(Number(e.target.value))} />
          </Field>
        </div>
        <Field label="How often">
          <div className="seg">
            {(['daily', 'weekly', 'once'] as const).map((f) => (
              <button type="button" key={f} className={frequency === f ? 'on' : ''} onClick={() => setFrequency(f)}>
                {f === 'daily' ? 'Every day' : f === 'weekly' ? 'Some days' : 'One time'}
              </button>
            ))}
          </div>
        </Field>
        {frequency === 'weekly' && (
          <div className="chip-row">
            {WEEKDAYS.map((d, i) => (
              <button
                type="button"
                key={d}
                className={`chip ${days.includes(i) ? 'chip-on chip-accent' : ''}`}
                onClick={() => setDays((ds) => (ds.includes(i) ? ds.filter((x) => x !== i) : [...ds, i].sort()))}
              >
                {d}
              </button>
            ))}
          </div>
        )}
        {frequency === 'once' && (
          <Field label="Due">
            <input className="input" type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
          </Field>
        )}
        <label className="toggle">
          <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} /> Active
        </label>
      </div>
    </Modal>
  );
}

/** Chores the kids marked done that are waiting for a parent. Parents can approve here; kids see what's waiting. */
function ApprovalsCard() {
  const me = useMe();
  const status = useAuthStatus().data;
  const { byId } = useMembers();
  const canReview = me.role === 'admin' && !status?.device;
  const list = useQuery({ queryKey: ['chores', 'approvals'], queryFn: () => api<ChoreApproval[]>('/chores/approvals'), refetchInterval: 30_000 });
  const review = useAction((v: { id: string; approve: boolean }) => api(`/chores/approvals/${v.id}`, 'POST', { approve: v.approve }), [['chores']]);
  const items = list.data ?? [];
  if (!items.length) return null;
  return (
    <section className="card approvals">
      <div className="card-head">
        <h2>⏳ Waiting for approval <span className="badge">{items.length}</span></h2>
        {!canReview && <span className="muted small">A parent needs to OK these</span>}
      </div>
      <div className="approvals-list">
        {items.map((a) => {
          const who = a.completedBy ? byId.get(a.completedBy) : null;
          return (
            <div key={a.id} className="approval-row">
              <Avatar member={who} size={32} />
              <div className="grow">
                <div className="strong">
                  {a.emoji} {a.title} <span className="pts">+{a.points}</span>
                </div>
                <div className="muted small">
                  {who?.name ?? 'Someone'} · {relativeDayLabel(a.date)} · {fmtTime(a.completedAt)}
                </div>
              </div>
              {canReview && (
                <div className="approval-actions">
                  <button className="btn btn-sm" onClick={() => review.mutate({ id: a.id, approve: false })} title="Send it back to do again">
                    Not yet
                  </button>
                  <button className="btn btn-sm btn-primary" onClick={() => review.mutate({ id: a.id, approve: true })}>
                    <Icon name="check" size={14} /> Approve
                  </button>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}
