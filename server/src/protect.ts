/**
 * UniFi Protect cameras via the official Protect Integration API (Protect 5.3+ / UniFi OS),
 * authenticated with an API key (X-API-KEY) created in the Protect/UniFi console.
 *
 *   GET  /proxy/protect/integration/v1/cameras                  camera list
 *   GET  /proxy/protect/integration/v1/cameras/{id}/snapshot    JPEG snapshot
 *   GET  /proxy/protect/integration/v1/cameras/{id}/rtsps-stream   existing RTSPS URLs
 *   POST /proxy/protect/integration/v1/cameras/{id}/rtsps-stream   create RTSPS URLs {qualities:[...]}
 *   WSS  /proxy/protect/integration/v1/subscribe/events          events (doorbell "ring", motion, ...)
 *
 * Live video: browsers can't play RTSPS, so live view goes through a go2rtc container. FamilyHub
 * registers each camera's RTSPS stream with go2rtc and proxies go2rtc's player (MSE over WebSocket)
 * to signed-in users only (see routes/cameras.ts). go2rtc itself is never exposed.
 *
 * UniFi consoles use self-signed certificates, so TLS verification is off unless enabled in settings.
 */
import { EventEmitter } from 'events';
import http from 'http';
import https from 'https';
import WebSocket from 'ws';
import { getSetting, onSettingsChange } from './settings';
import { HttpError } from './util';

const API_PREFIX = '/proxy/protect/integration/v1';

export interface ProtectConfig {
  url: string;
  apiKey: string;
  verifyTls: boolean;
}

export function protectConfig(): ProtectConfig & { enabled: boolean } {
  const url = getSetting('protectUrl').trim().replace(/\/+$/, '');
  const apiKey = getSetting('protectApiKey');
  return { url, apiKey, verifyTls: getSetting('protectVerifyTls'), enabled: !!(url && apiKey) };
}

export function camerasConfig() {
  const mode = getSetting('camerasMode');
  return {
    mode: ['off', 'snapshots', 'live', 'snapshots_live'].includes(mode) ? mode : 'snapshots_live',
    selected: getSetting('camerasSelected')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    snapshotSeconds: Math.min(60, Math.max(1, getSetting('camerasSnapshotSeconds') || 5)),
    liveQuality: ['high', 'medium', 'low'].includes(getSetting('camerasLiveQuality')) ? getSetting('camerasLiveQuality') : 'medium',
    go2rtcUrl: getSetting('go2rtcUrl').trim().replace(/\/+$/, ''),
    doorbellEnabled: getSetting('doorbellPopupEnabled'),
    doorbellSeconds: Math.min(300, Math.max(5, getSetting('doorbellPopupSeconds') || 30)),
  };
}

// ---------------- HTTP helper (supports self-signed certificates) ----------------

interface RawResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
}

function request(cfg: ProtectConfig, path: string, opts: { method?: string; body?: unknown; timeoutMs?: number } = {}): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    let url: URL;
    try {
      url = new URL(cfg.url + API_PREFIX + path);
    } catch {
      return reject(new HttpError(400, 'Invalid UniFi console URL'));
    }
    const lib = url.protocol === 'http:' ? http : https;
    const payload = opts.body !== undefined ? Buffer.from(JSON.stringify(opts.body)) : undefined;
    const req = lib.request(
      url,
      {
        method: opts.method ?? 'GET',
        headers: {
          'X-API-KEY': cfg.apiKey,
          Accept: 'application/json, image/jpeg, */*',
          ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {}),
        },
        rejectUnauthorized: cfg.verifyTls,
        timeout: opts.timeoutMs ?? 10_000,
      } as https.RequestOptions,
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
        res.on('error', reject);
      },
    );
    req.on('timeout', () => req.destroy(new Error('timed out')));
    req.on('error', (e: any) => reject(new HttpError(502, `Can't reach UniFi console: ${e.code ?? e.message}`)));
    if (payload) req.write(payload);
    req.end();
  });
}

async function protectJson<T = any>(cfg: ProtectConfig, path: string, method = 'GET', body?: unknown): Promise<T> {
  const r = await request(cfg, path, { method, body });
  if (r.status === 401 || r.status === 403) throw new HttpError(502, 'UniFi Protect rejected the API key');
  if (r.status === 404) throw new HttpError(502, 'UniFi Protect API not found at this address (Protect 5.3 or newer is required)');
  if (r.status >= 400) throw new HttpError(502, `UniFi Protect returned HTTP ${r.status}`);
  try {
    return JSON.parse(r.body.toString('utf8'));
  } catch {
    throw new HttpError(502, 'UniFi Protect returned an unexpected response (is this the console address?)');
  }
}

