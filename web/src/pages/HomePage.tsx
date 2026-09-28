import { useQueryClient } from '@tanstack/react-query';
import { CSSProperties, PointerEvent as ReactPointerEvent, useCallback, useEffect, useRef, useState } from 'react';
import { useCameras } from '../components/Cameras';
import { WidgetView, useLists } from '../components/HomeWidgets';
import { IdleSlideshow, usePhotos } from '../components/Slideshow';
import { Empty, Field, Icon, Modal } from '../components/ui';
import { useWeather } from '../components/Weather';
import { api } from '../lib/api';
import { useMe, useToast } from '../lib/hooks';
import {
  ACCENTS,
  HomeLayout,
  Theme,
  WIDGETS,
  Widget,
  WidgetSpec,
  applyTheme,
  newId,
  optionValue,
  resolveLayout,
  specFor,
  useHomeLayout,
} from '../lib/layout';

const SCALE: Record<NonNullable<Theme['scale']>, number> = { sm: 0.9, md: 1, lg: 1.12, xl: 1.25 };

/** Columns available at the current width: 12 on desktops, 6 on tablets, 1 on phones. */
function useColumns() {
  const get = () => (window.innerWidth < 700 ? 1 : window.innerWidth < 1100 ? 6 : 12);
  const [cols, setCols] = useState(get);
  useEffect(() => {
    const on = () => setCols(get());
    window.addEventListener('resize', on);
    return () => window.removeEventListener('resize', on);
  }, []);
  return cols;
}

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));

