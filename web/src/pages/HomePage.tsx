import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { EventModal } from '../components/EventModal';
import { IdleSlideshow, usePhotos } from '../components/Slideshow';
import { WeatherCard, WeatherNow } from '../components/Weather';
import { CamerasCard } from '../components/Cameras';
import { Avatar, Empty, Icon } from '../components/ui';
import { CalEvent, Chore, List, ListItem, Meal, api, qs } from '../lib/api';
import { addDays, addDaysYmd, fmtDayLong, fmtTime, relativeDayLabel, startOfDay, today, ymd } from '../lib/dates';
import { useAction, useMe, useMembers } from '../lib/hooks';
import { eventColor } from './CalendarPage';

function useClock() {
  const [now, setNow] = useState(new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 15_000);
    return () => clearInterval(t);
  }, []);
  return now;
}

function greeting(h: number) {
  if (h < 12) return 'Good morning';
  if (h < 17) return 'Good afternoon';
  return 'Good evening';
}

export function HomePage() {
  const me = useMe();
  const now = useClock();
  const { members, byId } = useMembers();
  const t = today();
  const [editing, setEditing] = useState<CalEvent | null>(null);
  const [slideSignal, setSlideSignal] = useState(0);
  const photoList = usePhotos(me.prefs.slideshowEnabled);
  const canShowPhotos = !!photoList.data?.enabled && (photoList.data?.photos.length ?? 0) > 0;

  const start = startOfDay(now);
  const events = useQuery({
    queryKey: ['events', 'upcoming', t],
    queryFn: () => api<CalEvent[]>(`/events${qs({ start: start.toISOString(), end: addDays(start, 7).toISOString() })}`),
  });
  const chores = useQuery({ queryKey: ['chores', 'day', t], queryFn: () => api<{ chores: Chore[] }>(`/chores/day${qs({ date: t })}`) });
  const meals = useQuery({ queryKey: ['meals', t, t], queryFn: () => api<Meal[]>(`/meals${qs({ start: t, end: t })}`) });
  const lists = useQuery({ queryKey: ['lists'], queryFn: () => api<List[]>('/lists') });
  const shopping = lists.data?.find((l) => l.kind === 'shopping');
  const shopItems = useQuery({
    queryKey: ['items', shopping?.id],
    queryFn: () => api<ListItem[]>(`/lists/${shopping!.id}/items`),
    enabled: !!shopping,
  });
  const todos = useQuery({ queryKey: ['items', 'open-todos'], queryFn: () => api<ListItem[]>('/items/open-todos') });

  const toggleChore = useAction((c: Chore) => api(`/chores/${c.id}/toggle`, 'POST', { date: t, done: !c.done }), [['chores']]);
  const toggleItem = useAction((i: ListItem) => api(`/items/${i.id}`, 'PATCH', { checked: !i.checked }), [['items'], ['lists']]);

  // Group upcoming events by day.
  const byDay = new Map<string, CalEvent[]>();
  for (const e of events.data ?? []) {
    const day = e.allDay ? e.start : ymd(new Date(e.start));
    const key = day < t ? t : day;
    if (key > addDaysYmd(t, 6)) continue;
    if (!byDay.has(key)) byDay.set(key, []);
    byDay.get(key)!.push(e);
  }
  const days = [...byDay.keys()].sort();

  const choreList = chores.data?.chores ?? [];
  const choreGroups = [...members.map((m) => ({ member: m, items: choreList.filter((c) => c.assigneeId === m.id) })), { member: null, items: choreList.filter((c) => !c.assigneeId) }].filter(
    (g) => g.items.length,
  );
  const openShop = (shopItems.data ?? []).filter((i) => !i.checked);

  return (
    <div className="page page-home">
      <header className="hero">
        <div>
          <div className="hero-greeting">{greeting(now.getHours())}, {me.name.split(' ')[0]}</div>
          <div className="hero-date">{fmtDayLong(now)}</div>
        </div>
        <div className="hero-right">
          {canShowPhotos && (
            <button className="btn btn-sm" onClick={() => setSlideSignal(Date.now())} title="Start the photo slideshow">
              <Icon name="image" size={16} /> Photos
            </button>
          )}
          <WeatherNow />
          <div className="hero-time">{fmtTime(now)}</div>
        </div>
      </header>

      <CamerasCard />
      <div className="home-grid">
        <WeatherCard />
        <section className="card home-agenda">
          <div className="card-head">
            <h2>Coming up</h2>
            <Link to="/calendar" className="link-btn">Open calendar</Link>
          </div>
          {days.length === 0 && !events.isLoading && <Empty icon="🌤️" title="Nothing on the calendar this week" />}
          {days.map((d) => (
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
        </section>

        <section className="card">
          <div className="card-head">
            <h2>Today's chores</h2>
            <Link to="/chores" className="link-btn">All chores</Link>
          </div>
          {choreList.length === 0 && !chores.isLoading && <Empty icon="🎉" title="No chores today" />}
          {choreGroups.map((g) => (
            <div key={g.member?.id ?? 'none'} className="chore-group">
              <div className="chore-group-head">
                <Avatar member={g.member} size={24} /> {g.member?.name ?? 'Anyone'}
              </div>
              {g.items.map((c) => (
                <label key={c.id} className={`check-row ${c.done ? 'is-done' : ''}`}>
                  <input type="checkbox" checked={!!c.done} onChange={() => toggleChore.mutate(c)} />
                  <span>{c.emoji} {c.title}</span>
                  <span className="pts">+{c.points}</span>
                </label>
              ))}
            </div>
          ))}
        </section>

        <section className="card">
          <div className="card-head">
            <h2>Today's meals</h2>
            <Link to="/meals" className="link-btn">Meal plan</Link>
          </div>
          {(meals.data ?? []).length === 0 && !meals.isLoading && <Empty icon="🍽️" title="No meals planned today" />}
          {(meals.data ?? []).map((m) => (
            <div key={m.id} className="meal-row">
              <span className="meal-slot">{m.slot}</span>
              <span>{m.recipeTitle ?? m.title}</span>
            </div>
          ))}
        </section>

        <section className="card">
          <div className="card-head">
            <h2>
              <Icon name="cart" size={18} /> {shopping?.name ?? 'Shopping'} <span className="badge">{openShop.length}</span>
            </h2>
            {shopping && <Link to={`/lists/${shopping.id}`} className="link-btn">Open list</Link>}
          </div>
          {openShop.length === 0 && <Empty icon="🛒" title="The list is empty" />}
          {openShop.slice(0, 8).map((i) => (
            <label key={i.id} className="check-row">
              <input type="checkbox" checked={i.checked} onChange={() => toggleItem.mutate(i)} />
              <span>{i.text}</span>
            </label>
          ))}
          {openShop.length > 8 && <div className="muted small">+ {openShop.length - 8} more</div>}
        </section>

        {(todos.data ?? []).length > 0 && (
          <section className="card">
            <div className="card-head">
              <h2>To-dos</h2>
              <Link to="/lists" className="link-btn">Lists</Link>
            </div>
            {(todos.data ?? []).slice(0, 8).map((i) => (
              <label key={i.id} className="check-row">
                <input type="checkbox" checked={i.checked} onChange={() => toggleItem.mutate(i)} />
                <span>{i.text}</span>
                {i.dueDate && <span className={`due ${i.dueDate < t ? 'overdue' : ''}`}>{relativeDayLabel(i.dueDate)}</span>}
                {i.assigneeId && <Avatar member={byId.get(i.assigneeId)} size={20} />}
              </label>
            ))}
          </section>
        )}
      </div>
      {editing && <EventModal event={editing} onClose={() => setEditing(null)} />}
      <IdleSlideshow startSignal={slideSignal} />
    </div>
  );
}
