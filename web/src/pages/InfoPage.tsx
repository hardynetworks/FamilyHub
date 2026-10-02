/** Family info: Wi-Fi with a scan-to-join QR code, address, contacts, medical notes and notes. */
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Avatar, Empty, Field, Icon } from '../components/ui';
import { ContactCategory, FamilyInfo, InfoContact, MedicalInfo, WifiNetwork, api } from '../lib/api';
import { useMe, useMembers, useToast } from '../lib/hooks';
import { useKiosk } from '../lib/kiosk';
import { makeQr, qrSvgPath, wifiQrText } from '../lib/qr';

export function useFamilyInfo() {
  return useQuery({ queryKey: ['family-info'], queryFn: () => api<FamilyInfo>('/info'), staleTime: 60_000 });
}

const CATEGORIES: { id: ContactCategory; label: string; icon: string }[] = [
  { id: 'emergency', label: 'Emergency', icon: '🚨' },
  { id: 'family', label: 'Family & friends', icon: '👪' },
  { id: 'doctor', label: 'Doctors', icon: '🩺' },
  { id: 'dentist', label: 'Dentist', icon: '🦷' },
  { id: 'school', label: 'School & childcare', icon: '🏫' },
  { id: 'work', label: 'Work', icon: '💼' },
  { id: 'vet', label: 'Vet', icon: '🐾' },
  { id: 'other', label: 'Other', icon: '📇' },
];

export function QrSvg({ text, size = 220 }: { text: string; size?: number }) {
  const { path, n } = useMemo(() => {
    try {
      const qr = makeQr(text);
      return { path: qrSvgPath(qr, 4), n: qr.size + 8 };
    } catch {
      return { path: '', n: 0 };
    }
  }, [text]);
  if (!path) return <p className="muted small">Too long for a QR code.</p>;
  return (
    <svg className="qr-svg" viewBox={`0 0 ${n} ${n}`} width={size} height={size} role="img" aria-label="QR code" shapeRendering="crispEdges">
      <rect width={n} height={n} fill="#fff" />
      <path d={path} fill="#000" />
    </svg>
  );
}

export function WifiCard({ w, compact }: { w: WifiNetwork; compact?: boolean }) {
  const [show, setShow] = useState(!compact);
  return (
    <div className={`wifi-card ${compact ? 'is-compact' : ''}`}>
      <QrSvg text={wifiQrText(w)} size={compact ? 150 : 200} />
      <div className="wifi-text">
        <div className="muted small">{w.label || 'Wi-Fi'}</div>
        <div className="wifi-ssid">
          <Icon name="wifi" size={18} /> {w.ssid}
        </div>
        {w.security !== 'nopass' && (
          <div className="wifi-pass">
            {show ? <code>{w.password}</code> : <span className="muted">••••••••</span>}
            {compact && (
              <button className="link-btn" onClick={() => setShow((s) => !s)}>
                {show ? 'Hide' : 'Show'}
              </button>
            )}
          </div>
        )}
        <div className="muted small">Point a phone camera at the code to join.</div>
      </div>
    </div>
  );
}

const blank = (): FamilyInfo => ({ wifi: [], address: '', contacts: [], medical: [], notes: '' });

export function InfoPage() {
  const info = useFamilyInfo();
  const me = useMe();
  const kiosk = useKiosk();
  const canEdit = !kiosk.active && (me.role === 'admin' || me.memberType !== 'child');
  const [draft, setDraft] = useState<FamilyInfo | null>(null);
  const d = info.data;

  if (draft) return <InfoEditor initial={draft} onDone={() => setDraft(null)} />;
  const empty = d && !d.wifi.length && !d.address && !d.contacts.length && !d.medical.length && !d.notes;
  return (
    <div className="page">
      <header className="page-head">
        <h1>Family info</h1>
        {canEdit && (
          <button className="btn" onClick={() => setDraft(structuredClone(d ?? blank()))}>
            <Icon name="edit" size={16} /> Edit
          </button>
        )}
      </header>
      {empty && (
        <Empty icon="📇" title="Nothing here yet">
          {canEdit ? 'Tap Edit to add your Wi-Fi (with a QR code guests can scan), emergency contacts, doctors and more.' : 'A grown-up can add Wi-Fi, contacts and more.'}
        </Empty>
      )}
      {d && <InfoView info={d} />}
    </div>
  );
}