export function HomePage() {
  const me = useMe();
  const qc = useQueryClient();
  const toast = useToast();
  const layoutQ = useHomeLayout();
  const saved = resolveLayout(layoutQ.data);
  const [draft, setDraft] = useState<HomeLayout | null>(null);
  const editing = !!draft;
  const layout = draft ?? saved;
  const cols = useColumns();
  const canvasRef = useRef<HTMLDivElement>(null);

  const [slideSignal, setSlideSignal] = useState(0);
  const photoList = usePhotos(me.prefs.slideshowEnabled);
  const canShowPhotos = !!photoList.data?.enabled && (photoList.data?.photos.length ?? 0) > 0;
  const cams = useCameras();
  const wx = useWeather();

  const [panel, setPanel] = useState<'add' | 'theme' | { options: string } | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // Live theme preview while editing; restore the saved theme when leaving the editor.
  useEffect(() => {
    if (draft) applyTheme(draft.theme);
  }, [draft?.theme]); // eslint-disable-line react-hooks/exhaustive-deps

  const available = (w: Widget) => {
    if (w.type === 'cameras') return !!cams.data?.enabled && cams.data.mode !== 'off';
    if (w.type === 'weather') return !!wx.data?.enabled;
    return true;
  };

  const startEditing = () => setDraft(structuredClone(saved));
  const cancel = () => {
    setDraft(null);
    setPanel(null);
    applyTheme(saved.theme);
  };

  const update = useCallback((fn: (l: HomeLayout) => HomeLayout) => setDraft((d) => (d ? fn(structuredClone(d)) : d)), []);
  const updateWidget = (id: string, patch: Partial<Widget>) => update((l) => ({ ...l, widgets: l.widgets.map((w) => (w.id === id ? { ...w, ...patch } : w)) }));
  const setTheme = (patch: Partial<Theme>) => update((l) => ({ ...l, theme: { ...l.theme, ...patch } }));

  const save = async () => {
    if (!draft) return;
    setSaving(true);
    try {
      await api('/home/layout', 'PUT', { layout: draft });
      await qc.invalidateQueries({ queryKey: ['home-layout'] });
      setDraft(null);
      setPanel(null);
      toast('Home page saved', 'success');
    } catch (e: any) {
      toast(e.message, 'error');
    } finally {
      setSaving(false);
    }
  };

  const saveAsFamily = async () => {
    if (!draft || !confirm('Make this the Home page for everyone in the family who hasn’t customized theirs?')) return;
    setSaving(true);
    try {
      await api('/home/layout/family', 'PUT', { layout: draft });
      await api('/home/layout', 'DELETE');
      await qc.invalidateQueries({ queryKey: ['home-layout'] });
      setDraft(null);
      setPanel(null);
      toast('Saved as the family Home page', 'success');
    } catch (e: any) {
      toast(e.message, 'error');
    } finally {
      setSaving(false);
    }
  };

  const reset = async () => {
    const fam = layoutQ.data?.familyDefault;
    if (!confirm(fam ? 'Go back to the family Home page? Your changes will be lost.' : 'Go back to the standard Home page? Your changes will be lost.')) return;
    try {
      await api('/home/layout', 'DELETE');
      await qc.invalidateQueries({ queryKey: ['home-layout'] });
      setDraft(null);
      setPanel(null);
      applyTheme((fam ?? resolveLayout(undefined)).theme);
      toast('Home page reset', 'success');
    } catch (e: any) {
      toast(e.message, 'error');
    }
  };

  // ---------- Drag to reorder (pointer events: works with mouse and touch) ----------
  const beginDrag = (e: ReactPointerEvent, id: string) => {
    e.preventDefault();
    setDragId(id);
    let frame = 0;
    const onMove = (ev: PointerEvent) => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        // Auto-scroll near the edges of the window.
        if (ev.clientY < 80) window.scrollBy(0, -18);
        else if (ev.clientY > window.innerHeight - 80) window.scrollBy(0, 18);
        const el = document.elementFromPoint(ev.clientX, ev.clientY)?.closest('[data-wid]') as HTMLElement | null;
        const overId = el?.dataset.wid;
        if (!el || !overId || overId === id) return;
        const r = el.getBoundingClientRect();
        const after = cols === 1 ? ev.clientY > r.top + r.height / 2 : ev.clientX > r.left + r.width / 2 || ev.clientY > r.bottom - r.height / 4;
        update((l) => {
          const list = [...l.widgets];
          const from = list.findIndex((w) => w.id === id);
          const [moved] = list.splice(from, 1);
          let to = list.findIndex((w) => w.id === overId);
          if (after) to += 1;
          list.splice(to, 0, moved);
          return { ...l, widgets: list };
        });
      });
    };
    const onUp = () => {
      cancelAnimationFrame(frame);
      setDragId(null);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
  };

  // ---------- Drag the corner to resize ----------
  const beginResize = (e: ReactPointerEvent, w: Widget) => {
    e.preventDefault();
    e.stopPropagation();
    const canvas = canvasRef.current;
    if (!canvas) return;
    const spec = specFor(w.type);
    const startX = e.clientX;
    const startY = e.clientY;
    // Pointer deltas are in screen pixels, so measure the canvas on screen (accounts for the text-size zoom).
    const zoom = SCALE[theme.scale ?? 'md'];
    const colW = canvas.getBoundingClientRect().width / 12; // widths are stored in 12ths
    const rowH = (rowPx + gapPx) * zoom;
    const onMove = (ev: PointerEvent) => {
      const nw = clamp(w.w + Math.round((ev.clientX - startX) / colW), spec.minW, 12);
      const nh = clamp(w.h + Math.round((ev.clientY - startY) / rowH), spec.minH, 12);
      updateWidget(w.id, { w: nw, h: nh });
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
  };

  const theme = layout.theme ?? {};
  const rowPx = theme.density === 'compact' ? 56 : 68;
  const gapPx = theme.density === 'compact' ? 10 : 16;
  const pageStyle = { zoom: SCALE[theme.scale ?? 'md'] } as CSSProperties;
  const canvasStyle = { '--row': `${rowPx}px`, '--gap': `${gapPx}px` } as CSSProperties;

  const known = new Set(WIDGETS.map((x) => x.type));
  const visible = layout.widgets.filter((w) => known.has(w.type) && !w.hidden && (editing || available(w)));

  const itemStyle = (w: Widget): CSSProperties => {
    if (cols === 1) return { gridColumn: '1 / -1' };
    const span = cols === 12 ? w.w : clamp(Math.ceil(w.w / 2), 1, 6);
    return { gridColumn: `span ${span}`, gridRow: `span ${w.h}` };
  };

  return (
    <div className={`page page-home home-bg-${theme.background ?? 'plain'} ${editing ? 'is-editing' : ''}`}>
      {editing && (
        <div className="editor-bar">
          <div className="editor-bar-title">
            <Icon name="edit" size={18} /> Customize your Home
            <span className="muted small editor-hint">{cols === 1 ? 'Drag ⠿ to reorder.' : 'Drag ⠿ to move, drag the corner to resize.'}</span>
          </div>
          <span className="spacer" />
          <button className="btn btn-sm" onClick={() => setPanel('add')}>
            <Icon name="plus" size={16} /> Add widget
          </button>
          <button className="btn btn-sm" onClick={() => setPanel('theme')}>
            <Icon name="palette" size={16} /> Look &amp; feel
          </button>
          {layoutQ.data?.source === 'mine' && (
            <button className="btn btn-sm" onClick={reset}>
              Reset
            </button>
          )}
          {me.role === 'admin' && (
            <button className="btn btn-sm" onClick={saveAsFamily} disabled={saving} title="Use this layout for everyone who hasn't customized their own">
              Save for family
            </button>
          )}
          <button className="btn btn-sm" onClick={cancel}>
            Cancel
          </button>
          <button className="btn btn-sm btn-primary" onClick={save} disabled={saving}>
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      )}

      <div className="home-zoom" style={pageStyle}>
      {visible.length === 0 && (
        <Empty icon="🏡" title="Your Home page is empty">
          {editing ? 'Use “Add widget” to put something here.' : 'Tap Customize to add widgets.'}
        </Empty>
      )}

      <div ref={canvasRef} className={`home-canvas cols-${cols}`} style={canvasStyle}>
        {visible.map((w) => (
          <div key={w.id} data-wid={w.id} className={`widget-item ${editing ? 'editing' : ''} ${dragId === w.id ? 'dragging' : ''}`} style={itemStyle(w)}>
            <div className="widget-content">
              {available(w) ? (
                <WidgetView widget={w} onPhotos={() => setSlideSignal(Date.now())} canShowPhotos={canShowPhotos} />
              ) : (
                <section className="card widget-fill widget-unavailable">
                  <Icon name={specFor(w.type).icon} size={28} />
                  <div>{specFor(w.type).label}</div>
                  <div className="muted small">Not set up yet: a head of household can set it up in Settings.</div>
                </section>
              )}
            </div>
            {editing && (
              <div className="widget-overlay">
                <div className="widget-toolbar">
                  <button className="widget-grip" onPointerDown={(e) => beginDrag(e, w.id)} aria-label={`Move ${specFor(w.type).label}`} title="Drag to move">
                    <Icon name="grip" size={18} />
                  </button>
                  <span className="widget-name">{specFor(w.type).label}</span>
                  <span className="spacer" />
                  {specFor(w.type).options && (
                    <button className="widget-btn" onClick={() => setPanel({ options: w.id })} title="Widget options" aria-label="Widget options">
                      <Icon name="settings" size={16} />
                    </button>
                  )}
                  <button
                    className="widget-btn"
                    onClick={() =>
                      specFor(w.type).multiple
                        ? update((l) => ({ ...l, widgets: l.widgets.filter((x) => x.id !== w.id) }))
                        : updateWidget(w.id, { hidden: true })
                    }
                    title="Remove from Home"
                    aria-label="Remove from Home"
                  >
                    <Icon name="x" size={16} />
                  </button>
                </div>
                {cols > 1 && (
                  <div className="widget-size">
                    <button className="widget-btn" onClick={() => updateWidget(w.id, { w: clamp(w.w - 1, specFor(w.type).minW, 12) })} aria-label="Narrower">
                      −
                    </button>
                    <span>
                      {w.w}×{w.h}
                    </span>
                    <button className="widget-btn" onClick={() => updateWidget(w.id, { w: clamp(w.w + 1, specFor(w.type).minW, 12) })} aria-label="Wider">
                      +
                    </button>
                    <span className="widget-size-sep" />
                    <button className="widget-btn" onClick={() => updateWidget(w.id, { h: clamp(w.h - 1, specFor(w.type).minH, 12) })} aria-label="Shorter">
                      <Icon name="up" size={14} />
                    </button>
                    <button className="widget-btn" onClick={() => updateWidget(w.id, { h: clamp(w.h + 1, specFor(w.type).minH, 12) })} aria-label="Taller">
                      <Icon name="down" size={14} />
                    </button>
                  </div>
                )}
                {cols > 1 && (
                  <div className="widget-resize" onPointerDown={(e) => beginResize(e, w)} title="Drag to resize" aria-hidden="true">
                    <Icon name="resize" size={16} />
                  </div>
                )}
              </div>
            )}
          </div>
        ))}
      </div>
      </div>

      {!editing && (
        <button className="customize-fab" onClick={startEditing} title="Customize this page">
          <Icon name="edit" size={16} /> Customize
        </button>
      )}

      {panel === 'add' && draft && <AddWidgetModal layout={draft} onClose={() => setPanel(null)} onChange={(l) => setDraft(l)} />}
      {panel === 'theme' && draft && <ThemeModal theme={draft.theme ?? {}} onChange={setTheme} onClose={() => setPanel(null)} />}
      {panel && typeof panel === 'object' && draft && (
        <OptionsModal
          widget={draft.widgets.find((w) => w.id === panel.options)!}
          onChange={(options) => updateWidget(panel.options, { options })}
          onClose={() => setPanel(null)}
        />
      )}
      {!editing && <IdleSlideshow startSignal={slideSignal} />}
    </div>
  );
}

