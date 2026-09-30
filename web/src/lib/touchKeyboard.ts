/**
 * On-screen touch keyboard for kiosk screens that have no physical keyboard (FamilyHub OS on a
 * Raspberry Pi or PC with a touch screen).
 *
 * Framework-free: it watches for text boxes getting focus anywhere on the page and slides up a
 * keyboard. Typing goes through the element's native value setter plus an `input` event, so
 * React controlled inputs update like they do with a real keyboard.
 *
 * The same file is bundled for FamilyHub OS's on-device setup screen
 * (os/common/files/usr/share/familyhub/setup/keyboard.js, rebuilt with
 * `npm run build:os-keyboard` in web/).
 *
 * Opt a field out with data-osk="off" on it or on a parent.
 */

type Field = HTMLInputElement | HTMLTextAreaElement;
type Page = 'abc' | 'sym1' | 'sym2' | 'num';

const TEXT_TYPES = new Set(['text', 'search', 'email', 'url', 'tel', 'password', 'number', '']);
const STYLE_ID = 'fh-osk-style';

const CSS = `
.fh-osk { position: fixed; left: 0; right: 0; bottom: 0; z-index: 2147483000; background: #1d2230; color: #f5f7fb;
  padding: 8px max(8px, env(safe-area-inset-left)) calc(8px + env(safe-area-inset-bottom)) max(8px, env(safe-area-inset-right));
  box-shadow: 0 -8px 30px rgba(0,0,0,.35); font-family: system-ui, -apple-system, "Segoe UI", Roboto, "DejaVu Sans", sans-serif;
  user-select: none; -webkit-user-select: none; touch-action: none; transform: translateY(105%); transition: transform .16s ease-out; }
.fh-osk.is-open { transform: none; }
.fh-osk-inner { max-width: 1100px; margin: 0 auto; display: flex; flex-direction: column; gap: 7px; }
.fh-osk-row { display: flex; gap: 6px; justify-content: center; }
.fh-osk-key { flex: 1 1 0; min-width: 0; height: var(--fh-osk-key-h, 56px); border: 0; border-radius: 10px; background: #3a4154; color: inherit;
  font: inherit; font-size: 22px; font-weight: 500; display: flex; align-items: center; justify-content: center; padding: 0;
  box-shadow: 0 2px 0 rgba(0,0,0,.35); cursor: pointer; -webkit-tap-highlight-color: transparent; }
.fh-osk-key.is-special { background: #2a3040; font-size: 17px; font-weight: 650; }
.fh-osk-key.is-accent { background: #6366f1; color: #fff; }
.fh-osk-key.is-on { background: #e8ecf6; color: #1d2230; }
.fh-osk-key.is-down { filter: brightness(1.45); transform: translateY(1px); box-shadow: none; }
.fh-osk-key.w15 { flex-grow: 1.5; } .fh-osk-key.w2 { flex-grow: 2; } .fh-osk-key.w5 { flex-grow: 5.5; }
.fh-osk-row.is-half { padding: 0 5%; }
.fh-osk.is-num .fh-osk-inner { max-width: 520px; }
.fh-osk.is-num .fh-osk-key { font-size: 26px; }
.fh-osk svg { width: 26px; height: 26px; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
`;

const ICONS = {
  shift: '<svg viewBox="0 0 24 24"><path d="M12 4 3 13h5v7h8v-7h5z"/></svg>',
  caps: '<svg viewBox="0 0 24 24"><path d="M12 3 3 12h5v5h8v-5h5z"/><path d="M8 21h8"/></svg>',
  back: '<svg viewBox="0 0 24 24"><path d="M21 5H9l-6 7 6 7h12z"/><path d="m17 9-6 6M11 9l6 6"/></svg>',
  enter: '<svg viewBox="0 0 24 24"><path d="M20 5v7a3 3 0 0 1-3 3H5"/><path d="m9 11-4 4 4 4"/></svg>',
  hide: '<svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="11" rx="2"/><path d="M7 8h.01M11 8h.01M15 8h.01M8 12h8M9 18l3 3 3-3"/></svg>',
};

