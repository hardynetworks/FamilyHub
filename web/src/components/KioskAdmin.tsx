import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CSSProperties, useState } from 'react';
import { AdminDevice, KioskOptions, KioskPage, api } from '../lib/api';
import { useGroups, useMe, useMembers, useToast } from '../lib/hooks';
import { CopyField, Empty, Field, Icon, Modal } from './ui';

interface DevicesResponse {
  devices: AdminDevice[];
  pinSet: boolean;
  pairUrl: string;
}

const PAGE_CHOICES: { key: KioskPage; label: string }[] = [
  { key: 'calendar', label: 'Calendar' },
  { key: 'lists', label: 'Lists' },
  { key: 'chores', label: 'Chores' },
  { key: 'meals', label: 'Meals' },
  { key: 'info', label: 'Family info (Wi-Fi, contacts)' },
];
const RETURN_CHOICES = [
  { v: 0, label: 'Never' },
  { v: 30, label: 'After 30 seconds' },
  { v: 60, label: 'After 1 minute' },
  { v: 120, label: 'After 2 minutes' },
  { v: 300, label: 'After 5 minutes' },
  { v: 600, label: 'After 10 minutes' },
];

function ago(iso: string | null) {
  if (!iso) return 'never';
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 90) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} days ago`;
}

function deviceKind(ua: string | null) {
  if (!ua) return '';
  if (/iPad|Macintosh.*Mobile/.test(ua)) return 'iPad';
  if (/Android/.test(ua)) return /Mobile/.test(ua) ? 'Android phone' : 'Android tablet';
  if (/CrOS/.test(ua)) return 'Chromebook';
  if (/aarch64|armv7|Raspbian/.test(ua)) return 'Raspberry Pi / ARM';
  if (/Linux/.test(ua)) return 'Linux';
  if (/Windows/.test(ua)) return 'Windows';
  if (/Mac OS/.test(ua)) return 'Mac';
  return '';
}

export function KioskAdmin() {
  const devices = useQuery({ queryKey: ['devices'], queryFn: () => api<DevicesResponse>('/admin/devices'), refetchInterval: 15_000 });
  const { groups } = useGroups();
  const groupName = (id: string) => groups.find((g) => g.id === id)?.name;
  const { byId } = useMembers();
  const qc = useQueryClient();
  const toast = useToast();
  const [editing, setEditing] = useState<AdminDevice | 'new' | null>(null);
  const [pairing, setPairing] = useState<{ device: AdminDevice; code: string } | null>(null);
  const data = devices.data;

  const newCode = async (d: AdminDevice) => {
    if (d.paired && !confirm(`Make a new pairing code for ${d.name}? The screen will be signed out until it's paired again.`)) return;
    try {
      setPairing(await api(`/admin/devices/${d.id}/pair`, 'POST'));
      qc.invalidateQueries({ queryKey: ['devices'] });
    } catch (e: any) {
      toast(e.message, 'error');
    }
  };
  const remove = async (d: AdminDevice) => {
    if (!confirm(`Remove ${d.name}? It will be signed out straight away.`)) return;
    await api(`/admin/devices/${d.id}`, 'DELETE').catch((e) => toast(e.message, 'error'));
    qc.invalidateQueries({ queryKey: ['devices'] });
  };

  return (
    <>
      <section className="card">
        <div className="card-head">
          <h2>Screens</h2>
          <button className="btn btn-primary btn-sm" onClick={() => setEditing('new')}>
            <Icon name="plus" size={16} /> Add a screen
          </button>
        </div>
        <p className="muted small">
          A kiosk screen is a wall tablet or a Raspberry Pi display that stays signed in on its own. It opens full screen, keeps the display awake, has no Settings, goes back
          to Home when nobody's using it, and recovers by itself after Wi-Fi drops or app updates.
        </p>
        {data && data.devices.length === 0 && <Empty icon="🖥️" title="No kiosk screens yet" />}
        <div className="device-list">
          {data?.devices.map((d) => {
            const member = byId.get(d.userId);
            const online = d.lastSeen && Date.now() - new Date(d.lastSeen).getTime() < 10 * 60_000;
            return (
              <div key={d.id} className="device-row">
                <span className={`device-dot ${d.paired ? (online ? 'on' : 'off') : 'wait'}`} />
                <div className="grow">
                  <div className="device-name">{d.name}</div>
                  <div className="muted small">
                    {d.paired
                      ? `${online ? 'Online' : 'Last seen ' + ago(d.lastSeen)}${deviceKind(d.userAgent) ? ' · ' + deviceKind(d.userAgent) : ''}`
                      : d.pairingOpen
                        ? 'Waiting to be paired'
                        : 'Not paired: make a pairing code'}
                    {member ? ` · shows ${member.name}'s Home` : ''}
                    {d.options.groupId && groupName(d.options.groupId) ? ` · ${groupName(d.options.groupId)} group` : ''}
                  </div>
                </div>
                <button className="btn btn-sm" onClick={() => newCode(d)} title="Make a new pairing code">
                  {d.paired ? 'Re-pair' : 'Pairing code'}
                </button>
                <button className="btn btn-sm" onClick={() => setEditing(d)} aria-label={`Edit ${d.name}`}>
                  <Icon name="edit" size={16} />
                </button>
                <button className="btn btn-sm" onClick={() => remove(d)} aria-label={`Remove ${d.name}`}>
                  <Icon name="trash" size={16} />
                </button>
              </div>
            );
          })}
        </div>
      </section>

      {data && <PinCard pinSet={data.pinSet} />}

      <section className="card">
        <h2>Setting up a screen</h2>
        <ol className="muted small setup-steps">
          <li>
            Tap <strong>Add a screen</strong> here and note the pairing code (it works for 30 minutes).
          </li>
          <li>
            On the tablet or Pi, open <strong>{data?.pairUrl ?? '/kiosk'}</strong> and enter the code.
          </li>
          <li>
            <strong>Android tablet:</strong> in Chrome use “Add to Home screen”, open it from there, and turn on <em>App pinning</em> (Settings → Security) so the Home and
            Back buttons can’t leave the app.
          </li>
          <li>
            <strong>iPad:</strong> Share → “Add to Home Screen”, open it from there, and use <em>Guided Access</em> (Settings → Accessibility) to lock the iPad to it.
          </li>
          <li>
            <strong>Raspberry Pi:</strong> start Chromium in kiosk mode, e.g. <code>chromium-browser --kiosk --noerrdialogs --disable-infobars {data?.pairUrl ?? 'https://…/kiosk'}</code>, and turn off
            screen blanking (raspi-config → Display → Screen Blanking).
          </li>
        </ol>
      </section>

      {editing && (
        <DeviceModal
          device={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onCreated={(r) => {
            setEditing(null);
            setPairing(r);
          }}
        />
      )}
      {pairing && data && <PairingModal device={pairing.device} code={pairing.code} pairUrl={data.pairUrl} onClose={() => setPairing(null)} />}
    </>
  );
}