// ---------------- Cameras ----------------

export interface CameraInfo {
  id: string;
  name: string;
  state: string;
  model: string | null;
  isDoorbell: boolean;
}

let cameraCache: { at: number; list: CameraInfo[] } | null = null;
onSettingsChange(() => {
  cameraCache = null;
  registered.clear();
  restartEvents();
});

function toCameraInfo(c: any): CameraInfo {
  const model = c.modelKey === 'camera' ? (c.marketName ?? c.type ?? null) : (c.marketName ?? null);
  const flags = c.featureFlags ?? {};
  return {
    id: String(c.id),
    name: c.name || c.displayName || 'Camera',
    state: c.state ?? 'UNKNOWN',
    model,
    isDoorbell: !!(c.isDoorbell ?? flags.isDoorbell ?? /doorbell|g4 db|g6 entry|dbpro/i.test(String(model ?? ''))),
  };
}

export async function listCameras(cfg: ProtectConfig = protectConfig(), useCache = true): Promise<CameraInfo[]> {
  if (useCache && cameraCache && Date.now() - cameraCache.at < 60_000) return cameraCache.list;
  const raw = await protectJson<any[]>(cfg, '/cameras');
  const list = (Array.isArray(raw) ? raw : []).map(toCameraInfo).sort((a, b) => a.name.localeCompare(b.name));
  if (useCache) cameraCache = { at: Date.now(), list };
  return list;
}

/** Cameras to show on Home: admin's selection and order, or all cameras. */
export async function visibleCameras(): Promise<CameraInfo[]> {
  const all = await listCameras();
  const sel = camerasConfig().selected;
  if (!sel.length) return all;
  const byId = new Map(all.map((c) => [c.id, c]));
  return sel.map((id) => byId.get(id)).filter((c): c is CameraInfo => !!c);
}

export async function assertCamera(id: string): Promise<CameraInfo> {
  const cam = (await listCameras()).find((c) => c.id === id);
  if (!cam) throw new HttpError(404, 'Camera not found');
  return cam;
}

// Snapshots: short cache + in-flight de-duplication so many screens don't hammer the console.
const snapCache = new Map<string, { at: number; type: string; body: Buffer }>();
const snapInflight = new Map<string, Promise<{ type: string; body: Buffer }>>();

export async function getSnapshot(id: string, highQuality = false): Promise<{ type: string; body: Buffer }> {
  await assertCamera(id);
  const key = `${id}:${highQuality ? 'hq' : 'lq'}`;
  const hit = snapCache.get(key);
  if (hit && Date.now() - hit.at < 1500) return hit;
  let p = snapInflight.get(key);
  if (!p) {
    p = (async () => {
      const r = await request(protectConfig(), `/cameras/${encodeURIComponent(id)}/snapshot${highQuality ? '?highQuality=true' : ''}`, { timeoutMs: 15_000 });
      if (r.status >= 400 || !String(r.headers['content-type'] ?? '').startsWith('image/')) {
        throw new HttpError(502, `Snapshot failed (HTTP ${r.status})`);
      }
      const v = { type: String(r.headers['content-type']), body: r.body };
      snapCache.set(key, { at: Date.now(), ...v });
      return v;
    })().finally(() => snapInflight.delete(key));
    snapInflight.set(key, p);
  }
  return p;
}

// ---------------- Live video through go2rtc ----------------

const registered = new Map<string, number>(); // go2rtc stream name -> registered at

export const streamName = (cameraId: string) => `cam_${cameraId.replace(/[^A-Za-z0-9_-]/g, '')}`;

export function isRegisteredStream(name: string) {
  return registered.has(name);
}

async function rtspsUrl(id: string, quality: string): Promise<string> {
  const cfg = protectConfig();
  const path = `/cameras/${encodeURIComponent(id)}/rtsps-stream`;
  let streams: any = await protectJson(cfg, path).catch(() => ({}));
  if (!streams?.[quality]) {
    // Create the stream (enables RTSPS for that quality on the camera).
    streams = await protectJson(cfg, path, 'POST', { qualities: [quality] });
  }
  const url: string | undefined = streams?.[quality] ?? streams?.high ?? streams?.medium ?? streams?.low;
  if (!url) throw new HttpError(502, 'UniFi Protect did not return a stream URL for this camera');
  return url;
}

