import { useQuery } from '@tanstack/react-query';
import { FormEvent, useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Avatar, Empty, Field, Icon, Modal, PriorityBadge } from '../components/ui';
import { List, ListItem, Priority, api } from '../lib/api';
import { relativeDayLabel, today } from '../lib/dates';
import { useAction, useMembers } from '../lib/hooks';

export function ListsPage() {
  const { listId } = useParams();
  const nav = useNavigate();
  const lists = useQuery({ queryKey: ['lists'], queryFn: () => api<List[]>('/lists') });
  const [editingList, setEditingList] = useState<List | 'new' | null>(null);
  const active = lists.data?.find((l) => l.id === listId) ?? lists.data?.[0];

  return (
    <div className="page page-lists">
      <header className="page-head">
        <h1>Lists</h1>
        <button className="btn" onClick={() => setEditingList('new')}>
          <Icon name="plus" size={18} /> New list
        </button>
      </header>
      <div className="lists-layout">
        <nav className="lists-nav">
          {(lists.data ?? []).map((l) => (
            <button key={l.id} className={`lists-nav-item ${active?.id === l.id ? 'active' : ''}`} onClick={() => nav(`/lists/${l.id}`)}>
              <span className="lists-emoji">{l.emoji ?? (l.kind === 'shopping' ? '🛒' : '📝')}</span>
              <span className="lists-name">{l.name}</span>
              {l.openCount > 0 && <span className="badge">{l.openCount}</span>}
            </button>
          ))}
        </nav>
        {active ? <ListView key={active.id} list={active} onEdit={() => setEditingList(active)} /> : !lists.isLoading && <Empty icon="📝" title="No lists yet" />}
      </div>
      {editingList && (
        <ListModal
          list={editingList === 'new' ? null : editingList}
          onClose={() => setEditingList(null)}
          onCreated={(id) => nav(`/lists/${id}`)}
          onDeleted={() => nav('/lists')}
        />
      )}
    </div>
  );
}