function PinCard({ pinSet }: { pinSet: boolean }) {
  const [pin, setPin] = useState('');
  const qc = useQueryClient();
  const toast = useToast();
  const save = async (value: string | null) => {
    try {
      await api('/admin/devices/pin', 'PUT', { pin: value });
      setPin('');
      await qc.invalidateQueries({ queryKey: ['devices'] });
      qc.invalidateQueries({ queryKey: ['auth'] });
      toast(value ? 'Kiosk PIN saved' : 'Kiosk PIN removed', 'success');
    } catch (e: any) {
      toast(e.message, 'error');
    }
  };
  return (
    <section className="card">
      <h2>
        <Icon name="lock" size={18} /> Kiosk PIN
      </h2>
      <p className="muted small">
        The PIN is needed on a screen to open its menu: unlock all pages, customize Home, or sign the screen out.{' '}
        {pinSet ? <strong>A PIN is set.</strong> : <strong>No PIN is set yet, so anyone can open the menu.</strong>}
      </p>
      <div className="pin-row">
        <input
          className="input"
          type="password"
          inputMode="numeric"
          autoComplete="new-password"
          placeholder={pinSet ? 'New PIN (4–8 digits)' : 'PIN (4–8 digits)'}
          value={pin}
          onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, 8))}
        />
        <button className="btn btn-primary" disabled={pin.length < 4} onClick={() => save(pin)}>
          {pinSet ? 'Change PIN' : 'Set PIN'}
        </button>
        {pinSet && (
          <button className="btn" onClick={() => confirm('Remove the kiosk PIN?') && save(null)}>
            Remove
          </button>
        )}
      </div>
    </section>
  );
}

