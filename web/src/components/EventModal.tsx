import { useQuery } from '@tanstack/react-query';
import { FormEvent, useState } from 'react';
import { CalEvent, CalendarTarget, api } from '../lib/api';
import { Repeat, addDaysYmd, buildRrule, hm, parseRrule, parseYmd, ymd } from '../lib/dates';
import { useAction, useAuthStatus, useMe, useMembers } from '../lib/hooks';
import { Field, Icon, MemberPicker, Modal } from './ui';

export interface EventDraft {
  start: Date;
  end: Date;
  allDay: boolean;
}

/** Create/edit an event. Pass `event` to edit, or `draft` to prefill a new one. */
export function EventModal({ event, draft, onClose }: { event?: CalEvent; draft?: EventDraft; onClose: () => void }) {
  const me = useMe();
  const { members } = useMembers();
  const status = useAuthStatus().data;
  const targets = useQuery({ queryKey: ['event-targets'], queryFn: () => api<CalendarTarget[]>('/events/targets'), enabled: !!status?.google.enabled });

  const isLocalSeries = !!event?.rrule && event.source === 'local';
  const initStart = event ? new Date(isLocalSeries ? event.seriesStart : event.start) : draft?.start ?? new Date();
  const initEndRaw = event ? new Date(isLocalSeries ? event.seriesEnd : event.end) : draft?.end ?? new Date(initStart.getTime() + 3600_000);
  const allDayInit = event?.allDay ?? draft?.allDay ?? false;
  // All-day events: API end is exclusive; the form shows an inclusive end date.
  const dateStr = (s: string | Date) => (typeof s === 'string' && s.length === 10 ? s : ymd(new Date(s)));
  const startDateInit = event?.allDay ? dateStr(isLocalSeries ? event.seriesStart : event.start) : ymd(initStart);
  const endDateInit = allDayInit
    ? event
      ? addDaysYmd(dateStr(isLocalSeries ? event.seriesEnd : event.end), -1)
      : addDaysYmd(ymd(initEndRaw), draft && ymd(initEndRaw) > ymd(initStart) ? -1 : 0)
    : ymd(initEndRaw);
  const rr = parseRrule(event?.rrule ?? null);

  const [title, setTitle] = useState(event?.title ?? '');
  const [allDay, setAllDay] = useState(allDayInit);
  const [startDate, setStartDate] = useState(startDateInit);
  const [startTime, setStartTime] = useState(allDayInit ? '09:00' : hm(initStart));
  const [endDate, setEndDate] = useState(endDateInit);
  const [endTime, setEndTime] = useState(allDayInit ? '10:00' : hm(initEndRaw));
  const [repeat, setRepeat] = useState<Repeat>(rr.repeat);
  const [until, setUntil] = useState(rr.until ?? '');
  const [memberIds, setMemberIds] = useState<string[]>(event?.memberIds ?? [me.id]);
  const [location, setLocation] = useState(event?.location ?? '');
  const [description, setDescription] = useState(event?.description ?? '');
  const [calendarId, setCalendarId] = useState<string>(event?.calendarId ?? '');

  const isGoogleInstance = !!event?.isGoogleRecurringInstance;
  const readOnly = event && !event.editable;

  const save = useAction(
    () => {
      let start: string;
      let end: string;
      if (allDay) {
        start = startDate;
        end = addDaysYmd(endDate < startDate ? startDate : endDate, 1);
      } else {
        const s = new Date(`${startDate}T${startTime}`);
        let e = new Date(`${endDate}T${endTime}`);
        if (e <= s) e = new Date(s.getTime() + 3600_000);
        start = s.toISOString();
        end = e.toISOString();
      }
      const body = {
        title,
        description: description || null,
        location: location || null,
        start,
        end,
        allDay,
        rrule: isGoogleInstance ? null : buildRrule(repeat, until || null),
        memberIds,
        calendarId: calendarId || null,
      };
      return event ? api(`/events/${event.id}`, 'PATCH', body) : api('/events', 'POST', body);
    },
    [['events']],
    onClose,
  );
  const del = useAction(() => api(`/events/${event!.id}`, 'DELETE'), [['events']], onClose);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (title.trim()) save.mutate();
  };

  const onStartDate = (v: string) => {
    const diff = (parseYmd(endDate).getTime() - parseYmd(startDate).getTime()) / 86400_000;
    setStartDate(v);
    setEndDate(addDaysYmd(v, Math.max(0, Math.round(diff))));
  };

  return (
    <Modal
      title={event ? (readOnly ? event.title : 'Edit event') : 'New event'}
      onClose={onClose}
      footer={
        readOnly ? (
          <button className="btn" onClick={onClose}>Close</button>
        ) : (
          <>
            {event && (
              <button
                className="btn btn-danger-ghost"
                disabled={del.isPending}
                onClick={() => confirm(isLocalSeries ? 'Delete every occurrence of this event?' : 'Delete this event?') && del.mutate()}
              >
                <Icon name="trash" size={16} /> Delete
              </button>
            )}
            <span className="spacer" />
            <button className="btn" onClick={onClose}>Cancel</button>
            <button className="btn btn-primary" form="event-form" disabled={save.isPending || !title.trim()}>
              {save.isPending ? 'Saving…' : 'Save'}
            </button>
          </>
        )
      }
    >
      <form id="event-form" className="form" onSubmit={submit}>
        {readOnly && <p className="note">This event is on a calendar you can only view ({event?.calendarName}).</p>}
        <fieldset disabled={!!readOnly} className="form">
          <input className="input input-lg" placeholder="What's happening?" value={title} onChange={(e) => setTitle(e.target.value)} required maxLength={500} />

          <label className="toggle">
            <input type="checkbox" checked={allDay} onChange={(e) => setAllDay(e.target.checked)} /> All day
          </label>

          <div className="grid-2">
            <Field label="Starts">
              <div className="row">
                <input className="input" type="date" value={startDate} onChange={(e) => onStartDate(e.target.value)} required />
                {!allDay && <input className="input" type="time" value={startTime} onChange={(e) => setStartTime(e.target.value)} required />}
              </div>
            </Field>
            <Field label="Ends">
              <div className="row">
                <input className="input" type="date" value={endDate} min={startDate} onChange={(e) => setEndDate(e.target.value)} required />
                {!allDay && <input className="input" type="time" value={endTime} onChange={(e) => setEndTime(e.target.value)} required />}
              </div>
            </Field>
          </div>

          {isGoogleInstance ? (
            <p className="note">
              <Icon name="repeat" size={14} /> This is one occurrence of a repeating Google event. Changes here apply to this occurrence only.
            </p>
          ) : (
            <div className="grid-2">
              <Field label="Repeat">
                <select className="input" value={repeat} onChange={(e) => setRepeat(e.target.value as Repeat)}>
                  <option value="none">Does not repeat</option>
                  <option value="daily">Every day</option>
                  <option value="weekly">Every week</option>
                  <option value="biweekly">Every 2 weeks</option>
                  <option value="monthly">Every month</option>
                  <option value="yearly">Every year</option>
                </select>
              </Field>
              {repeat !== 'none' && (
                <Field label="Until (optional)">
                  <input className="input" type="date" value={until} min={startDate} onChange={(e) => setUntil(e.target.value)} />
                </Field>
              )}
            </div>
          )}
          {isLocalSeries && <p className="note">Changes apply to every occurrence in this series.</p>}

          <Field label="Who's it for?">
            <MemberPicker members={members} value={memberIds} onChange={setMemberIds} />
          </Field>

          {status?.google.enabled && (
            <Field label="Calendar" hint={calendarId ? 'Saved to Google Calendar and kept in sync both ways.' : 'Only visible in FamilyHub.'}>
              <select className="input" value={calendarId} onChange={(e) => setCalendarId(e.target.value)} disabled={isGoogleInstance}>
                <option value="">FamilyHub only</option>
                {(targets.data ?? []).map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name} ({t.account})
                  </option>
                ))}
                {event?.calendarId && !targets.data?.some((t) => t.id === event.calendarId) && <option value={event.calendarId}>{event.calendarName}</option>}
              </select>
            </Field>
          )}

          <Field label="Location">
            <input className="input" value={location} onChange={(e) => setLocation(e.target.value)} placeholder="Add a place" />
          </Field>
          <Field label="Notes">
            <textarea className="input" rows={3} value={description} onChange={(e) => setDescription(e.target.value)} />
          </Field>
        </fieldset>
      </form>
    </Modal>
  );
}
