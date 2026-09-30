/**
 * Family groups (Parents, Kids, ...): named sets of family members. A kiosk screen can show just
 * one group's calendar, chores and to-dos; see server/src/groups.ts.
 */
import { useQueryClient } from '@tanstack/react-query';
import { CSSProperties, useState } from 'react';
import { FamilyGroup, api } from '../lib/api';
import { useGroups, useMembers, useToast } from '../lib/hooks';
import { Avatar, Field, Icon, Modal } from './ui';

export const GROUP_EMOJIS = ['👪', '🧒', '👧', '👦', '🧑', '👩', '👨', '👵', '🏠', '⭐', '🎮', '📚', '⚽', '🎨', '🦄', '🚀'];
export const GROUP_COLORS = ['#6366f1', '#f59e0b', '#10b981', '#ec4899', '#0ea5e9', '#8b5cf6', '#ef4444', '#64748b'];

const groupStyle = (color: string) => ({ '--group-color': color }) as CSSProperties;

/** Settings → Family: list and edit groups. */
export function FamilyGroupsCard({ isHead }: { isHead: boolean }) {
  const { groups, isLoading } = useGroups();
  const { byId } = useMembers();
  const [editing, setEditing] = useState<FamilyGroup | 'new' | null>(null);
  return (
    <section className="card">
      <div className="card-head-row">
        <h2>Groups</h2>
        {isHead && (
          <button className="btn btn-sm" onClick={() => setEditing('new')}>
            <Icon name="plus" size={14} /> New group
          </button>
        )}
      </div>
      <p className="muted small">
        Groups like Parents and Kids. A kiosk screen can show just one group's calendar, chores and to-dos: pick it when you add the screen, or switch it on the screen with the kiosk PIN.
      </p>
      {!isLoading && !groups.length && <p className="muted small">No groups yet.</p>}
      <div className="group-list">
        {groups.map((g) => (
          <button key={g.id} className="group-row" style={groupStyle(g.color)} onClick={() => isHead && setEditing(g)} disabled={!isHead}>
            <span className="group-badge">{g.emoji || '👥'}</span>
            <span className="grow">
              <span className="group-row-name">{g.name}</span>
              <span className="muted small">
                {g.memberIds.length ? `${g.memberIds.length} ${g.memberIds.length === 1 ? 'person' : 'people'}` : 'Nobody yet'}
              </span>
            </span>
            <span className="group-row-avatars">
              {g.memberIds.slice(0, 6).map((id) => (
                <Avatar key={id} member={byId.get(id)} size={28} />
              ))}
            </span>
            {isHead && <Icon name="edit" size={16} />}
          </button>
        ))}
      </div>
      {editing && <GroupModal group={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
    </section>
  );
}

function GroupModal({ group, onClose }: { group: FamilyGroup | null; onClose: () => void }) {
  const { members } = useMembers();
  const qc = useQueryClient();
  const toast = useToast();
  const [name, setName] = useState(group?.name ?? '');
  const [emoji, setEmoji] = useState(group?.emoji ?? '👪');
  const [color, setColor] = useState(group?.color ?? GROUP_COLORS[0]);
  const [memberIds, setMemberIds] = useState<string[]>(group?.memberIds ?? []);
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const toggle = (id: string) => setMemberIds((ids) => (ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id]));

  const done = () => {
    qc.invalidateQueries({ queryKey: ['groups'] });
    qc.invalidateQueries({ queryKey: ['devices'] });
    onClose();
  };
  const save = async () => {
    setBusy(true);
    try {
      const body = { name: name.trim(), emoji, color, memberIds };
      if (group) await api(`/groups/${group.id}`, 'PUT', body);
      else await api('/groups', 'POST', body);
      toast(group ? 'Group saved' : 'Group added', 'success');
      done();
    } catch (e: any) {
      toast(e.message, 'error');
      setBusy(false);
    }
  };
  const remove = async () => {
    setBusy(true);
    try {
      await api(`/groups/${group!.id}`, 'DELETE');
      toast('Group removed', 'success');
      done();
    } catch (e: any) {
      toast(e.message, 'error');
      setBusy(false);
    }
  };

  return (
    <Modal
      title={group ? `Edit ${group.name}` : 'New group'}
      onClose={onClose}
      footer={
        <>
          {group &&
            (confirmDelete ? (
              <button className="btn btn-danger" onClick={remove} disabled={busy}>
                Remove {group.name}?
              </button>
            ) : (
              <button className="btn" onClick={() => setConfirmDelete(true)}>
                Remove
              </button>
            ))}
          <span className="grow" />
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" onClick={save} disabled={busy || !name.trim()}>
            Save
          </button>
        </>
      }
    >
      <div className="form">
        <Field label="Name">
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} maxLength={40} placeholder="e.g. Kids" />
        </Field>
        <Field label="Icon">
          <div className="swatches">
            {GROUP_EMOJIS.map((e) => (
              <button type="button" key={e} className={`emoji-pick ${emoji === e ? 'on' : ''}`} onClick={() => setEmoji(e)}>
                {e}
              </button>
            ))}
          </div>
        </Field>
        <Field label="Colour">
          <div className="swatches">
            {GROUP_COLORS.map((c) => (
              <button type="button" key={c} className={`swatch ${color === c ? 'on' : ''}`} style={{ background: c }} onClick={() => setColor(c)} aria-label={c} />
            ))}
          </div>
        </Field>
        <Field label="Who's in it" hint="Someone can be in more than one group.">
          <div className="group-members">
            {members.map((m) => (
              <button type="button" key={m.id} className={`group-member ${memberIds.includes(m.id) ? 'on' : ''}`} onClick={() => toggle(m.id)}>
                <Avatar member={m} size={30} />
                <span>{m.name}</span>
                {memberIds.includes(m.id) && <Icon name="check" size={16} />}
              </button>
            ))}
          </div>
        </Field>
      </div>
    </Modal>
  );
}

/** Kiosk: pick which group the screen shows (after the PIN). */
export function GroupPicker({ pin, current, onClose, onChanged }: { pin: string; current: string | null; onClose: () => void; onChanged: (name: string) => void }) {
  const { groups } = useGroups();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const choose = async (groupId: string | null, name: string) => {
    setBusy(true);
    try {
      await api('/kiosk/group', 'POST', { pin, groupId });
      onChanged(name);
    } catch (e: any) {
      toast(e.message, 'error');
      setBusy(false);
    }
  };
  return (
    <Modal title="Show which group?" onClose={onClose}>
      <div className="group-switch-list">
        <button className={`group-switch ${!current ? 'on' : ''}`} disabled={busy} onClick={() => choose(null, 'Whole family')}>
          <span className="group-badge">🏠</span>
          <span className="grow">Whole family</span>
          {!current && <Icon name="check" size={20} />}
        </button>
        {groups.map((g) => (
          <button key={g.id} className={`group-switch ${current === g.id ? 'on' : ''}`} style={groupStyle(g.color)} disabled={busy} onClick={() => choose(g.id, g.name)}>
            <span className="group-badge">{g.emoji || '👥'}</span>
            <span className="grow">{g.name}</span>
            {current === g.id && <Icon name="check" size={20} />}
          </button>
        ))}
      </div>
    </Modal>
  );
}