function DeviceModal({ device, onClose, onCreated }: { device: AdminDevice | null; onClose: () => void; onCreated: (r: { device: AdminDevice; code: string }) => void }) {
  const me = useMe();
  const { members } = useMembers();
  const qc = useQueryClient();
  const toast = useToast();
  const [name, setName] = useState(device?.name ?? 'Kitchen screen');
  const [userId, setUserId] = useState(device?.userId ?? me.id);
  const { groups } = useGroups();
  const [opts, setOpts] = useState<KioskOptions>(
    device?.options ?? { pages: ['calendar', 'lists', 'chores', 'meals', 'info'], returnHomeSeconds: 120, hideCursor: false, reloadNightly: true, groupId: null },
  );
  const [busy, setBusy] = useState(false);
  const set = (p: Partial<KioskOptions>) => setOpts((o) => ({ ...o, ...p }));
  const togglePage = (k: KioskPage) => set({ pages: opts.pages.includes(k) ? opts.pages.filter((p) => p !== k) : [...opts.pages, k] });

  const save = async () => {
    setBusy(true);
    try {
      if (device) {
        await api(`/admin/devices/${device.id}`, 'PATCH', { name, userId, options: opts });
        onClose();
      } else {
        onCreated(await api('/admin/devices', 'POST', { name, userId, options: opts }));
      }
      qc.invalidateQueries({ queryKey: ['devices'] });
    } catch (e: any) {
      toast(e.message, 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={device ? `Edit ${device.name}` : 'Add a kiosk screen'}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" onClick={save} disabled={busy || !name.trim()}>
            {device ? 'Save' : 'Add and get a pairing code'}
          </button>
        </>
      }
    >
      <div className="form">
        <Field label="Screen name">
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} maxLength={60} placeholder="e.g. Kitchen screen" />
        </Field>
        <Field label="Show the Home page of" hint="The screen uses this person's Home layout and slideshow settings. It never gets head-of-household access.">
          <select className="input" value={userId} onChange={(e) => setUserId(e.target.value)}>
            {members.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </select>
        </Field>
        <Field
          label="Family group"
          hint="The screen only shows this group's calendar events, chores and to-dos (plus things for everyone). Switch it on the screen any time with the kiosk PIN."
        >
          <div className="group-picks">
            <button type="button" className={`group-pick ${!opts.groupId ? 'on' : ''}`} onClick={() => set({ groupId: null })}>
              <span className="group-pick-emoji">🏠</span> Whole family
            </button>
            {groups.map((g) => (
              <button
                type="button"
                key={g.id}
                className={`group-pick ${opts.groupId === g.id ? 'on' : ''}`}
                style={{ '--group-color': g.color } as CSSProperties}
                onClick={() => set({ groupId: g.id })}
              >
                <span className="group-pick-emoji">{g.emoji || '👥'}</span> {g.name}
              </button>
            ))}
          </div>
        </Field>
        <Field label="Pages people can open" hint="Home is always there. Settings are never shown on a kiosk screen.">
          <div className="check-grid">
            {PAGE_CHOICES.map((p) => (
              <label key={p.key} className="check-row">
                <input type="checkbox" checked={opts.pages.includes(p.key)} onChange={() => togglePage(p.key)} />
                <span>{p.label}</span>
              </label>
            ))}
          </div>
        </Field>
        <Field label="Go back to Home when nobody's touching it">
          <select className="input" value={opts.returnHomeSeconds} onChange={(e) => set({ returnHomeSeconds: Number(e.target.value) })}>
            {RETURN_CHOICES.map((c) => (
              <option key={c.v} value={c.v}>
                {c.label}
              </option>
            ))}
          </select>
        </Field>
        <label className="check-row">
          <input type="checkbox" checked={opts.hideCursor} onChange={(e) => set({ hideCursor: e.target.checked })} />
          <span>Hide the mouse pointer (touch screens on a Raspberry Pi)</span>
        </label>
        <label className="check-row">
          <input type="checkbox" checked={opts.reloadNightly} onChange={(e) => set({ reloadNightly: e.target.checked })} />
          <span>Refresh the screen once a night (3:30 am)</span>
        </label>
      </div>
    </Modal>
  );
}

function PairingModal({ device, code, pairUrl, onClose }: { device: AdminDevice; code: string; pairUrl: string; onClose: () => void }) {
  const link = `${pairUrl}?code=${encodeURIComponent(code)}`;
  return (
    <Modal
      title={`Pair ${device.name}`}
      onClose={onClose}
      footer={
        <button className="btn btn-primary" onClick={onClose}>
          Done
        </button>
      }
    >
      <div className="pairing">
        <p className="muted small">
          On the screen, open <strong>{pairUrl}</strong> and enter this code. It works once, for the next 30 minutes.
        </p>
        <div className="pair-code">{code}</div>
        <p className="muted small">Or open this link on the screen (it pairs straight away):</p>
        <CopyField value={link} />
      </div>
    </Modal>
  );
}