/** Make sure go2rtc knows about this camera; returns the go2rtc stream name. */
export async function ensureLiveStream(id: string): Promise<string> {
  await assertCamera(id);
  const cc = camerasConfig();
  const name = streamName(id);
  const at = registered.get(name);
  if (at && Date.now() - at < 10 * 60_000) return name;
  const rtsps = await rtspsUrl(id, cc.liveQuality);
  // go2rtc: rtspx:// = RTSPS without certificate checks; drop Protect's ?enableSrtp suffix.
  const src = rtsps.replace(/^rtsps:\/\//i, 'rtspx://').replace(/\?enableSrtp$/i, '');
  let r: globalThis.Response;
  try {
    r = await fetch(`${cc.go2rtcUrl}/api/streams?name=${encodeURIComponent(name)}&src=${encodeURIComponent(src)}`, {
      method: 'PUT',
      signal: AbortSignal.timeout(8000),
    });
  } catch (e: any) {
    throw new HttpError(502, `Live video relay (go2rtc) is not reachable at ${cc.go2rtcUrl}: ${e.cause?.code ?? e.message}`);
  }
  if (!r.ok) throw new HttpError(502, `go2rtc refused the stream (HTTP ${r.status})`);
  registered.set(name, Date.now());
  return name;
}

export async function go2rtcReachable(url = camerasConfig().go2rtcUrl): Promise<boolean> {
  try {
    const r = await fetch(`${url}/api`, { signal: AbortSignal.timeout(4000) });
    return r.ok;
  } catch {
    return false;
  }
}

// ---------------- Doorbell events ----------------

export const cameraEvents = new EventEmitter();
cameraEvents.setMaxListeners(200);

let ws: WebSocket | null = null;
let reconnectTimer: NodeJS.Timeout | null = null;
let backoff = 5_000;
let stopped = true;
const seenEvents = new Map<string, number>();

function handleMessage(raw: WebSocket.RawData) {
  let msg: any;
  try {
    msg = JSON.parse(raw.toString());
  } catch {
    return;
  }
  // Two envelope shapes are seen in the wild: {type:'add', item:{type:'ring', device}} and {type:'ring', device}.
  const item = msg?.item && typeof msg.item === 'object' ? msg.item : msg;
  if (item?.type !== 'ring') return;
  if (msg?.type && msg.type !== 'add' && msg.item) return; // ignore "update" of an existing ring event
  const cameraId = String(item.device ?? item.camera ?? item.cameraId ?? '');
  if (!cameraId) return;
  const evId = String(item.id ?? `${cameraId}:${item.start ?? Date.now()}`);
  if (seenEvents.has(evId)) return;
  seenEvents.set(evId, Date.now());
  for (const [k, t] of seenEvents) if (Date.now() - t > 10 * 60_000) seenEvents.delete(k);
  cameraEvents.emit('ring', { cameraId, at: new Date().toISOString() });
}

function connectEvents() {
  const cfg = protectConfig();
  if (stopped || !cfg.enabled || !camerasConfig().doorbellEnabled) return;
  const url = cfg.url.replace(/^http/i, 'ws') + API_PREFIX + '/subscribe/events';
  ws = new WebSocket(url, { headers: { 'X-API-KEY': cfg.apiKey }, rejectUnauthorized: cfg.verifyTls, handshakeTimeout: 10_000 });
  ws.on('open', () => {
    backoff = 5_000;
    console.log('UniFi Protect: listening for doorbell events');
  });
  ws.on('message', handleMessage);
  ws.on('error', (e) => console.warn(`UniFi Protect events: ${e.message}`));
  ws.on('close', () => {
    ws = null;
    if (stopped) return;
    reconnectTimer = setTimeout(connectEvents, backoff);
    backoff = Math.min(backoff * 2, 5 * 60_000);
  });
}

export function startEvents() {
  stopped = false;
  connectEvents();
}

function restartEvents() {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = null;
  backoff = 5_000;
  const old = ws;
  ws = null;
  if (old) {
    old.removeAllListeners('close');
    old.terminate();
  }
  if (!stopped) setTimeout(connectEvents, 500);
}
