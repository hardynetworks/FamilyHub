import { useQuery } from '@tanstack/react-query';
import { CSSProperties, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { CalEvent, Chore, List, ListItem, Meal, api, qs } from '../lib/api';
import { addDays, addDaysYmd, fmt, fmtDayLong, fmtTime, relativeDayLabel, startOfDay, today, ymd } from '../lib/dates';
import { useAction, useAuthStatus, useMe, useMembers } from '../lib/hooks';
import { Widget, optionValue } from '../lib/layout';
import { eventColor } from '../pages/CalendarPage';
import { CamerasCard } from './Cameras';
import { EventModal } from './EventModal';
import { Avatar, Empty, Icon, PriorityBadge } from './ui';
import { WeatherCard, WeatherNow } from './Weather';

export function useClock(intervalMs = 15_000) {
  const [now, setNow] = useState(new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}

function greeting(h: number) {
  if (h < 12) return 'Good morning';
  if (h < 17) return 'Good afternoon';
  return 'Good evening';
}

/** Renders one Home widget. `onPhotos` starts the slideshow (header widget). */
export function WidgetView({ widget, onPhotos, canShowPhotos }: { widget: Widget; onPhotos: () => void; canShowPhotos: boolean }) {
  switch (widget.type) {
    case 'header':
      return <HeaderWidget widget={widget} onPhotos={onPhotos} canShowPhotos={canShowPhotos} />;
    case 'clock':
      return <ClockWidget widget={widget} />;
    case 'weather':
      return <WeatherCard days={Number(optionValue(widget, 'days'))} hours={Number(optionValue(widget, 'hours'))} showSun={optionValue(widget, 'sun') !== false} fill />;
    case 'cameras':
      return <CamerasCard fill />;
    case 'agenda':
      return <AgendaWidget widget={widget} />;
    case 'chores':
      return <ChoresWidget widget={widget} />;
    case 'meals':
      return <MealsWidget />;
    case 'shopping':
      return <ShoppingWidget widget={widget} />;
    case 'todos':
      return <TodosWidget />;
    case 'note':
      return <NoteWidget widget={widget} />;
    default:
      return null;
  }
}

function HeaderWidget({ widget, onPhotos, canShowPhotos }: { widget: Widget; onPhotos: () => void; canShowPhotos: boolean }) {
  const me = useMe();
  const family = useAuthStatus().data?.familyName;
  const now = useClock();
  const showGreeting = optionValue(widget, 'greeting') !== false;
  return (
    <header className="hero widget-fill">
      <div>
        {showGreeting && (
          <div className="hero-greeting">
            {greeting(now.getHours())}, {me.name.split(' ')[0]}
          </div>
        )}
        <div className="hero-date">
          {fmtDayLong(now)}
          {family && <span className="hero-family"> · {family}</span>}
        </div>
      </div>
      <div className="hero-right">
        {canShowPhotos && (
          <button className="btn btn-sm" onClick={onPhotos} title="Start the photo slideshow">
            <Icon name="image" size={16} /> Photos
          </button>
        )}
        {optionValue(widget, 'weather') !== false && <WeatherNow />}
        {optionValue(widget, 'clock') !== false && <div className="hero-time">{fmtTime(now)}</div>}
      </div>
    </header>
  );
}

function ClockWidget({ widget }: { widget: Widget }) {
  const seconds = optionValue(widget, 'seconds') === true;
  const now = useClock(seconds ? 1000 : 10_000);
  return (
    <section className="card widget-fill clock-widget">
      <div className="clock-big">{fmt(now, { hour: 'numeric', minute: '2-digit', ...(seconds ? { second: '2-digit' } : {}) })}</div>
      <div className="clock-date">{fmtDayLong(now)}</div>
    </section>
  );
}

function AgendaWidget({ widget }: { widget: Widget }) {
  const { byId } = useMembers();
  const t = today();
  const days = Number(optionValue(widget, 'days')) || 7;
  const [editing, setEditing] = useState<CalEvent | null>(null);
  const start = startOfDay(new Date());
  const events = useQuery({
    queryKey: ['events', 'upcoming', t, days],
    queryFn: () => api<CalEvent[]>(`/events${qs({ start: start.toISOString(), end: addDays(start, days).toISOString() })}`),
  });
  const byDay = new Map<string, CalEvent[]>();
  for (const e of events.data ?? []) {
    const day = e.allDay ? e.start : ymd(new Date(e.start));
    const key = day < t ? t : day;
    if (key > addDaysYmd(t, days - 1)) continue;
    if (!byDay.has(key)) byDay.set(key, []);
    byDay.get(key)!.push(e);
  }
  const keys = [...byDay.keys()].sort();
  return (
    <section className="card widget-fill">
      <div className="card-head">
        <h2>{String(optionValue(widget, 'title') || 'Coming up')}</h2>
        <Link to="/calendar" className="link-btn">
          Open calendar
        </Link>
      </div>
      <div className="widget-scroll">
        {keys.length === 0 && !events.isLoading && <Empty icon="🌤️" title={days === 1 ? 'Nothing on the calendar today' : 'Nothing on the calendar'} />}
        {keys.map((d) => (
          <div key={d} className="agenda-day">
            <div className={`agenda-day-label ${d === t ? 'is-today' : ''}`}>{relativeDayLabel(d)}</div>
            {byDay.get(d)!.map((e) => (
              <button key={e.instanceKey} className="agenda-item" onClick={() => setEditing(e)}>
                <span className="agenda-bar" style={{ background: eventColor(e, byId) }} />
                <span className="agenda-time">{e.allDay ? 'All day' : fmtTime(e.start)}</span>
                <span className="agenda-title">
                  {e.title}
                  {e.location && <span className="agenda-loc"> · {e.location}</span>}
                </span>
                <span className="agenda-avatars">
                  {e.memberIds.slice(0, 3).map((id) => (
                    <Avatar key={id} member={byId.get(id)} size={22} />
                  ))}
                </span>
              </button>
            ))}
          </div>
        ))}
      </div>
      {editing && <EventModal event={editing} onClose={() => setEditing(null)} />}
    </section>
  );
}

function ChoresWidget({ widget }: { widget: Widget }) {
  const { byId } = useMembers();
  const t = today();
  const hideDone = optionValue(widget, 'hideDone') === true;
  const chores = useQuery({ queryKey: ['chores', 'day', t], queryFn: () => api<{ chores: Chore[] }>(`/chores/day${qs({ date: t })}`) });
  const toggle = useAction((c: Chore) => api(`/chores/${c.id}/toggle`, 'POST', { date: t, done: !c.done }), [['chores']]);
  const all = chores.data?.chores ?? [];
  const list = all.filter((c) => !hideDone || !c.done).sort((a, b) => Number(!!a.done) - Number(!!b.done));
  const doneCount = all.filter((c) => c.done).length;
  return (
    <section className="card widget-fill">
      <div className="card-head">
        <h2>
          <Icon name="star" size={18} /> Chores
          {all.length > 0 && (
            <span className="muted small head-count">
              {doneCount}/{all.length} done
            </span>
          )}
        </h2>
        <Link to="/chores" className="icon-btn" title="All chores" aria-label="All chores">
          <Icon name="plus" size={18} />
        </Link>
      </div>
      <div className="widget-scroll">
        {list.length === 0 && !chores.isLoading && <Empty icon="🎉" title={hideDone ? 'All done for today' : 'No chores today'} />}
        {list.map((c) => {
          const who = c.assigneeId ? byId.get(c.assigneeId) : null;
          return (
            <button key={c.id} className={`task-row ${c.status === 'approved' ? 'is-done' : ''}`} onClick={() => toggle.mutate(c)}>
              <span className={`task-check round ${c.status === 'approved' ? 'on' : ''}`} style={who ? ({ '--c': who.color } as CSSProperties) : undefined}>
                {c.status === 'approved' ? <Icon name="check" size={14} /> : c.status === 'pending' ? '⏳' : null}
              </span>
              <span className="task-body">
                <span className="task-title">
                  {c.emoji} {c.title} <span className="pts">+{c.points}</span>
                </span>
                <span className="task-meta">
                  <Avatar member={who} size={16} /> {who?.name ?? 'Anyone'} · {c.frequency === 'daily' ? 'Daily' : c.frequency === 'weekly' ? 'Weekly' : 'Once'}
                  {c.status === 'pending' ? (
                    <span className="waiting">Waiting for OK</span>
                  ) : c.status === 'rejected' ? (
                    <span className="due-today">Sent back</span>
                  ) : (
                    !c.done && <span className="due-today">Due today</span>
                  )}
                </span>
              </span>
            </button>
          );
        })}
      </div>
    </section>
  );
}

function MealsWidget() {
  const t = today();
  const meals = useQuery({ queryKey: ['meals', t, t], queryFn: () => api<Meal[]>(`/meals${qs({ start: t, end: t })}`) });
  return (
    <section className="card widget-fill">
      <div className="card-head">
        <h2>Today's meals</h2>
        <Link to="/meals" className="link-btn">
          Meal plan
        </Link>
      </div>
      <div className="widget-scroll">
        {(meals.data ?? []).length === 0 && !meals.isLoading && <Empty icon="🍽️" title="No meals planned today" />}
        {(meals.data ?? []).map((m) => (
          <div key={m.id} className="meal-row">
            <span className="meal-slot">{m.slot}</span>
            <span>{m.recipeTitle ?? m.title}</span>
          </div>
        ))}
      </div>
    </section>
  );
}

export function useLists() {
  return useQuery({ queryKey: ['lists'], queryFn: () => api<List[]>('/lists') });
}

function ShoppingWidget({ widget }: { widget: Widget }) {
  const lists = useLists();
  const wanted = String(optionValue(widget, 'listId') || '');
  const max = Number(optionValue(widget, 'max')) || 8;
  const [picked, setPicked] = useState('');
  const [text, setText] = useState('');
  const shopping = (lists.data ?? []).filter((l) => l.kind === 'shopping');
  const list = (picked && lists.data?.find((l) => l.id === picked)) || (wanted && lists.data?.find((l) => l.id === wanted)) || shopping[0];
  const items = useQuery({ queryKey: ['items', list?.id], queryFn: () => api<ListItem[]>(`/lists/${list!.id}/items`), enabled: !!list });
  const toggle = useAction((i: ListItem) => api(`/items/${i.id}`, 'PATCH', { checked: !i.checked }), [['items'], ['lists']]);
  const add = useAction((v: string) => api(`/lists/${list!.id}/items`, 'POST', { text: v }), [['items'], ['lists']], () => setText(''));
  const all = items.data ?? [];
  const open = all.filter((i) => !i.checked);
  const done = all.filter((i) => i.checked);
  const shown = [...open.slice(0, max), ...done.slice(0, Math.max(0, max - open.length))];
  return (
    <section className="card widget-fill">
      <div className="card-head">
        <h2>
          <Icon name="cart" size={18} /> Shopping
        </h2>
        {shopping.length > 1 ? (
          <select className="list-pick" value={list?.id ?? ''} onChange={(e) => setPicked(e.target.value)} aria-label="Shopping list">
            {shopping.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </select>
        ) : (
          list && (
            <Link to={`/lists/${list.id}`} className="link-btn">
              {list.name}
            </Link>
          )
        )}
      </div>
      {all.length > 0 && (
        <div className="shop-progress">
          <div className="progress">
            <div style={{ width: `${(done.length / all.length) * 100}%` }} />
          </div>
          <span className="muted small">
            {done.length} of {all.length} checked
          </span>
        </div>
      )}
      {list && (
        <form
          className="quick-add"
          onSubmit={(e) => {
            e.preventDefault();
            if (text.trim()) add.mutate(text.trim());
          }}
        >
          <input className="input" value={text} onChange={(e) => setText(e.target.value)} placeholder={`Add to ${list.name}…`} aria-label={`Add to ${list.name}`} />
          <button className="icon-btn" disabled={!text.trim()} aria-label="Add">
            <Icon name="plus" size={18} />
          </button>
        </form>
      )}
      <div className="widget-scroll">
        {all.length === 0 && !items.isLoading && <Empty icon="🛒" title="The list is empty" />}
        {shown.map((i) => (
          <button key={i.id} className={`task-row ${i.checked ? 'is-done' : ''}`} onClick={() => toggle.mutate(i)}>
            <span className={`task-check ${i.checked ? 'on' : ''}`}>{i.checked && <Icon name="check" size={14} />}</span>
            <span className="task-body">
              <span className="task-title">{i.text}</span>
            </span>
          </button>
        ))}
        {open.length > max && <div className="muted small more-line">+ {open.length - max} more</div>}
      </div>
    </section>
  );
}

function TodosWidget() {
  const { byId } = useMembers();
  const t = today();
  const todos = useQuery({ queryKey: ['items', 'open-todos'], queryFn: () => api<ListItem[]>('/items/open-todos') });
  const toggle = useAction((i: ListItem) => api(`/items/${i.id}`, 'PATCH', { checked: !i.checked }), [['items'], ['lists']]);
  return (
    <section className="card widget-fill">
      <div className="card-head">
        <h2>
          <Icon name="check" size={18} /> Tasks
        </h2>
        <Link to="/lists" className="icon-btn" title="Lists" aria-label="Open lists">
          <Icon name="plus" size={18} />
        </Link>
      </div>
      <div className="widget-scroll">
        {(todos.data ?? []).length === 0 && !todos.isLoading && <Empty icon="✨" title="Nothing to do" />}
        {(todos.data ?? []).map((i) => {
          const who = i.assigneeId ? byId.get(i.assigneeId) : null;
          return (
            <button key={i.id} className="task-row" onClick={() => toggle.mutate(i)}>
              <span className={`task-check prio-box-${i.priority ?? 'none'}`} />
              <span className="task-body">
                <span className="task-title">
                  {i.text} <PriorityBadge priority={i.priority} />
                </span>
                {(who || i.dueDate) && (
                  <span className="task-meta">
                    {who && (
                      <>
                        <Avatar member={who} size={16} /> {who.name}
                      </>
                    )}
                    {i.dueDate && <span className={i.dueDate < t ? 'overdue-text' : i.dueDate === t ? 'due-today' : ''}>{relativeDayLabel(i.dueDate)}</span>}
                  </span>
                )}
              </span>
            </button>
          );
        })}
      </div>
    </section>
  );
}

function NoteWidget({ widget }: { widget: Widget }) {
  const text = String(optionValue(widget, 'text') ?? '');
  const color = String(optionValue(widget, 'color') || 'yellow');
  return (
    <section className={`card widget-fill note-widget note-${color}`}>
      <div className="note-text">{text || 'Empty note'}</div>
    </section>
  );
}