function InfoView({ info }: { info: FamilyInfo }) {
  const { byId } = useMembers();
  const tel = (p: string) => `tel:${p.replace(/[^\d+]/g, '')}`;
  return (
    <div className="info-grid">
      {info.wifi.length > 0 && (
        <section className="card info-wifi">
          <h2>Wi-Fi</h2>
          <div className="wifi-list">
            {info.wifi.map((w, i) => (
              <WifiCard key={i} w={w} />
            ))}
          </div>
        </section>
      )}
      {info.address && (
        <section className="card">
          <h2>Home address</h2>
          <p className="info-address">{info.address}</p>
          <a className="link-btn" href={`https://maps.google.com/?q=${encodeURIComponent(info.address)}`} target="_blank" rel="noreferrer">
            Open in Maps
          </a>
        </section>
      )}
      {CATEGORIES.map((c) => {
        const list = info.contacts.filter((x) => x.category === c.id);
        if (!list.length) return null;
        return (
          <section key={c.id} className={`card ${c.id === 'emergency' ? 'info-emergency' : ''}`}>
            <h2>
              {c.icon} {c.label}
            </h2>
            {list.map((x, i) => (
              <div key={i} className="contact-row">
                <div className="grow">
                  <div className="contact-name">
                    {x.name}
                    {x.role && <span className="muted"> · {x.role}</span>}
                  </div>
                  {x.notes && <div className="muted small">{x.notes}</div>}
                  {x.email && (
                    <a className="small" href={`mailto:${x.email}`}>
                      {x.email}
                    </a>
                  )}
                </div>
                {x.phone && (
                  <a className="btn btn-sm contact-phone" href={tel(x.phone)}>
                    <Icon name="phone" size={14} /> {x.phone}
                  </a>
                )}
              </div>
            ))}
          </section>
        );
      })}
      {info.medical.length > 0 && (
        <section className="card info-medical">
          <h2>🩹 Medical notes</h2>
          {info.medical.map((m) => {
            const who = byId.get(m.memberId);
            if (!who) return null;
            const rows: [string, string][] = [
              ['Allergies', m.allergies],
              ['Medications', m.medications],
              ['Conditions', m.conditions],
              ['Blood type', m.bloodType],
              ['Notes', m.notes],
            ];
            return (
              <div key={m.memberId} className="medical-row">
                <div className="row">
                  <Avatar member={who} size={28} />
                  <strong>{who.name}</strong>
                </div>
                <dl className="medical-dl">
                  {rows
                    .filter(([, v]) => v)
                    .map(([k, v]) => (
                      <div key={k}>
                        <dt>{k}</dt>
                        <dd>{v}</dd>
                      </div>
                    ))}
                </dl>
              </div>
            );
          })}
        </section>
      )}
      {info.notes && (
        <section className="card">
          <h2>📝 Notes</h2>
          <p className="info-notes">{info.notes}</p>
        </section>
      )}
    </div>
  );
}