export interface TouchKeyboard {
  destroy(): void;
}

function isField(el: Element | null): el is Field {
  if (!el) return false;
  if (el instanceof HTMLTextAreaElement) return !el.readOnly && !el.disabled;
  if (el instanceof HTMLInputElement) return TEXT_TYPES.has(el.type) && !el.readOnly && !el.disabled;
  return false;
}

function optedOut(el: Element) {
  return !!el.closest('[data-osk="off"]');
}

function wantsNumberPad(el: Field) {
  const mode = (el.getAttribute('inputmode') || '').toLowerCase();
  if (mode === 'numeric' || mode === 'decimal' || mode === 'tel') return true;
  return el instanceof HTMLInputElement && (el.type === 'number' || el.type === 'tel');
}

function selection(el: Field): [number, number] {
  try {
    if (el.selectionStart != null) return [el.selectionStart, el.selectionEnd ?? el.selectionStart];
  } catch {
    /* email and number inputs don't expose the caret */
  }
  return [el.value.length, el.value.length];
}

function setValue(el: Field, value: string, caret?: number) {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
  if (caret != null) {
    try {
      el.setSelectionRange(caret, caret);
    } catch {
      /* not supported for this input type */
    }
  }
}

export function installTouchKeyboard(): TouchKeyboard {
  if (!document.getElementById(STYLE_ID)) {
    const s = document.createElement('style');
    s.id = STYLE_ID;
    s.textContent = CSS;
    document.head.appendChild(s);
  }
  const panel = document.createElement('div');
  panel.className = 'fh-osk';
  panel.setAttribute('role', 'group');
  panel.setAttribute('aria-label', 'On-screen keyboard');
  panel.dataset.osk = 'off';
  const inner = document.createElement('div');
  inner.className = 'fh-osk-inner';
  panel.appendChild(inner);
  document.body.appendChild(panel);

  let target: Field | null = null;
  let page: Page = 'abc';
  let shift: 'off' | 'once' | 'caps' = 'off';
  let lastShiftTap = 0;
  let pendingNumber: string | null = null;
  let hideTimer = 0;
  let repeat: { delay: number; interval: number } | null = null;

  const isOpen = () => panel.classList.contains('is-open');

  function autoShift() {
    if (!target || shift === 'caps') return;
    const cap = (target.getAttribute('autocapitalize') || '').toLowerCase();
    if (cap === 'characters') {
      shift = 'caps';
      return;
    }
    const type = target instanceof HTMLInputElement ? target.type : 'textarea';
    if (cap === 'off' || cap === 'none' || !['text', 'search', 'textarea', ''].includes(type)) {
      shift = 'off';
      return;
    }
    const before = target.value.slice(0, selection(target)[0]);
    shift = before.trim() === '' || /[.!?]\s+$/.test(before) || /\n$/.test(before) ? 'once' : 'off';
  }

  function insert(text: string) {
    const el = target;
    if (!el) return;
    if (el instanceof HTMLInputElement && el.type === 'number') {
      const buf = (pendingNumber ?? el.value) + text;
      if (buf !== '' && /^-?\d*\.?\d*$/.test(buf) && Number.isFinite(Number(buf)) && !/[.-]$/.test(buf)) {
        pendingNumber = null;
        setValue(el, buf);
      } else if (/^-?\d*\.?\d*$/.test(buf)) {
        pendingNumber = buf; // "3." or "-" isn't a number yet; wait for the next digit
      }
      return;
    }
    const [s, e] = selection(el);
    const v = el.value;
    const max = el.maxLength > 0 ? el.maxLength : Infinity;
    if (v.length - (e - s) + text.length > max) return;
    setValue(el, v.slice(0, s) + text + v.slice(e), s + text.length);
  }

  function backspace() {
    const el = target;
    if (!el) return;
    if (pendingNumber != null) {
      pendingNumber = pendingNumber.slice(0, -1) || null;
      return;
    }
    const [s, e] = selection(el);
    const v = el.value;
    if (s !== e) setValue(el, v.slice(0, s) + v.slice(e), s);
    else if (s > 0) {
      // Remove a whole emoji / surrogate pair, not half of one.
      const cut = /[\uDC00-\uDFFF]/.test(v[s - 1]) && s > 1 ? 2 : 1;
      setValue(el, v.slice(0, s - cut) + v.slice(s), s - cut);
    }
  }

  function enter() {
    const el = target;
    if (!el) return;
    if (el instanceof HTMLTextAreaElement) return insert('\n');
    const opts = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true } as KeyboardEventInit;
    const down = new KeyboardEvent('keydown', opts);
    el.dispatchEvent(down);
    el.dispatchEvent(new KeyboardEvent('keyup', opts));
    if (down.defaultPrevented) return;
    const form = el.form;
    if (form) {
      if (typeof form.requestSubmit === 'function') form.requestSubmit();
      else form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    } else {
      el.blur();
    }
  }

  function press(action: string) {
    const before = page + shift;
    if (action === 'shift') {
      const now = Date.now();
      if (shift === 'caps') shift = 'off';
      else if (shift === 'once' && now - lastShiftTap < 400) shift = 'caps';
      else shift = shift === 'once' ? 'off' : 'once';
      lastShiftTap = now;
    } else if (action === 'back') {
      backspace();
    } else if (action === 'enter') {
      enter();
    } else if (action === 'hide') {
      target?.blur();
      close();
      return;
    } else if (action.startsWith('page:')) {
      page = action.slice(5) as Page;
    } else if (action.startsWith('t:')) {
      let text = action.slice(2);
      if (page === 'abc' && shift !== 'off' && text.length === 1) text = text.toUpperCase();
      insert(text);
      if (shift === 'once') shift = 'off';
      if (text === ' ' || /[.!?]/.test(text)) autoShift();
    }
    // Only redraw when the layout changes, so the pressed key keeps its highlight.
    if (page + shift !== before) render();
  }

  function key(label: string, action: string, cls = '') {
    return `<button type="button" tabindex="-1" class="fh-osk-key ${cls}" data-k="${action.replace(/"/g, '&quot;')}">${label}</button>`;
  }
  const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
  const chars = (s: string) => [...s].map((c) => key(esc(c), 't:' + c)).join('');
  const row = (html: string, cls = '') => `<div class="fh-osk-row ${cls}">${html}</div>`;

  function render() {
    const el = target;
    const type = el instanceof HTMLInputElement ? el.type : 'textarea';
    const numeric = page === 'num';
    panel.classList.toggle('is-num', numeric);
    let html = '';
    if (numeric) {
      const decimal = (el?.getAttribute('inputmode') || '') === 'decimal' || type === 'number';
      const extra = type === 'tel' ? key('+', 't:+', 'is-special') : decimal ? key('.', 't:.', 'is-special') : key(ICONS.hide, 'hide', 'is-special');
      html =
        row(chars('123')) +
        row(chars('456')) +
        row(chars('789')) +
        row(extra + key('0', 't:0') + key(ICONS.back, 'back', 'is-special')) +
        row(key('ABC', 'page:abc', 'is-special') + key(ICONS.enter, 'enter', 'is-accent w2'));
    } else if (page === 'abc') {
      const up = shift !== 'off';
      const letters = (s: string) => [...s].map((c) => key(up ? c.toUpperCase() : c, 't:' + c)).join('');
      const shiftKey = key(shift === 'caps' ? ICONS.caps : ICONS.shift, 'shift', `is-special w15 ${up ? 'is-on' : ''}`);
      html =
        row(letters('qwertyuiop')) +
        row(letters('asdfghjkl'), 'is-half') +
        row(shiftKey + letters('zxcvbnm') + key(ICONS.back, 'back', 'is-special w15')) +
        bottomRow(type, '123', 'page:sym1');
    } else if (page === 'sym1') {
      html =
        row(chars('1234567890')) +
        row(chars('-/:;()$&@"')) +
        row(key('#+=', 'page:sym2', 'is-special w15') + chars(".,?!'") + key(ICONS.back, 'back', 'is-special w15')) +
        bottomRow(type, 'ABC', 'page:abc');
    } else {
      html =
        row(chars('[]{}#%^*+=')) +
        row(chars('_\\|~<>€£¥•')) +
        row(key('123', 'page:sym1', 'is-special w15') + chars(".,?!'") + key(ICONS.back, 'back', 'is-special w15')) +
        bottomRow(type, 'ABC', 'page:abc');
    }
    inner.innerHTML = html;
    // Key height: fit comfortably on landscape and portrait screens.
    const rows = numeric ? 5 : 4;
    const h = Math.max(44, Math.min(70, Math.round((window.innerHeight * (numeric ? 0.4 : 0.36)) / rows)));
    panel.style.setProperty('--fh-osk-key-h', `${h}px`);
    if (isOpen()) publishHeight();
  }

  function bottomRow(type: string, pageLabel: string, pageAction: string) {
    let mid = '';
    if (type === 'email') mid = key('@', 't:@', 'is-special') + key('space', 't: ', 'w5') + key('.', 't:.', 'is-special') + key('.com', 't:.com', 'is-special w15');
    else if (type === 'url') mid = key('/', 't:/', 'is-special') + key('space', 't: ', 'w5') + key('.', 't:.', 'is-special') + key('.com', 't:.com', 'is-special w15');
    else mid = key(',', 't:,', 'is-special') + key('space', 't: ', 'w5') + key('.', 't:.', 'is-special');
    const enterLabel = type === 'textarea' ? ICONS.enter : type === 'search' ? 'Search' : ICONS.enter;
    return row(key(pageLabel, pageAction, 'is-special w15') + mid + key(enterLabel, 'enter', 'is-accent w2') + key(ICONS.hide, 'hide', 'is-special'));
  }

  function publishHeight() {
    const h = panel.offsetHeight;
    document.documentElement.style.setProperty('--osk-h', `${h}px`);
    document.documentElement.classList.add('osk-open');
  }

  function open(el: Field) {
    clearTimeout(hideTimer);
    const changed = target !== el;
    target = el;
    if (changed) {
      pendingNumber = null;
      page = wantsNumberPad(el) ? 'num' : 'abc';
      shift = 'off';
      autoShift();
    }
    render();
    panel.classList.add('is-open');
    publishHeight();
    // Keep the field visible above the keyboard.
    requestAnimationFrame(() => {
      const r = el.getBoundingClientRect();
      const limit = window.innerHeight - panel.offsetHeight - 12;
      if (r.bottom > limit || r.top < 0) el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    });
  }

  function close() {
    target = null;
    pendingNumber = null;
    panel.classList.remove('is-open');
    document.documentElement.classList.remove('osk-open');
    document.documentElement.style.removeProperty('--osk-h');
  }

  const onFocusIn = (e: FocusEvent) => {
    const el = e.target as Element;
    if (isField(el) && !optedOut(el)) open(el);
  };
  const onFocusOut = () => {
    clearTimeout(hideTimer);
    hideTimer = window.setTimeout(() => {
      const a = document.activeElement;
      if (isField(a) && !optedOut(a)) open(a);
      else close();
    }, 60);
  };
  // Keep shift and page in step when the caret moves (e.g. tapping inside the text).
  const onSelect = () => {
    if (target && page === 'abc' && shift !== 'caps' && document.activeElement === target) {
      const before = shift;
      autoShift();
      if (before !== shift) render();
    }
  };

  const stopRepeat = () => {
    if (repeat) {
      clearTimeout(repeat.delay);
      clearInterval(repeat.interval);
      repeat = null;
    }
    panel.querySelectorAll('.is-down').forEach((k) => k.classList.remove('is-down'));
  };
  const onPointerDown = (e: PointerEvent) => {
    e.preventDefault(); // keep focus (and the caret) in the text box
    const k = (e.target as Element).closest<HTMLElement>('[data-k]');
    if (!k) return;
    const action = k.dataset.k!;
    k.classList.add('is-down');
    press(action);
    if (action === 'back') {
      stopRepeat();
      repeat = {
        delay: window.setTimeout(() => {
          if (repeat) repeat.interval = window.setInterval(() => backspace(), 70);
        }, 450),
        interval: 0,
      };
    } else {
      setTimeout(stopRepeat, 90);
    }
  };
  const onResize = () => isOpen() && render();

  document.addEventListener('focusin', onFocusIn);
  document.addEventListener('focusout', onFocusOut);
  document.addEventListener('selectionchange', onSelect);
  panel.addEventListener('pointerdown', onPointerDown);
  panel.addEventListener('mousedown', (e) => e.preventDefault());
  window.addEventListener('pointerup', stopRepeat);
  window.addEventListener('pointercancel', stopRepeat);
  window.addEventListener('resize', onResize);

  // A field may already have focus (autofocus) before we were installed.
  if (isField(document.activeElement) && !optedOut(document.activeElement)) open(document.activeElement);

  return {
    destroy() {
      close();
      document.removeEventListener('focusin', onFocusIn);
      document.removeEventListener('focusout', onFocusOut);
      document.removeEventListener('selectionchange', onSelect);
      window.removeEventListener('pointerup', stopRepeat);
      window.removeEventListener('pointercancel', stopRepeat);
      window.removeEventListener('resize', onResize);
      stopRepeat();
      panel.remove();
    },
  };
}

