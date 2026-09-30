/*
 * FamilyHub OS on-screen setup. Talks to familyhub-setupd on this device (same origin).
 * First time: a step-by-step wizard (rotation, network, FamilyHub address, pairing code).
 * Afterwards (kiosk menu -> Screen settings): a settings menu.
 */
(function () {
  'use strict';
  const app = document.getElementById('app');
  const toastEl = document.getElementById('toast');
  if (window.FamilyHubKeyboard) window.FamilyHubKeyboard.installTouchKeyboard();

  const STEPS = ['rotate', 'network', 'address', 'code', 'finish'];
  const COUNTRIES = ['US', 'CA', 'GB', 'IE', 'AU', 'NZ', 'DE', 'FR', 'ES', 'IT', 'NL', 'BE', 'CH', 'AT', 'SE', 'NO', 'DK', 'FI', 'PL', 'PT',
    'MX', 'BR', 'AR', 'CL', 'CO', 'ZA', 'IN', 'JP', 'KR', 'SG', 'HK', 'TW', 'PH', 'MY', 'TH', 'AE', 'IL', 'TR', 'CZ', 'GR', 'RO', 'HU'];

  let S = null; // state from the device
  const ui = {
    mode: 'wizard', // 'wizard' | 'menu' | a section name when opened from the menu
    step: 'rotate',
    busy: '',
    error: '',
    nets: null,
    scanning: false,
    chosen: null, // { ssid, secure, security, hidden }
    password: '',
    showPw: false,
    country: 'US',
    url: '',
    checked: null, // result of /api/check
    code: '',
    tz: '',
    timezones: null,
    confirmLeft: 0,
  };

  // ---- helpers ------------------------------------------------------------------------------
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  async function api(path, body) {
    const r = await fetch('/api/' + path, body === undefined ? { cache: 'no-store' } : {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || 'Something went wrong (' + r.status + ')');
    return j;
  }
  let toastTimer = 0;
  function toast(msg) {
    toastEl.textContent = msg;
    toastEl.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove('show'), 3500);
  }
  function rotIcon(r) {
    const deg = { normal: 0, 90: 90, 180: 180, 270: 270 }[r];
    return `<svg viewBox="0 0 64 64" style="transform: rotate(${deg}deg)"><rect x="8" y="14" width="48" height="34" rx="5" fill="none" stroke="currentColor" stroke-width="3"/>` +
      `<path d="M22 56h20M32 48v8" stroke="currentColor" stroke-width="3" stroke-linecap="round"/><path d="M20 24h12" stroke="#818cf8" stroke-width="4" stroke-linecap="round"/></svg>`;
  }
  const rotLabel = (r) => ({ normal: 'Normal', 90: 'Turned right', 180: 'Upside down', 270: 'Turned left' })[r] || r;
  function bars(signal) {
    const n = signal > 75 ? 4 : signal > 50 ? 3 : signal > 25 ? 2 : 1;
    return `<span class="bars" aria-label="Signal ${signal}%">${[6, 10, 14, 18].map((h, i) => `<i style="height:${h}px" class="${i < n ? 'on' : ''}"></i>`).join('')}</span>`;
  }
  const netText = (n) => (n && n.connected ? (n.kind === 'wifi' ? `Wi-Fi: ${n.name}` : 'Network cable') + (n.ip ? ` · ${n.ip}` : '') : 'Not connected');

  // ---- loading ------------------------------------------------------------------------------
  async function load() {
    S = await api('state');
    ui.country = S.country || 'US';
    if (!ui.url) ui.url = S.url || '';
    if (!ui.tz) ui.tz = S.timezone || '';
    if (S.rotateReverted) toast('The screen rotation was undone.');
    if (S.rotateConfirmSeconds > 0) startConfirm(S.rotateConfirmSeconds);
    if (!loaded && S.url) ui.mode = 'menu'; // already set up: show the settings menu
    loaded = true;
  }
  let loaded = false;

  let confirmTimer = 0;
  function startConfirm(seconds) {
    ui.confirmLeft = seconds;
    clearInterval(confirmTimer);
    confirmTimer = setInterval(() => {
      ui.confirmLeft = Math.max(0, ui.confirmLeft - 1);
      const el = document.getElementById('confirm-left');
      if (el) el.textContent = String(ui.confirmLeft);
      if (!ui.confirmLeft) {
        clearInterval(confirmTimer);
        ui.busy = 'Putting the screen back…';
        render();
      }
    }, 1000);
  }

  async function scan() {
    if (!S.network.wifiDevice) return;
    ui.scanning = true;
    render();
    try {
      const r = await api('wifi');
      ui.nets = r.networks;
      if (r.error) ui.error = r.error;
    } catch (e) {
      ui.error = e.message;
    }
    ui.scanning = false;
    render();
  }

  // ---- views --------------------------------------------------------------------------------
  function header(title, sub) {
    const wizard = ui.mode === 'wizard';
    const idx = STEPS.indexOf(ui.step);
    return `<div class="top"><img src="icon.svg" alt=""><div class="grow"><h1>${esc(title)}</h1>${sub ? `<div class="muted small">${sub}</div>` : ''}</div></div>` +
      (wizard ? `<div class="steps">${STEPS.map((s, i) => `<span class="${i < idx ? 'done' : i === idx ? 'now' : ''}"></span>`).join('')}</div>` : '');
  }

  function nav(nextLabel, nextAction, opts) {
    opts = opts || {};
    const wizard = ui.mode === 'wizard';
    const back = wizard ? (ui.step !== 'rotate' ? `<button class="btn btn-ghost" data-a="prev">‹ Back</button>` : '') : `<button class="btn btn-ghost" data-a="menu">‹ Settings</button>`;
    const next = nextLabel ? `<button class="btn btn-primary" data-a="${nextAction}" ${opts.disabled ? 'disabled' : ''}>${nextLabel}</button>` : '';
    const skip = opts.skip ? `<button class="btn btn-ghost" data-a="${opts.skip[1]}">${opts.skip[0]}</button>` : '';
    return `<div class="row between" style="margin-top:8px">${back || '<span></span>'}<div class="row">${skip}${next}</div></div>`;
  }

  const errorBox = () => (ui.error ? `<div class="alert">${esc(ui.error)}</div>` : '');

  function viewRotate() {
    const wizard = ui.mode === 'wizard';
    return header(wizard ? 'Welcome to FamilyHub' : 'Screen rotation', wizard ? "Let's set up this screen. It only takes a minute." : '') +
      `<div class="card"><h2>Which way is the screen mounted?</h2><p class="muted small">Tap the picture that matches. The screen turns, then asks you to confirm.</p>
      <div class="rotations">${['normal', '90', '180', '270'].map((r) => `<button class="rot ${S.rotate === r ? 'on' : ''}" data-a="rotate" data-v="${r}">${rotIcon(r)}<span>${rotLabel(r)}</span></button>`).join('')}</div></div>` +
      errorBox() + (wizard ? nav('Next ›', 'next') : nav('', ''));
  }

  function viewNetwork() {
    const n = S.network;
    let body = `<div class="status ${n.connected ? 'good' : 'bad'}"><span class="dot"></span><span>${esc(netText(n))}</span></div>`;
    if (!n.wifiDevice) {
      body += `<p class="muted">This device has no Wi-Fi. Plug in a network cable.</p><button class="btn" data-a="refresh">Check again</button>`;
    } else if (ui.chosen) {
      const c = ui.chosen;
      body += `<h2>${c.hidden ? 'Other network' : esc(c.ssid)}</h2>` +
        (c.hidden ? `<div class="field"><label for="ssid">Network name</label><input id="ssid" class="input" autocomplete="off" autocapitalize="off" spellcheck="false" value="${esc(c.ssid)}"></div>` : '') +
        (c.secure || c.hidden ? `<div class="field"><label for="pw">Wi-Fi password</label><div class="pw"><input id="pw" class="input" type="${ui.showPw ? 'text' : 'password'}" autocomplete="off" autocapitalize="off" spellcheck="false" value="${esc(ui.password)}"><button type="button" data-a="showpw">${ui.showPw ? 'Hide' : 'Show'}</button></div></div>` : '<p class="muted small">This network has no password.</p>') +
        `<div class="field"><label for="country">Wi-Fi country</label><select id="country" class="input">${COUNTRIES.concat(COUNTRIES.includes(ui.country) ? [] : [ui.country]).map((c) => `<option ${c === ui.country ? 'selected' : ''}>${c}</option>`).join('')}</select></div>` +
        errorBox() +
        `<div class="row end"><button class="btn btn-ghost" data-a="unchoose">Cancel</button><button class="btn btn-primary" data-a="connect">Connect</button></div>`;
    } else {
      body += `<div class="row between"><h2 style="margin:0">Wi-Fi networks</h2><button class="btn btn-ghost" data-a="scan" ${ui.scanning ? 'disabled' : ''}>${ui.scanning ? 'Looking…' : '↻ Scan again'}</button></div>`;
      if (!ui.nets) body += `<div class="center" style="min-height:120px"><div class="spinner"></div></div>`;
      else {
        body += `<div class="nets">${ui.nets.map((w, i) => `<button class="net ${w.active ? 'active' : ''}" data-a="choose" data-v="${i}">${bars(w.signal)}<span class="name">${esc(w.ssid)}</span>${w.active ? '<span class="small" style="color:#6ee7b7">Connected</span>' : ''}${w.secure ? '<span class="lock">🔒</span>' : ''}</button>`).join('') || '<p class="muted">No networks found. Tap “Scan again”.</p>'}</div>` +
          `<button class="btn btn-ghost" data-a="other">+ Other network…</button>`;
      }
      body += errorBox();
    }
    const wizard = ui.mode === 'wizard';
    return header(wizard ? 'Connect to the internet' : 'Network', wizard ? 'Choose your Wi-Fi, or plug in a network cable.' : '') + `<div class="card">${body}</div>` +
      (ui.chosen ? '' : wizard ? nav('Next ›', 'next', { disabled: !n.connected, skip: n.connected ? null : ['Skip', 'next'] }) : nav('', ''));
  }

  function viewAddress() {
    const c = ui.checked;
    const wizard = ui.mode === 'wizard';
    const good = c && c.ok && c.url === normalize(ui.url);
    return header(wizard ? 'Your FamilyHub address' : 'FamilyHub address', 'The address you open FamilyHub at in a browser.') +
      `<div class="card"><div class="field"><label for="url">FamilyHub address</label><input id="url" class="input" type="url" inputmode="url" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="https://family.example.com" value="${esc(ui.url)}"></div>` +
      (good ? `<div class="ok">✓ Found ${esc(c.name || 'FamilyHub')}${c.timezone ? ` · time zone ${esc(c.timezone)}` : ''}</div>` : '') +
      (c && !c.ok ? `<div class="alert">${esc(c.error)}</div>` : '') +
      `<p class="muted small">It must work from this screen's network. If FamilyHub is only reachable over a VPN, use its address on your home network instead (for example http://192.168.1.20:8080).</p>` +
      `<div class="row end"><button class="btn" data-a="check" ${ui.url.trim() ? '' : 'disabled'}>Check address</button></div></div>` +
      (wizard
        ? nav('Next ›', good ? 'next' : 'check-next', { disabled: !ui.url.trim(), skip: c && !c.ok ? ['Use it anyway', 'next'] : null })
        : nav('Save', good ? 'save-url' : 'check-save', { disabled: !ui.url.trim(), skip: c && !c.ok ? ['Save anyway', 'save-url'] : null }));
  }

  function viewCode() {
    const wizard = ui.mode === 'wizard';
    return header(wizard ? 'Pair this screen' : 'Pair this screen again', '') +
      `<div class="card"><p>On your phone or computer, open FamilyHub and go to <strong>Settings → App settings → Kiosk screens → Add a screen</strong>. Type the code it shows here.</p>` +
      `<div class="field"><label for="code">Pairing code</label><input id="code" class="input code" autocomplete="off" autocapitalize="characters" spellcheck="false" maxlength="12" placeholder="ABCD-2345" value="${esc(ui.code)}"></div>` +
      (wizard ? `<p class="muted small">No code yet? Skip this step and type it on the FamilyHub screen instead.</p>` : `<p class="muted small">This signs the screen out of its current pairing and pairs it with the new code.</p>`) +
      `</div>` + errorBox() +
      (wizard ? nav('Next ›', 'next', { skip: ui.code ? null : ['Skip', 'next'] }) : nav('Pair', 'save-code', { disabled: !ui.code.trim() }));
  }

  function tzSelect() {
    const zones = ui.timezones || [ui.tz];
    const c = ui.checked;
    return `<div class="field"><label for="tz">Time zone</label><select id="tz" class="input">${zones.map((z) => `<option ${z === ui.tz ? 'selected' : ''}>${esc(z)}</option>`).join('')}</select></div>` +
      (c && c.ok && c.timezone && c.timezone !== ui.tz ? `<button class="btn btn-ghost" data-a="tz-hub">Use FamilyHub's time zone (${esc(c.timezone)})</button>` : '');
  }

  function viewFinish() {
    return header('All set!', 'Check everything, then start FamilyHub.') +
      `<div class="card stack">` +
      `<div class="row between"><span class="muted">Screen</span><strong>${rotLabel(S.rotate)}</strong></div>` +
      `<div class="row between"><span class="muted">Network</span><strong>${esc(netText(S.network))}</strong></div>` +
      `<div class="row between"><span class="muted">FamilyHub</span><strong>${esc(normalize(ui.url))}</strong></div>` +
      `<div class="row between"><span class="muted">Pairing code</span><strong>${ui.code ? esc(ui.code.toUpperCase()) : 'Enter it on the next screen'}</strong></div>` +
      tzSelect() + `</div>` + errorBox() + nav('Start FamilyHub', 'finish');
  }

  function viewTimezone() {
    return header('Time zone', '') + `<div class="card">${tzSelect()}</div>` + errorBox() + nav('Save', 'save-tz');
  }

  function viewMenu() {
    const item = (a, icon, title, value) =>
      `<button class="menu-item" data-a="open" data-v="${a}"><span class="icon">${icon}</span><span class="text"><div class="title">${title}</div><div class="value">${esc(value)}</div></span><span class="chev">›</span></button>`;
    return header('Screen settings', esc(S.hostname) + (S.network.ip ? ' · ' + esc(S.network.ip) : '')) +
      `<div class="menu">` +
      item('network', '📶', 'Network', netText(S.network)) +
      item('address', '🏠', 'FamilyHub address', S.url || 'Not set') +
      item('code', '🔗', 'Pair this screen again', 'Use a new pairing code') +
      item('rotate', '🔄', 'Screen rotation', rotLabel(S.rotate)) +
      item('timezone', '🕒', 'Time zone', S.timezone) +
      `</div>` + errorBox() +
      `<div class="row" style="margin-top:18px"><button class="btn btn-primary grow" data-a="done">Back to FamilyHub</button><button class="btn btn-danger" data-a="reboot">Restart device</button></div>`;
  }

  function render() {
    if (!S) return;
    const view = ui.mode === 'wizard' ? ui.step : ui.mode;
    const views = { rotate: viewRotate, network: viewNetwork, address: viewAddress, code: viewCode, finish: viewFinish, timezone: viewTimezone, menu: viewMenu };
    // Keep what's being typed and where the caret is while redrawing.
    const active = document.activeElement && document.activeElement.id;
    let caret = null;
    try {
      caret = active ? document.activeElement.selectionStart : null;
    } catch (e) {
      caret = null;
    }
    let html = (views[view] || viewMenu)();
    if (ui.confirmLeft > 0) {
      html += `<div class="overlay confirm"><h2>Is the screen the right way up?</h2><p class="muted">Tap <strong>Keep</strong> if the picture and touch both look right. Otherwise it goes back in <strong id="confirm-left">${ui.confirmLeft}</strong> seconds.</p>` +
        `<div class="row"><button class="btn" data-a="rotate-undo">Undo</button><button class="btn btn-primary" data-a="rotate-keep">Keep</button></div></div>`;
    } else if (ui.busy) {
      html += `<div class="overlay"><div class="spinner"></div><h2>${esc(ui.busy)}</h2></div>`;
    }
    app.innerHTML = html;
    if (active) {
      const el = document.getElementById(active);
      if (el && el.focus) {
        el.focus({ preventScroll: true });
        try {
          if (caret != null) el.setSelectionRange(caret, caret);
        } catch (e) {
          /* not a text field */
        }
      }
    }
  }

  function normalize(u) {
    u = (u || '').trim().replace(/\s+/g, '');
    if (!u) return '';
    if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
    return u.replace(/\/kiosk\/*$/, '').replace(/\/+$/, '');
  }

  // ---- actions ------------------------------------------------------------------------------
  async function go(step) {
    ui.error = '';
    ui.step = step;
    render();
    if (step === 'network' && !ui.nets) scan();
    if ((step === 'finish' || step === 'timezone') && !ui.timezones) {
      try {
        ui.timezones = (await api('timezones')).timezones;
        if (!ui.timezones.includes(ui.tz)) ui.timezones.unshift(ui.tz);
      } catch (e) {
        ui.timezones = [ui.tz];
      }
      render();
    }
    const first = app.querySelector('input.input');
    if (first && (step === 'address' || step === 'code')) first.focus();
  }

  async function check() {
    ui.busy = 'Looking for FamilyHub…';
    render();
    try {
      ui.checked = await api('check', { url: ui.url });
      if (ui.checked.ok) {
        ui.url = ui.checked.url;
        if (ui.checked.timezone && (ui.mode === 'wizard' || !ui.tz)) ui.tz = ui.checked.timezone;
      }
    } catch (e) {
      ui.checked = { ok: false, error: e.message };
    }
    ui.busy = '';
    render();
    return ui.checked.ok;
  }

  async function restartingTo(msg, body, path) {
    ui.busy = msg;
    render();
    try {
      await api(path || 'save', body);
    } catch (e) {
      ui.busy = '';
      ui.error = e.message;
      render();
    }
  }

  const actions = {
    prev() {
      go(STEPS[Math.max(0, STEPS.indexOf(ui.step) - 1)]);
    },
    next() {
      go(STEPS[Math.min(STEPS.length - 1, STEPS.indexOf(ui.step) + 1)]);
    },
    async 'check-next'() {
      if (await check()) actions.next();
    },
    check,
    menu() {
      ui.mode = 'menu';
      ui.error = '';
      ui.chosen = null;
      render();
    },
    open(v) {
      ui.mode = v;
      ui.error = '';
      ui.checked = null;
      if (v === 'address') ui.url = S.url;
      if (v === 'code') ui.code = '';
      go(v);
    },
    async rotate(v) {
      if (v === S.rotate) return;
      ui.busy = 'Turning the screen…';
      render();
      try {
        const r = await api('rotate', { rotate: v });
        if (r.unchanged) {
          ui.busy = '';
          render();
        }
      } catch (e) {
        ui.busy = '';
        ui.error = e.message;
        render();
      }
    },
    async 'rotate-keep'() {
      clearInterval(confirmTimer);
      ui.confirmLeft = 0;
      render();
      try {
        await api('rotate/keep', {});
        toast('Screen rotation saved');
      } catch (e) {
        ui.error = e.message;
        render();
      }
    },
    async 'rotate-undo'() {
      clearInterval(confirmTimer);
      ui.confirmLeft = 0;
      ui.busy = 'Putting the screen back…';
      render();
      await api('rotate/undo', {}).catch(() => {});
    },
    scan,
    refresh: async () => {
      await load();
      render();
    },
    choose(v) {
      const n = ui.nets[Number(v)];
      if (!n) return;
      ui.chosen = { ssid: n.ssid, secure: n.secure, security: n.security, hidden: false };
      ui.password = '';
      ui.error = '';
      render();
      if (n.secure) document.getElementById('pw').focus();
    },
    other() {
      ui.chosen = { ssid: '', secure: true, security: '', hidden: true };
      ui.password = '';
      ui.error = '';
      render();
      document.getElementById('ssid').focus();
    },
    unchoose() {
      ui.chosen = null;
      ui.error = '';
      render();
    },
    showpw() {
      ui.showPw = !ui.showPw;
      render();
    },
    async connect() {
      const c = ui.chosen;
      if (!c.ssid.trim()) {
        ui.error = 'Type the network name.';
        return render();
      }
      document.activeElement && document.activeElement.blur && document.activeElement.blur();
      ui.busy = `Connecting to ${c.ssid}…`;
      ui.error = '';
      render();
      try {
        const r = await api('wifi', { ssid: c.ssid.trim(), password: ui.password, hidden: c.hidden, country: ui.country, security: c.security });
        if (!r.ok) throw new Error(r.error);
        ui.chosen = null;
        ui.nets = null;
        await load();
        toast(`Connected to ${c.ssid}`);
        if (ui.mode === 'wizard') {
          ui.busy = '';
          return go('address');
        }
        scan();
      } catch (e) {
        ui.error = e.message;
      }
      ui.busy = '';
      render();
    },
    async 'check-save'() {
      if (await check()) actions['save-url']();
    },
    'save-url'() {
      restartingTo('Opening FamilyHub…', { url: ui.url, timezone: ui.checked && ui.checked.ok ? ui.checked.timezone : '' });
    },
    'save-code'() {
      restartingTo('Pairing this screen…', { code: ui.code });
    },
    'tz-hub'() {
      ui.tz = ui.checked.timezone;
      render();
    },
    async 'save-tz'() {
      try {
        await api('save', { timezone: ui.tz, restart: false });
        await load();
        toast('Time zone saved');
        actions.menu();
      } catch (e) {
        ui.error = e.message;
        render();
      }
    },
    finish() {
      if (!normalize(ui.url)) {
        ui.error = 'Enter your FamilyHub address first.';
        return go('address');
      }
      restartingTo('Starting FamilyHub…', { url: ui.url, code: ui.code, timezone: ui.tz });
    },
    done() {
      restartingTo('Opening FamilyHub…', {}, 'done');
    },
    reboot() {
      const b = app.querySelector('[data-a="reboot"]');
      if (!b.dataset.sure) {
        b.dataset.sure = '1';
        b.textContent = 'Tap again to restart';
        setTimeout(() => {
          if (b.isConnected) {
            delete b.dataset.sure;
            b.textContent = 'Restart device';
          }
        }, 4000);
        return;
      }
      restartingTo('Restarting…', {}, 'reboot');
    },
  };

  app.addEventListener('click', (e) => {
    const b = e.target.closest('[data-a]');
    if (!b || b.disabled) return;
    const fn = actions[b.dataset.a];
    if (fn) fn(b.dataset.v);
  });
  app.addEventListener('input', (e) => {
    const t = e.target;
    if (t.id === 'url') {
      ui.url = t.value;
      if (ui.checked) {
        ui.checked = null; // the address changed: check it again
        return render();
      }
      const btns = app.querySelectorAll('[data-a="check"], [data-a="check-next"], [data-a="next"], [data-a="check-save"]');
      btns.forEach((b) => (b.disabled = !t.value.trim()));
    } else if (t.id === 'pw') ui.password = t.value;
    else if (t.id === 'ssid') ui.chosen.ssid = t.value;
    else if (t.id === 'code') {
      const v = t.value.toUpperCase().replace(/[^A-Z0-9-]/g, '');
      if (v !== t.value) t.value = v;
      ui.code = v;
    }
  });
  app.addEventListener('change', (e) => {
    if (e.target.id === 'country') ui.country = e.target.value;
    if (e.target.id === 'tz') ui.tz = e.target.value;
  });
  // Enter on the keyboard does the obvious thing for each field.
  app.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    const id = e.target.id;
    e.preventDefault();
    if (id === 'pw' || id === 'ssid') actions.connect();
    else if (id === 'url') (ui.mode === 'wizard' ? actions['check-next'] : actions['check-save'])();
    else if (id === 'code') (ui.mode === 'wizard' ? actions.next : ui.code ? actions['save-code'] : () => {})();
  });

  (async function start() {
    for (let i = 0; ; i++) {
      try {
        await load();
        break;
      } catch (e) {
        app.innerHTML = `<div class="center"><div class="spinner"></div><p class="muted">Starting setup…</p></div>`;
        await new Promise((r) => setTimeout(r, Math.min(5000, 1000 + i * 500)));
      }
    }
    if (ui.mode === 'wizard') go(ui.step);
    else render();
    // Keep the network status fresh on the settings screens.
    setInterval(async () => {
      if (ui.busy || ui.chosen || document.activeElement && document.activeElement.tagName === 'INPUT') return;
      try {
        const before = JSON.stringify(S.network);
        S = Object.assign(S, { network: (await api('state')).network });
        if (JSON.stringify(S.network) !== before) render();
      } catch (e) {
        /* the device may be restarting the screen */
      }
    }, 10000);
  })();
})();