function InfoEditor({ initial, onDone }: { initial: FamilyInfo; onDone: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const { members } = useMembers();
  const [d, setD] = useState<FamilyInfo>(initial);
  const [busy, setBusy] = useState(false);
  const [showPw, setShowPw] = useState(false);

  const setWifi = (i: number, p: Partial<WifiNetwork>) => setD((x) => ({ ...x, wifi: x.wifi.map((w, j) => (j === i ? { ...w, ...p } : w)) }));
  const setContact = (i: number, p: Partial<InfoContact>) => setD((x) => ({ ...x, contacts: x.contacts.map((c, j) => (j === i ? { ...c, ...p } : c)) }));
  const setMedical = (id: string, p: Partial<MedicalInfo>) =>
    setD((x) => {
      const has = x.medical.some((m) => m.memberId === id);
      const base: MedicalInfo = { memberId: id, allergies: '', medications: '', conditions: '', bloodType: '', notes: '' };
      return { ...x, medical: has ? x.medical.map((m) => (m.memberId === id ? { ...m, ...p } : m)) : [...x.medical, { ...base, ...p }] };
    });

  const save = async () => {
    setBusy(true);
    try {
      const clean: FamilyInfo = {
        ...d,
        wifi: d.wifi.filter((w) => w.ssid.trim()),
        contacts: d.contacts.filter((c) => c.name.trim() || c.phone.trim()),
        medical: d.medical.filter((m) => m.allergies || m.medications || m.conditions || m.bloodType || m.notes),
      };
      delete clean.updatedAt;
      await api('/info', 'PUT', clean);
      await qc.invalidateQueries({ queryKey: ['family-info'] });
      toast('Family info saved', 'success');
      onDone();
    } catch (e: any) {
      toast(e.message, 'error');
      setBusy(false);
    }
  };

  return (
    <div className="page">
      <header className="page-head">
        <h1>Edit family info</h1>
        <div className="row-wrap">
          <button className="btn" onClick={onDone}>
            Cancel
          </button>
          <button className="btn btn-primary" onClick={save} disabled={busy}>
            {busy ? 'Saving…' : 'Save'}
          </button>
        </div>
      </header>
      <p className="muted small">Everyone in the family can see this, and so can kiosk screens (so guests can scan the Wi-Fi code).</p>

      <section className="card form">
        <div className="card-head-row">
          <h2>Wi-Fi</h2>
          {d.wifi.length < 4 && (
            <button className="btn btn-sm" onClick={() => setD((x) => ({ ...x, wifi: [...x.wifi, { label: x.wifi.length ? 'Guest' : 'Home', ssid: '', password: '', security: 'WPA', hidden: false }] }))}>
              <Icon name="plus" size={14} /> Add a network
            </button>
          )}
        </div>
        {d.wifi.map((w, i) => (
          <div key={i} className="edit-block">
            <div className="grid-2">
              <Field label="Label">
                <input className="input" value={w.label} onChange={(e) => setWifi(i, { label: e.target.value })} placeholder="Home, Guest…" maxLength={40} />
              </Field>
              <Field label="Network name (SSID)">
                <input className="input" value={w.ssid} onChange={(e) => setWifi(i, { ssid: e.target.value })} maxLength={64} />
              </Field>
              <Field label="Password">
                <div className="row">
                  <input className="input" type={showPw ? 'text' : 'password'} value={w.password} onChange={(e) => setWifi(i, { password: e.target.value })} disabled={w.security === 'nopass'} autoComplete="off" maxLength={128} />
                  <button type="button" className="btn btn-sm" onClick={() => setShowPw((s) => !s)}>
                    {showPw ? 'Hide' : 'Show'}
                  </button>
                </div>
              </Field>
              <Field label="Security">
                <select className="input" value={w.security} onChange={(e) => setWifi(i, { security: e.target.value as WifiNetwork['security'] })}>
                  <option value="WPA">WPA / WPA2 / WPA3 (most networks)</option>
                  <option value="WEP">WEP (old)</option>
                  <option value="nopass">No password</option>
                </select>
              </Field>
            </div>
            <div className="row-wrap">
              <label className="check-row">
                <input type="checkbox" checked={w.hidden} onChange={(e) => setWifi(i, { hidden: e.target.checked })} />
                <span>Hidden network</span>
              </label>
              <span className="spacer" />
              <button className="btn btn-sm btn-danger-ghost" onClick={() => setD((x) => ({ ...x, wifi: x.wifi.filter((_, j) => j !== i) }))}>
                <Icon name="trash" size={14} /> Remove
              </button>
            </div>
            {w.ssid && <WifiCard w={w} compact />}
          </div>
        ))}
      </section>

      <section className="card form">
        <h2>Home address</h2>
        <textarea className="input" rows={2} value={d.address} onChange={(e) => setD((x) => ({ ...x, address: e.target.value }))} maxLength={300} placeholder="123 Main St, Springfield" />
      </section>

      <section className="card form">
        <div className="card-head-row">
          <h2>Contacts</h2>
          <button className="btn btn-sm" onClick={() => setD((x) => ({ ...x, contacts: [...x.contacts, { category: 'emergency', name: '', role: '', phone: '', email: '', notes: '' }] }))}>
            <Icon name="plus" size={14} /> Add a contact
          </button>
        </div>
        {d.contacts.length === 0 && <p className="muted small">Add emergency contacts, grandparents, the pediatrician, dentist, school office, poison control (1-800-222-1222 in the US), the vet…</p>}
        {d.contacts.map((c, i) => (
          <div key={i} className="edit-block">
            <div className="grid-3">
              <Field label="Type">
                <select className="input" value={c.category} onChange={(e) => setContact(i, { category: e.target.value as ContactCategory })}>
                  {CATEGORIES.map((k) => (
                    <option key={k.id} value={k.id}>
                      {k.icon} {k.label}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Name">
                <input className="input" value={c.name} onChange={(e) => setContact(i, { name: e.target.value })} maxLength={80} />
              </Field>
              <Field label="Role (optional)">
                <input className="input" value={c.role} onChange={(e) => setContact(i, { role: e.target.value })} placeholder="Pediatrician, Grandma…" maxLength={80} />
              </Field>
              <Field label="Phone">
                <input className="input" type="tel" value={c.phone} onChange={(e) => setContact(i, { phone: e.target.value })} maxLength={40} />
              </Field>
              <Field label="Email (optional)">
                <input className="input" type="email" value={c.email} onChange={(e) => setContact(i, { email: e.target.value })} maxLength={120} />
              </Field>
              <Field label="Notes (optional)">
                <input className="input" value={c.notes} onChange={(e) => setContact(i, { notes: e.target.value })} maxLength={300} />
              </Field>
            </div>
            <div className="row-wrap">
              <span className="spacer" />
              <button className="btn btn-sm btn-danger-ghost" onClick={() => setD((x) => ({ ...x, contacts: x.contacts.filter((_, j) => j !== i) }))}>
                <Icon name="trash" size={14} /> Remove
              </button>
            </div>
          </div>
        ))}
      </section>

      <section className="card form">
        <h2>Medical notes</h2>
        <p className="muted small">Allergies, medications and conditions for each person, for babysitters and emergencies. Leave blank if there's nothing to note.</p>
        {members.map((m) => {
          const med = d.medical.find((x) => x.memberId === m.id);
          return (
            <details key={m.id} className="edit-block" open={!!med}>
              <summary className="row">
                <Avatar member={m} size={26} /> <strong>{m.name}</strong>
              </summary>
              <div className="grid-2">
                <Field label="Allergies">
                  <input className="input" value={med?.allergies ?? ''} onChange={(e) => setMedical(m.id, { allergies: e.target.value })} maxLength={300} />
                </Field>
                <Field label="Medications">
                  <input className="input" value={med?.medications ?? ''} onChange={(e) => setMedical(m.id, { medications: e.target.value })} maxLength={300} />
                </Field>
                <Field label="Conditions">
                  <input className="input" value={med?.conditions ?? ''} onChange={(e) => setMedical(m.id, { conditions: e.target.value })} maxLength={300} />
                </Field>
                <Field label="Blood type">
                  <input className="input" value={med?.bloodType ?? ''} onChange={(e) => setMedical(m.id, { bloodType: e.target.value })} maxLength={10} />
                </Field>
              </div>
              <Field label="Notes">
                <input className="input" value={med?.notes ?? ''} onChange={(e) => setMedical(m.id, { notes: e.target.value })} maxLength={500} />
              </Field>
            </details>
          );
        })}
      </section>

      <section className="card form">
        <h2>Notes</h2>
        <textarea className="input" rows={5} value={d.notes} onChange={(e) => setD((x) => ({ ...x, notes: e.target.value }))} maxLength={3000} placeholder="Garage code, trash day, babysitter instructions…" />
      </section>
    </div>
  );
}

/** Home widget: the Wi-Fi QR code. */
export function WifiWidget() {
  const info = useFamilyInfo();
  const w = info.data?.wifi[0];
  return (
    <section className="card widget-fill">
      <div className="card-head">
        <h2>Guest Wi-Fi</h2>
        <Link to="/info" className="link-btn">
          Family info
        </Link>
      </div>
      <div className="widget-scroll">
        {info.data && !w && <Empty icon="📶" title="No Wi-Fi saved">Add it in Family info.</Empty>}
        {w && <WifiCard w={info.data!.wifi.find((x) => /guest/i.test(x.label)) ?? w} compact />}
      </div>
    </section>
  );
}