// ---- When to show it -------------------------------------------------------------------------

export type KeyboardMode = 'auto' | 'on' | 'off';
const MODE_KEY = 'fh.osk';
const OS_KEY = 'fh.os';

export function getKeyboardMode(): KeyboardMode {
  try {
    const v = localStorage.getItem(MODE_KEY);
    return v === 'on' || v === 'off' ? v : 'auto';
  } catch {
    return 'auto';
  }
}

export function setKeyboardMode(mode: KeyboardMode) {
  try {
    if (mode === 'auto') localStorage.removeItem(MODE_KEY);
    else localStorage.setItem(MODE_KEY, mode);
  } catch {
    /* storage blocked */
  }
  window.dispatchEvent(new Event('fh-osk-mode'));
}

/** True when this browser is a FamilyHub OS screen (its start page opens /kiosk?os=1). */
export function isFamilyHubOS(): boolean {
  try {
    if (new URLSearchParams(location.search).get('os') === '1') localStorage.setItem(OS_KEY, '1');
    return localStorage.getItem(OS_KEY) === '1';
  } catch {
    return false;
  }
}

/**
 * Auto: on for FamilyHub OS screens, and for kiosk screens on Linux touch screens. Phones,
 * tablets, Windows and Macs bring their own on-screen keyboards, so it stays off there unless
 * switched on for that device.
 */
export function keyboardWanted(mode: KeyboardMode, kiosk: boolean): boolean {
  if (mode !== 'auto') return mode === 'on';
  if (isFamilyHubOS()) return true;
  if (!kiosk) return false;
  const ua = navigator.userAgent;
  const touch = navigator.maxTouchPoints > 0 || !!window.matchMedia?.('(pointer: coarse)').matches;
  return touch && /Linux|CrOS/.test(ua) && !/Android/.test(ua);
}
