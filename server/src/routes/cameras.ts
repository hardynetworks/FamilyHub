import { Router } from 'express';
import { z } from 'zod';
import { UserRow } from '../auth';
import { camerasConfig, cameraEvents, ensureLiveStream, getSnapshot, isRegisteredStream, protectConfig, visibleCameras } from '../protect';
import { HttpError, parse } from '../util';

export const camerasRouter = Router();

function effectiveMode(user: UserRow) {
  const pref = user.prefs?.camerasMode;
  return pref && pref !== 'default' ? pref : camerasConfig().mode;
}

camerasRouter.get('/', async (req, res) => {
  const pc = protectConfig();
  const cc = camerasConfig();
  const doorbell = { enabled: cc.doorbellEnabled && req.user!.prefs?.doorbellPopup !== false, seconds: cc.doorbellSeconds };
  if (!pc.enabled) return res.json({ enabled: false, cameras: [], doorbell: { ...doorbell, enabled: false } });
  const base = { enabled: true, mode: effectiveMode(req.user!), snapshotSeconds: cc.snapshotSeconds, liveAvailable: !!cc.go2rtcUrl, doorbell };
  try {
    res.json({ ...base, cameras: await visibleCameras() });
  } catch (e: any) {
    res.json({ ...base, cameras: [], error: e.message });
  }
});

/** Server-sent events: doorbell rings, pushed to every open FamilyHub screen. */
camerasRouter.get('/events', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform', // no-transform: skip the compression middleware
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 5000\n\n');
  const onRing = (ev: { cameraId: string; at: string }) => {
    if (req.user!.prefs?.doorbellPopup === false) return;
    res.write(`event: ring\ndata: ${JSON.stringify(ev)}\n\n`);
  };
  cameraEvents.on('ring', onRing);
  const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
  req.on('close', () => {
    clearInterval(ping);
    cameraEvents.off('ring', onRing);
  });
});

camerasRouter.get('/:id/snapshot', async (req, res) => {
  if (!protectConfig().enabled) throw new HttpError(404, 'Cameras are not set up');
  const { hq } = parse(z.object({ hq: z.string().optional() }), req.query);
  const snap = await getSnapshot(String(req.params.id), hq === '1');
  res.setHeader('Content-Type', snap.type);
  res.setHeader('Cache-Control', 'private, no-store');
  res.end(snap.body);
});

/** Prepare live video and return the player URL (served through the authenticated /go2rtc proxy). */
camerasRouter.post('/:id/live', async (req, res) => {
  if (!protectConfig().enabled) throw new HttpError(404, 'Cameras are not set up');
  if (!camerasConfig().go2rtcUrl) throw new HttpError(400, 'Live video is not set up (no go2rtc URL)');
  const name = await ensureLiveStream(String(req.params.id));
  res.json({ player: `/go2rtc/stream.html?src=${encodeURIComponent(name)}&mode=mse` });
});

// ---------------- Authenticated, allow-listed proxy to go2rtc's web player ----------------

const PLAYER_FILES = new Set(['stream.html', 'video-stream.js', 'video-rtc.js']);

export const go2rtcRouter = Router();

go2rtcRouter.get('/:file', async (req, res) => {
  const file = String(req.params.file);
  if (!PLAYER_FILES.has(file)) throw new HttpError(404, 'Not found');
  if (file === 'stream.html') {
    const src = String(req.query.src ?? '');
    if (!isRegisteredStream(src)) throw new HttpError(404, 'Unknown stream');
  }
  const base = camerasConfig().go2rtcUrl;
  let r: globalThis.Response;
  try {
    r = await fetch(`${base}/${file}`, { signal: AbortSignal.timeout(8000) });
  } catch (e: any) {
    throw new HttpError(502, `Live video relay (go2rtc) is not reachable: ${e.cause?.code ?? e.message}`);
  }
  if (!r.ok) throw new HttpError(502, `go2rtc returned HTTP ${r.status}`);
  res.setHeader('Content-Type', r.headers.get('content-type') ?? (file.endsWith('.js') ? 'text/javascript' : 'text/html'));
  res.setHeader('Cache-Control', 'private, max-age=300');
  res.send(Buffer.from(await r.arrayBuffer()));
});