function AddWidgetModal({ layout, onChange, onClose }: { layout: HomeLayout; onChange: (l: HomeLayout) => void; onClose: () => void }) {
  const add = (spec: WidgetSpec) => {
    const existing = layout.widgets.find((w) => w.type === spec.type);
    if (existing && !spec.multiple) {
      onChange({ ...layout, widgets: layout.widgets.map((w) => (w.id === existing.id ? { ...w, hidden: false } : w)) });
    } else {
      onChange({ ...layout, widgets: [...layout.widgets, { id: `${spec.type}-${newId()}`, type: spec.type, w: spec.w, h: spec.h }] });
    }
    onClose();
    setTimeout(() => window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' }), 50);
  };
  return (
    <Modal title="Add a widget" onClose={onClose} wide>
      <div className="widget-catalog">
        {WIDGETS.map((spec) => {
          const onPage = layout.widgets.some((w) => w.type === spec.type && !w.hidden);
          const disabled = onPage && !spec.multiple;
          return (
            <button key={spec.type} className="catalog-item" disabled={disabled} onClick={() => add(spec)}>
              <Icon name={spec.icon} size={24} />
              <div className="grow">
                <div className="strong">{spec.label}</div>
                <div className="muted small">{spec.description}</div>
              </div>
              <span className="muted small">{disabled ? 'On page' : 'Add'}</span>
            </button>
          );
        })}
      </div>
    </Modal>
  );
}

const BACKGROUNDS: { value: NonNullable<Theme['background']>; label: string }[] = [
  { value: 'plain', label: 'Plain' },
  { value: 'warm', label: 'Warm' },
  { value: 'sky', label: 'Sky' },
  { value: 'forest', label: 'Forest' },
  { value: 'dusk', label: 'Dusk' },
];

function ThemeModal({ theme, onChange, onClose }: { theme: Theme; onChange: (t: Partial<Theme>) => void; onClose: () => void }) {
  return (
    <Modal
      title="Look & feel"
      onClose={onClose}
      footer={
        <>
          <span className="muted small">Changes preview live. Press Save on the toolbar to keep them.</span>
          <span className="spacer" />
          <button className="btn btn-primary" onClick={onClose}>
            Done
          </button>
        </>
      }
    >
      <div className="form">
        <Field label="Accent colour" hint="Used for buttons and highlights across the whole app.">
          <div className="swatches">
            {ACCENTS.map((c) => (
              <button type="button" key={c} className={`swatch ${theme.accent === c ? 'on' : ''}`} style={{ background: c }} onClick={() => onChange({ accent: c })} aria-label={c} />
            ))}
            <label className="swatch swatch-custom" title="Custom colour">
              <input type="color" value={theme.accent ?? '#e8664a'} onChange={(e) => onChange({ accent: e.target.value })} />
            </label>
          </div>
        </Field>
        <Field label="Light or dark">
          <div className="seg">
            {(['auto', 'light', 'dark'] as const).map((m) => (
              <button type="button" key={m} className={(theme.mode ?? 'auto') === m ? 'on' : ''} onClick={() => onChange({ mode: m })}>
                {m === 'auto' ? 'Match device' : m === 'light' ? 'Light' : 'Dark'}
              </button>
            ))}
          </div>
        </Field>
        <Field label="Text & widget size" hint="Bigger works well on a wall tablet across the room.">
          <div className="seg">
            {(['sm', 'md', 'lg', 'xl'] as const).map((s) => (
              <button type="button" key={s} className={(theme.scale ?? 'md') === s ? 'on' : ''} onClick={() => onChange({ scale: s })}>
                {{ sm: 'Small', md: 'Normal', lg: 'Large', xl: 'Extra large' }[s]}
              </button>
            ))}
          </div>
        </Field>
        <Field label="Background">
          <div className="bg-choices">
            {BACKGROUNDS.map((b) => (
              <button type="button" key={b.value} className={`bg-choice home-bg-${b.value} ${(theme.background ?? 'plain') === b.value ? 'on' : ''}`} onClick={() => onChange({ background: b.value })}>
                {b.label}
              </button>
            ))}
          </div>
        </Field>
        <Field label="Spacing">
          <div className="seg">
            {(['cozy', 'compact'] as const).map((d) => (
              <button type="button" key={d} className={(theme.density ?? 'cozy') === d ? 'on' : ''} onClick={() => onChange({ density: d })}>
                {d === 'cozy' ? 'Roomy' : 'Compact'}
              </button>
            ))}
          </div>
        </Field>
      </div>
    </Modal>
  );
}

function OptionsModal({ widget, onChange, onClose }: { widget: Widget; onChange: (o: Widget['options']) => void; onClose: () => void }) {
  const spec = specFor(widget.type);
  const lists = useLists();
  const set = (key: string, value: string | number | boolean) => onChange({ ...(widget.options ?? {}), [key]: value });
  return (
    <Modal
      title={`${spec.label} options`}
      onClose={onClose}
      footer={
        <>
          <span className="spacer" />
          <button className="btn btn-primary" onClick={onClose}>
            Done
          </button>
        </>
      }
    >
      <div className="form">
        {(spec.options ?? []).map((o) => {
          const v = optionValue(widget, o.key);
          if (o.kind === 'bool')
            return (
              <label key={o.key} className="toggle">
                <input type="checkbox" checked={v !== false} onChange={(e) => set(o.key, e.target.checked)} /> {o.label}
              </label>
            );
          if (o.kind === 'select')
            return (
              <Field key={o.key} label={o.label}>
                <select className="input" value={String(v)} onChange={(e) => set(o.key, e.target.value)}>
                  {o.options!.map((x) => (
                    <option key={x.value} value={x.value}>
                      {x.label}
                    </option>
                  ))}
                </select>
              </Field>
            );
          if (o.kind === 'list')
            return (
              <Field key={o.key} label={o.label}>
                <select className="input" value={String(v ?? '')} onChange={(e) => set(o.key, e.target.value)}>
                  <option value="">First shopping list</option>
                  {(lists.data ?? []).map((l) => (
                    <option key={l.id} value={l.id}>
                      {l.emoji} {l.name}
                    </option>
                  ))}
                </select>
              </Field>
            );
          if (o.kind === 'textarea')
            return (
              <Field key={o.key} label={o.label}>
                <textarea className="input" rows={4} maxLength={500} value={String(v ?? '')} onChange={(e) => set(o.key, e.target.value)} />
              </Field>
            );
          return (
            <Field key={o.key} label={o.label}>
              <input className="input" maxLength={80} value={String(v ?? '')} onChange={(e) => set(o.key, e.target.value)} />
            </Field>
          );
        })}
      </div>
    </Modal>
  );
}