function ListView({ list, onEdit }: { list: List; onEdit: () => void }) {
  const { members, byId } = useMembers();
  const items = useQuery({ queryKey: ['items', list.id], queryFn: () => api<ListItem[]>(`/lists/${list.id}/items`) });
  const [text, setText] = useState('');
  const [showDone, setShowDone] = useState(false);
  const [editing, setEditing] = useState<ListItem | null>(null);
  const inv = [['items'], ['lists']];

  const add = useAction((t: string) => api(`/lists/${list.id}/items`, 'POST', { text: t }), inv, () => setText(''));
  const toggle = useAction((i: ListItem) => api(`/items/${i.id}`, 'PATCH', { checked: !i.checked }), inv);
  const clear = useAction(() => api(`/lists/${list.id}/clear-checked`, 'POST'), inv);

  const open = (items.data ?? []).filter((i) => !i.checked);
  const done = (items.data ?? []).filter((i) => i.checked);
  const t = today();

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (text.trim()) add.mutate(text);
  };

  return (
    <section className="card list-view">
      <div className="card-head">
        <h2>
          {list.emoji} {list.name}
        </h2>
        <button className="icon-btn" onClick={onEdit} aria-label="List settings">
          <Icon name="edit" size={18} />
        </button>
      </div>
      <form className="add-row" onSubmit={submit}>
        <textarea
          className="input"
          rows={1}
          placeholder={list.kind === 'shopping' ? 'Add an item (paste several lines to add many)' : 'Add a to-do'}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              if (text.trim()) add.mutate(text);
            }
          }}
        />
        <button className="btn btn-primary" disabled={!text.trim() || add.isPending}>
          <Icon name="plus" size={18} />
        </button>
      </form>

      {open.length === 0 && !items.isLoading && <Empty icon={list.kind === 'shopping' ? '🛒' : '✨'} title="All done!" />}
      <ul className="items">
        {open.map((i) => (
          <li key={i.id} className="item">
            <input type="checkbox" checked={false} onChange={() => toggle.mutate(i)} aria-label={`Mark ${i.text} done`} />
            <button className="item-text" onClick={() => setEditing(i)}>
              {i.text}
            </button>
            <PriorityBadge priority={i.priority} />
            {i.dueDate && <span className={`due ${i.dueDate < t ? 'overdue' : ''}`}>{relativeDayLabel(i.dueDate)}</span>}
            {i.assigneeId && <Avatar member={byId.get(i.assigneeId)} size={22} />}
          </li>
        ))}
      </ul>

      {done.length > 0 && (
        <div className="done-section">
          <div className="row">
            <button className="link-btn" onClick={() => setShowDone((s) => !s)}>
              {showDone ? 'Hide' : 'Show'} completed ({done.length})
            </button>
            <span className="spacer" />
            <button className="link-btn" onClick={() => clear.mutate()}>
              Clear completed
            </button>
          </div>
          {showDone && (
            <ul className="items">
              {done.map((i) => (
                <li key={i.id} className="item is-done">
                  <input type="checkbox" checked onChange={() => toggle.mutate(i)} aria-label={`Mark ${i.text} not done`} />
                  <span className="item-text">{i.text}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      {editing && <ItemModal item={editing} members={members} onClose={() => setEditing(null)} />}
    </section>
  );
}

function ItemModal({ item, members, onClose }: { item: ListItem; members: ReturnType<typeof useMembers>['members']; onClose: () => void }) {
  const [text, setText] = useState(item.text);
  const [assigneeId, setAssigneeId] = useState(item.assigneeId ?? '');
  const [dueDate, setDueDate] = useState(item.dueDate ?? '');
  const [priority, setPriority] = useState<Priority>(item.priority ?? 'none');
  const inv = [['items'], ['lists']];
  const save = useAction(() => api(`/items/${item.id}`, 'PATCH', { text, assigneeId: assigneeId || null, dueDate: dueDate || null, priority }), inv, onClose);
  const del = useAction(() => api(`/items/${item.id}`, 'DELETE'), inv, onClose);
  return (
    <Modal
      title="Edit item"
      onClose={onClose}
      footer={
        <>
          <button className="btn btn-danger-ghost" onClick={() => del.mutate()}>
            <Icon name="trash" size={16} /> Delete
          </button>
          <span className="spacer" />
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" onClick={() => save.mutate()} disabled={!text.trim()}>Save</button>
        </>
      }
    >
      <div className="form">
        <Field label="Item">
          <input className="input" value={text} onChange={(e) => setText(e.target.value)} />
        </Field>
        <div className="grid-2">
          <Field label="Assigned to">
            <select className="input" value={assigneeId} onChange={(e) => setAssigneeId(e.target.value)}>
              <option value="">Nobody</option>
              {members.map((m) => (
                <option key={m.id} value={m.id}>{m.name}</option>
              ))}
            </select>
          </Field>
          <Field label="Due">
            <input className="input" type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
          </Field>
        </div>
        <Field label="Priority">
          <div className="seg">
            {(['none', 'low', 'medium', 'high'] as Priority[]).map((p) => (
              <button key={p} type="button" className={priority === p ? 'on' : ''} onClick={() => setPriority(p)}>
                {p === 'none' ? 'None' : p[0].toUpperCase() + p.slice(1)}
              </button>
            ))}
          </div>
        </Field>
      </div>
    </Modal>
  );
}

function ListModal({ list, onClose, onCreated, onDeleted }: { list: List | null; onClose: () => void; onCreated: (id: string) => void; onDeleted: () => void }) {
  const [name, setName] = useState(list?.name ?? '');
  const [kind, setKind] = useState<'shopping' | 'todo'>(list?.kind ?? 'todo');
  const [emoji, setEmoji] = useState(list?.emoji ?? '');
  useEffect(() => {
    if (!list) setEmoji(kind === 'shopping' ? '🛒' : '📝');
  }, [kind, list]);
  const save = useAction(
    () => (list ? api(`/lists/${list.id}`, 'PATCH', { name, kind, emoji: emoji || null }) : api<{ id: string }>('/lists', 'POST', { name, kind, emoji: emoji || null })),
    [['lists']],
    (r: any) => {
      if (!list && r?.id) onCreated(r.id);
      onClose();
    },
  );
  const del = useAction(() => api(`/lists/${list!.id}`, 'DELETE'), [['lists']], () => {
    onDeleted();
    onClose();
  });
  return (
    <Modal
      title={list ? 'List settings' : 'New list'}
      onClose={onClose}
      footer={
        <>
          {list && (
            <button className="btn btn-danger-ghost" onClick={() => confirm(`Delete "${list.name}" and all its items?`) && del.mutate()}>
              <Icon name="trash" size={16} /> Delete
            </button>
          )}
          <span className="spacer" />
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" onClick={() => save.mutate()} disabled={!name.trim()}>Save</button>
        </>
      }
    >
      <div className="form">
        <div className="grid-2 grid-emoji">
          <Field label="Icon">
            <input className="input emoji-input" value={emoji} onChange={(e) => setEmoji(e.target.value)} maxLength={4} />
          </Field>
          <Field label="Name">
            <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Costco, Packing list" />
          </Field>
        </div>
        <Field label="Type">
          <div className="seg">
            <button type="button" className={kind === 'shopping' ? 'on' : ''} onClick={() => setKind('shopping')}>Shopping</button>
            <button type="button" className={kind === 'todo' ? 'on' : ''} onClick={() => setKind('todo')}>To-do</button>
          </div>
        </Field>
      </div>
    </Modal>
  );
}
