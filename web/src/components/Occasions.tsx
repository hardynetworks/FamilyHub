/** Birthdays, anniversaries and other yearly dates; reminder settings; the Home countdown widget. */
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Occasion, api } from '../lib/api';
import { useMe, useMembers, useToast } from '../lib/hooks';
import { Avatar, Empty, Field, Icon, Modal } from './ui';

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

export function useOccasions() {
  return useQuery({ queryKey: ['occasions'], queryFn: () => api<Occasion[]>('/occasions'), staleTime: 5 * 60_000 });
}

export const daysText = (n: number) => (n === 0 ? 'Today!' : n === 1 ? 'Tomorrow' : `in ${n} days`);

/** Settings → Family → Birthdays & dates */
export function OccasionsCard() {
  const list = useOccasions();
  const { byId } = useMembers();
  const [editing, setEditing] = useState<Occasion | 'new' | null>(null);
  return (
    <section className="card">
      <div className="card-head-row">
        <h2>Birthdays &amp; anniversaries</h2>
        <button className="btn btn-sm btn-primary" onClick={() => setEditing('new')}>
          <Icon name="plus" size={14} /> Add
        </button>
      </div>
      <p className="muted small">
        They show on the calendar every year and in the Home <strong>Countdowns</strong> widget. The grown-ups get a reminder a few days before and on the day (the
        birthday person doesn't get the early one, so surprises stay surprises).
      </p>
      {list.data && list.data.length === 0 && <Empty icon="🎂" title="No dates yet">Add birthdays for the family, grandparents and friends.</Empty>}
      <div className="occasion-list">
        {list.data?.map((o) => (
          <button key={o.id} className="occasion-row" onClick={() => setEditing(o)}>
            <span className="occasion-emoji">{o.emoji}</span>
            <span className="grow">
              <span className="occasion-title">{o.label}</span>
              <span className="muted small">
                {MONTHS[o.month - 1]} {o.day}
                {o.yearsLabel ? ` · ${o.yearsLabel}` : ''} · {daysText(o.daysUntil)}
              </span>
            </span>
            {o.memberId && <Avatar member={byId.get(o.memberId)} size={26} />}
            <Icon name="edit" size={16} />
          </button>
        ))}
      </div>
      {editing && <OccasionModal occasion={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
    </section>
  );
}

function OccasionModal({ occasion, onClose }: { occasion: Occasion | null; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const { members } = useMembers();
  const [kind, setKind] = useState<Occasion['kind']>(occasion?.kind ?? 'birthday');
  const [title, setTitle] = useState(occasion?.title ?? '');
  const [month, setMonth] = useState(occasion?.month ?? new Date().getMonth() + 1);
  const [day, setDay] = useState(occasion?.day ?? new Date().getDate());
  const [year, setYear] = useState(occasion?.year ? String(occasion.year) : '');
  const [memberId, setMemberId] = useState(occasion?.memberId ?? '');
  const [emoji, setEmoji] = useState(occasion?.customEmoji ?? '');
  const [remindDays, setRemindDays] = useState(occasion?.remindDays ?? 3);
  const [busy, setBusy] = useState(false);

  const pickMember = (id: string) => {
    setMemberId(id);
    const m = members.find((x) => x.id === id);
    if (m && !title.trim()) setTitle(m.name.split(' ')[0]);
  };
  const done = () => {
    qc.invalidateQueries({ queryKey: ['occasions'] });
    qc.invalidateQueries({ queryKey: ['events'] });
    onClose();
  };
  const save = async () => {
    setBusy(true);
    try {
      const body = { title: title.trim(), kind, month, day, year: year ? Number(year) : null, memberId: memberId || null, emoji: emoji || null, remindDays };
      if (occasion) await api(`/occasions/${occasion.id}`, 'PUT', body);
      else await api('/occasions', 'POST', body);
      done();
    } catch (e: any) {
      toast(e.message, 'error');
      setBusy(false);
    }
  };
  const remove = async () => {
    if (!occasion || !confirm(`Remove ${occasion.label}?`)) return;
    await api(`/occasions/${occasion.id}`, 'DELETE').catch((e) => toast(e.message, 'error'));
    done();
  };
  const daysInMonth = new Date(2024, month, 0).getDate();
  return (
    <Modal
      title={occasion ? 'Edit date' : 'Add a birthday or date'}
      onClose={onClose}
      footer={
        <>
          {occasion && (
            <button className="btn btn-danger-ghost" onClick={remove}>
              <Icon name="trash" size={16} /> Remove
            </button>
          )}
          <span className="spacer" />
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" onClick={save} disabled={busy || !title.trim()}>
            Save
          </button>
        </>
      }
    >
      <div className="form">
        <div className="seg">
          {(['birthday', 'anniversary', 'other'] as const).map((k) => (
            <button type="button" key={k} className={kind === k ? 'on' : ''} onClick={() => setKind(k)}>
              {k === 'birthday' ? '🎂 Birthday' : k === 'anniversary' ? '💍 Anniversary' : '⭐ Other'}
            </button>
          ))}
        </div>
        {kind !== 'other' && (
          <Field label="Family member (optional)" hint="Links it to someone in the family.">
            <select className="input" value={memberId} onChange={(e) => pickMember(e.target.value)}>
              <option value="">Someone else</option>
              {members.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </select>
          </Field>
        )}
        <Field label={kind === 'birthday' ? 'Whose birthday?' : kind === 'anniversary' ? 'Whose anniversary?' : 'What is it?'}>
          <input
            className="input"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            maxLength={80}
            placeholder={kind === 'birthday' ? 'e.g. Grandma Sue' : kind === 'anniversary' ? 'e.g. Mom & Dad' : 'e.g. Last day of school'}
          />
        </Field>
        <div className="grid-3">
          <Field label="Month">
            <select className="input" value={month} onChange={(e) => setMonth(Number(e.target.value))}>
              {MONTHS.map((m, i) => (
                <option key={m} value={i + 1}>
                  {m}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Day">
            <select className="input" value={Math.min(day, daysInMonth)} onChange={(e) => setDay(Number(e.target.value))}>
              {Array.from({ length: daysInMonth }, (_, i) => (
                <option key={i + 1} value={i + 1}>
                  {i + 1}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Year (optional)">
            <input className="input" inputMode="numeric" value={year} onChange={(e) => setYear(e.target.value.replace(/\D/g, '').slice(0, 4))} placeholder="for the age" />
          </Field>
        </div>
        <div className="grid-2">
          <Field label="Remind the grown-ups">
            <select className="input" value={remindDays} onChange={(e) => setRemindDays(Number(e.target.value))}>
              <option value={0}>Only on the day</option>
              {[1, 2, 3, 5, 7, 14].map((n) => (
                <option key={n} value={n}>
                  {n} day{n === 1 ? '' : 's'} before, and on the day
                </option>
              ))}
            </select>
          </Field>
          <Field label="Emoji (optional)">
            <input className="input" value={emoji} onChange={(e) => setEmoji(e.target.value.slice(0, 8))} placeholder={kind === 'birthday' ? '🎂' : kind === 'anniversary' ? '💍' : '⭐'} />
          </Field>
        </div>
      </div>
    </Modal>
  );
}

/** Home widget: upcoming birthdays and dates as countdowns. */
export function CountdownsWidget({ days }: { days: number }) {
  const list = useOccasions();
  const { byId } = useMembers();
  const items = (list.data ?? []).filter((o) => o.daysUntil <= days);
  return (
    <section className="card widget-fill">
      <div className="card-head">
        <h2>Countdowns</h2>
        <Link to="/calendar" className="link-btn">
          Calendar
        </Link>
      </div>
      <div className="widget-scroll">
        {list.data && items.length === 0 && <Empty icon="🎈" title="Nothing coming up">Add birthdays in Settings → Birthdays &amp; dates.</Empty>}
        {items.map((o) => (
          <div key={o.id} className={`countdown-row ${o.daysUntil === 0 ? 'is-today' : ''}`}>
            <span className="countdown-emoji">{o.emoji}</span>
            <span className="grow">
              <span className="countdown-title">{o.label}</span>
              {o.yearsLabel && <span className="muted small"> · {o.yearsLabel}</span>}
            </span>
            {o.memberId && <Avatar member={byId.get(o.memberId)} size={24} />}
            <span className="countdown-days">{o.daysUntil === 0 ? '🎉 Today' : o.daysUntil === 1 ? 'Tomorrow' : `${o.daysUntil} days`}</span>
          </div>
        ))}
      </div>
    </section>
  );
}

/** Settings → Screen & alerts → Reminders */
export function RemindersPrefsCard() {
  const me = useMe();
  const qc = useQueryClient();
  const toast = useToast();
  const isAdmin = me.role === 'admin';
  const time = useQuery({ queryKey: ['reminder-time'], queryFn: () => api<{ time: string }>('/admin/reminders'), enabled: isAdmin });
  const [t, setT] = useState<string | null>(null);
  const setPref = async (key: 'remindPush' | 'remindEmail', value: boolean) => {
    try {
      await api(`/members/${me.id}`, 'PATCH', { prefs: { [key]: value } });
      await qc.invalidateQueries({ queryKey: ['auth'] });
    } catch (e: any) {
      toast(e.message, 'error');
    }
  };
  const saveTime = async () => {
    try {
      await api('/admin/reminders', 'PUT', { time: t ?? '' });
      toast('Reminder time saved', 'success');
      setT(null);
      qc.invalidateQueries({ queryKey: ['reminder-time'] });
    } catch (e: any) {
      toast(e.message, 'error');
    }
  };
  return (
    <section className="card">
      <h2>Reminders</h2>
      <p className="muted small">
        Reminders for your events (set one when you add an event), to-dos due today, and birthdays and anniversaries.
      </p>
      <label className="check-row">
        <input type="checkbox" checked={me.prefs.remindPush} onChange={(e) => setPref('remindPush', e.target.checked)} />
        <span>On my phone (the FamilyHub Android app)</span>
      </label>
      <label className="check-row">
        <input type="checkbox" checked={me.prefs.remindEmail} onChange={(e) => setPref('remindEmail', e.target.checked)} disabled={!me.email} />
        <span>By email{me.email ? ` (${me.email})` : ' — add an email address to your profile first'}</span>
      </label>
      {isAdmin && (
        <div className="row-wrap" style={{ marginTop: 10, alignItems: 'flex-end' }}>
          <Field label="Morning reminder time (to-dos and birthdays, whole family)">
            <input className="input" type="time" value={t ?? time.data?.time ?? ''} onChange={(e) => setT(e.target.value)} />
          </Field>
          {t !== null && (
            <button className="btn btn-sm" onClick={saveTime}>
              Save
            </button>
          )}
        </div>
      )}
    </section>
  );
}
