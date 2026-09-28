import type { DayCellContentArg, DayHeaderContentArg, DateSelectArg, EventClickArg, EventDropArg, EventInput, EventSourceFuncArg } from '@fullcalendar/core';
import dayGridPlugin from '@fullcalendar/daygrid';
import interactionPlugin, { EventResizeDoneArg } from '@fullcalendar/interaction';
import listPlugin from '@fullcalendar/list';
import FullCalendar from '@fullcalendar/react';
import timeGridPlugin from '@fullcalendar/timegrid';
import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { EventDraft, EventModal } from '../components/EventModal';
import { Icon } from '../components/ui';
import { describeWeather, useWeather } from '../components/Weather';
import { CalEvent, Member, api, qs } from '../lib/api';
import { addDaysYmd, ymd } from '../lib/dates';
import { useMembers, useToast } from '../lib/hooks';

export function eventColor(e: CalEvent, byId: Map<string, Member>): string {
  return e.color || byId.get(e.memberIds[0])?.color || e.calendarColor || '#8a8f98';
}

export function CalendarPage() {
  const { members, byId } = useMembers();
  const weather = useWeather();
  const forecast = useMemo(() => {
    const m = new Map<string, { code: number; max: number; min: number; rain: number | null }>();
    for (const d of weather.data?.enabled ? weather.data.daily ?? [] : []) m.set(d.date, { code: d.code, max: d.max, min: d.min, rain: d.precipChance });
    return m;
  }, [weather.data]);

  const wxChip = (date: Date, compact: boolean) => {
    const f = forecast.get(ymd(date));
    if (!f) return null;
    const d = describeWeather(f.code);
    const tip = `${d.label} · high ${Math.round(f.max)}° / low ${Math.round(f.min)}°${f.rain !== null && f.rain >= 20 ? ` · ${f.rain}% chance of rain` : ''}`;
    return (
      <span className={`fc-wx ${compact ? 'compact' : ''}`} title={tip} aria-label={tip}>
        <span className="fc-wx-icon">{d.icon}</span>
        <span className="fc-wx-hi">{Math.round(f.max)}°</span>
        {!compact && <span className="fc-wx-lo">{Math.round(f.min)}°</span>}
      </span>
    );
  };
  const qc = useQueryClient();
  const toast = useToast();
  const calRef = useRef<FullCalendar>(null);
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [editing, setEditing] = useState<CalEvent | null>(null);
  const [draft, setDraft] = useState<EventDraft | null>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const [narrow, setNarrow] = useState(() => window.innerWidth < 720);
  const [height, setHeight] = useState(600);

  // Size the calendar to fill the space left in the window, and keep it in sync as the window,
  // the page header (member chips wrap) or the mobile tab bar change.
  const measure = useCallback(() => {
    const card = cardRef.current;
    if (!card) return;
    // The main area's bottom padding already makes room for the phone tab bar.
    const main = card.closest('.main') as HTMLElement | null;
    const mainPad = main ? parseFloat(getComputedStyle(main).paddingBottom) || 0 : 0;
    const top = card.getBoundingClientRect().top + window.scrollY;
    const cardChrome = card.offsetHeight - card.clientHeight + 28; // borders + 14px padding top and bottom
    const available = window.innerHeight - top - mainPad - cardChrome;
    setHeight(Math.max(narrow ? 460 : 520, Math.floor(available)));
    setNarrow(window.innerWidth < 720);
  }, [narrow]);

  useLayoutEffect(() => {
    measure();
    let frame = 0;
    const onResize = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(measure);
    };
    window.addEventListener('resize', onResize);
    window.addEventListener('orientationchange', onResize);
    const ro = new ResizeObserver(onResize);
    const header = cardRef.current?.previousElementSibling;
    if (header) ro.observe(header);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('resize', onResize);
      window.removeEventListener('orientationchange', onResize);
      ro.disconnect();
    };
  }, [measure]);

  // Switch between the phone layout (agenda) and the desktop layout (month) when crossing the breakpoint.
  const firstRender = useRef(true);
  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    const cal = calRef.current?.getApi();
    if (!cal) return;
    const view = cal.view.type;
    if (narrow && (view === 'timeGridWeek' || view === 'dayGridMonth')) cal.changeView('listWeek');
    if (!narrow && view === 'listWeek') cal.changeView('dayGridMonth');
  }, [narrow]);

  // Poll so the wall display stays fresh.
  useEffect(() => {
    const t = setInterval(() => calRef.current?.getApi().refetchEvents(), 60_000);
    return () => clearInterval(t);
  }, []);

  const refetch = () => {
    qc.invalidateQueries({ queryKey: ['events'] });
    calRef.current?.getApi().refetchEvents();
  };

  const fetchEvents = useMemo(
    () => async (info: EventSourceFuncArg): Promise<EventInput[]> => {
      const evs = await api<CalEvent[]>(`/events${qs({ start: info.start.toISOString(), end: info.end.toISOString() })}`);
      return evs
        .filter((e) => !e.memberIds.length || e.memberIds.some((id) => !hidden.has(id)))
        .map((e) => {
          const color = eventColor(e, byId);
          return {
            id: e.instanceKey,
            title: e.title,
            start: e.start,
            end: e.end,
            allDay: e.allDay,
            backgroundColor: color,
            borderColor: color,
            editable: e.editable && !e.rrule,
            extendedProps: { dto: e },
          };
        });
    },
    [hidden, byId],
  );

  const persistMove = async (arg: EventDropArg | EventResizeDoneArg) => {
    const dto: CalEvent = arg.event.extendedProps.dto;
    const ev = arg.event;
    const allDay = ev.allDay;
    const start = allDay ? ymd(ev.start!) : ev.start!.toISOString();
    const end = ev.end ? (allDay ? ymd(ev.end) : ev.end.toISOString()) : allDay ? addDaysYmd(ymd(ev.start!), 1) : new Date(ev.start!.getTime() + 3600_000).toISOString();
    try {
      await api(`/events/${dto.id}`, 'PATCH', {
        title: dto.title,
        description: dto.description,
        location: dto.location,
        start,
        end,
        allDay,
        rrule: null,
        memberIds: dto.memberIds,
        color: dto.color,
        calendarId: dto.calendarId,
      });
      refetch();
    } catch (e: any) {
      arg.revert();
      toast(e.message, 'error');
    }
  };

  const toggleMember = (id: string) =>
    setHidden((h) => {
      const n = new Set(h);
      n.has(id) ? n.delete(id) : n.add(id);
      return n;
    });

  return (
    <div className="page page-calendar">
      <header className="page-head">
        <h1>Calendar</h1>
        <div className="chip-row">
          {members.map((m) => (
            <button
              key={m.id}
              className={`chip ${hidden.has(m.id) ? '' : 'chip-on'}`}
              style={hidden.has(m.id) ? { borderColor: m.color } : { background: m.color, borderColor: m.color, color: '#fff' }}
              onClick={() => toggleMember(m.id)}
              title={hidden.has(m.id) ? `Show ${m.name}` : `Hide ${m.name}`}
            >
              {m.avatar} {m.name}
            </button>
          ))}
        </div>
        <button
          className="btn btn-primary"
          onClick={() => {
            const s = new Date();
            s.setMinutes(0, 0, 0);
            s.setHours(s.getHours() + 1);
            setDraft({ start: s, end: new Date(s.getTime() + 3600_000), allDay: false });
          }}
        >
          <Icon name="plus" size={18} /> New event
        </button>
      </header>
      <div className="card cal-card" ref={cardRef}>
        <FullCalendar
          ref={calRef}
          plugins={[dayGridPlugin, timeGridPlugin, listPlugin, interactionPlugin]}
          initialView={narrow ? 'listWeek' : 'dayGridMonth'}
          headerToolbar={narrow ? { left: 'prev,next', center: 'title', right: 'listWeek,dayGridMonth' } : { left: 'prev,next today', center: 'title', right: 'dayGridMonth,timeGridWeek,timeGridDay,listWeek' }}
          buttonText={{ today: 'Today', month: 'Month', week: 'Week', day: 'Day', list: 'Agenda' }}
          height={height}
          expandRows
          nowIndicator
          selectable
          selectMirror
          dayMaxEvents
          dayCellContent={(arg: DayCellContentArg) => (
            <span className="fc-daycell-top">
              {!arg.isOther && wxChip(arg.date, true)}
              <span className="fc-daycell-num">{arg.dayNumberText}</span>
            </span>
          )}
          dayHeaderContent={(arg: DayHeaderContentArg) =>
            arg.view.type === 'dayGridMonth' ? (
              arg.text
            ) : (
              <span className="fc-dayhead">
                <span>{arg.text}</span>
                {wxChip(arg.date, false)}
              </span>
            )
          }
          events={fetchEvents}
          select={(a: DateSelectArg) => {
            setDraft({ start: a.start, end: a.end, allDay: a.allDay });
            a.view.calendar.unselect();
          }}
          eventClick={(a: EventClickArg) => setEditing(a.event.extendedProps.dto)}
          eventDrop={persistMove}
          eventResize={persistMove}
          eventTimeFormat={{ hour: 'numeric', minute: '2-digit', meridiem: 'short' }}
        />
      </div>
      {(editing || draft) && (
        <EventModal
          event={editing ?? undefined}
          draft={draft ?? undefined}
          onClose={() => {
            setEditing(null);
            setDraft(null);
            refetch();
          }}
        />
      )}
    </div>
  );
}
