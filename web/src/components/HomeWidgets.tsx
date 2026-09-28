import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { CalEvent, Chore, List, ListItem, Meal, api, qs } from '../lib/api';
import { addDays, addDaysYmd, fmt, fmtDayLong, fmtTime, relativeDayLabel, startOfDay, today, ymd } from '../lib/dates';
import { useAction, useAuthStatus, useMe, useMembers } from '../lib/hooks';
import { Widget, optionValue } from '../lib/layout';
import { eventColor } from '../pages/CalendarPage';
import { CamerasCard } from './Cameras';
import { EventModal } from './EventModal';
import { Avatar, Empty, Icon } from './ui';
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
      return <WeatherCard days={Number(optionValue(widget, 'days'))} fill />;
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
  const { members } = useMembers();
  const t = today();
  const hideDone = optionValue(widget, 'hideDone') === true;
  const chores = useQuery({ queryKey: ['chores', 'day', t], queryFn: () => api<{ chores: Chore[] }>(`/chores/day${qs({ date: t })}`) });
  const toggle = useAction((c: Chore) => api(`/chores/${c.id}/toggle`, 'POST', { date: t, done: !c.done }), [['chores']]);
  const list = (chores.data?.chores ?? []).filter((c) => !hideDone || !c.done);
  const groups = [...members.map((m) => ({ member: m, items: list.filter((c) => c.assigneeId === m.id) })), { member: null, items: list.filter((c) => !c.assigneeId) }].filter(
    (g) => g.items.length,
  );
  return (
    <section className="card widget-fill">
      <div className="card-head">
        <h2>Today's chores</h2>
        <Link to="/chores" className="link-btn">
          All chores
        </Link>
      </div>
      <div className="widget-scroll">
        {list.length === 0 && !chores.isLoading && <Empty icon="🎉" title={hideDone ? 'All done for today' : 'No chores today'} />}
        {groups.map((g) => (
          <div key={g.member?.id ?? 'none'} className="chore-group">
            <div className="chore-group-head">
              <Avatar member={g.member} size={24} /> {g.member?.name ?? 'Anyone'}
            </div>
            {g.items.map((c) => (
              <label key={c.id} className={`check-row ${c.done ? 'is-done' : ''}`}>
                <input type="checkbox" checked={!!c.done} onChange={() => toggle.mutate(c)} />
                <span>
                  {c.emoji} {c.title}
                </span>
                <span className="pts">+{c.points}</span>
              </label>
            ))}
          </div>
        ))}
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
  const list = (wanted && lists.data?.find((l) => l.id === wanted)) || lists.data?.find((l) => l.kind === 'shopping');
  const items = useQuery({ queryKey: ['items', list?.id], queryFn: () => api<ListItem[]>(`/lists/${list!.id}/items`), enabled: !!list });
  const toggle = useAction((i: ListItem) => api(`/items/${i.id}`, 'PATCH', { checked: !i.checked }), [['items'], ['lists']]);
  const open = (items.data ?? []).filter((i) => !i.checked);
  return (
    <section className="card widget-fill">
      <div className="card-head">
        <h2>
          <Icon name="cart" size={18} /> {list?.name ?? 'Shopping'} <span className="badge">{open.length}</span>
        </h2>
        {list && (
          <Link to={`/lists/${list.id}`} className="link-btn">
            Open list
          </Link>
        )}
      </div>
      <div className="widget-scroll">
        {open.length === 0 && <Empty icon="🛒" title="The list is empty" />}
        {open.slice(0, max).map((i) => (
          <label key={i.id} className="check-row">
            <input type="checkbox" checked={i.checked} onChange={() => toggle.mutate(i)} />
            <span>{i.text}</span>
          </label>
        ))}
        {open.length > max && <div className="muted small">+ {open.length - max} more</div>}
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
        <h2>To-dos</h2>
        <Link to="/lists" className="link-btn">
          Lists
        </Link>
      </div>
      <div className="widget-scroll">
        {(todos.data ?? []).length === 0 && !todos.isLoading && <Empty icon="✨" title="Nothing to do" />}
        {(todos.data ?? []).map((i) => (
          <label key={i.id} className="check-row">
            <input type="checkbox" checked={i.checked} onChange={() => toggle.mutate(i)} />
            <span>{i.text}</span>
            {i.dueDate && <span className={`due ${i.dueDate < t ? 'overdue' : ''}`}>{relativeDayLabel(i.dueDate)}</span>}
            {i.assigneeId && <Avatar member={byId.get(i.assigneeId)} size={20} />}
          </label>
        ))}
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
