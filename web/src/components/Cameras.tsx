import { useQuery } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import { CameraList, api } from '../lib/api';
import { useAuthStatus } from '../lib/hooks';
import { Icon } from './ui';

export function useCameras(enabled = true) {
  return useQuery({
    queryKey: ['cameras'],
    queryFn: () => api<CameraList>('/cameras'),
    enabled,
    staleTime: 60_000,
    refetchInterval: 5 * 60_000,
  });
}

/** Snapshot that refreshes every `seconds`, swapping only after the next image has loaded (no flicker). */
export function Snapshot({ cameraId, seconds, hq = false, className }: { cameraId: string; seconds: number; hq?: boolean; className?: string }) {
  const [src, setSrc] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const load = () => {
      if (document.hidden) {
        timer = setTimeout(load, 1000);
        return;
      }
      const next = `/api/cameras/${encodeURIComponent(cameraId)}/snapshot?${hq ? 'hq=1&' : ''}t=${Date.now()}`;
      const img = new Image();
      img.onload = () => {
        if (cancelled) return;
        setSrc(next);
        setFailed(false);
        timer = setTimeout(load, seconds * 1000);
      };
      img.onerror = () => {
        if (cancelled) return;
        setFailed(true);
        timer = setTimeout(load, Math.max(seconds, 10) * 1000);
      };
      img.src = next;
    };
    load();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [cameraId, seconds, hq]);

  if (!src) return <div className={`cam-placeholder ${className ?? ''}`}>{failed ? 'Camera unavailable' : 'Loading…'}</div>;
  return <img className={className} src={src} alt="" draggable={false} />;
}

/** Live video via the go2rtc player (MSE over a WebSocket proxied by FamilyHub). */
export function LiveVideo({ cameraId, className }: { cameraId: string; className?: string }) {
  const [player, setPlayer] = useState<string | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let cancelled = false;
    setPlayer(null);
    setError('');
    api<{ player: string }>(`/cameras/${encodeURIComponent(cameraId)}/live`, 'POST')
      .then((r) => !cancelled && setPlayer(r.player))
      .catch((e) => !cancelled && setError(e.message));
    return () => {
      cancelled = true;
    };
  }, [cameraId]);
  if (error) return <div className={`cam-placeholder ${className ?? ''}`}>{error}</div>;
  if (!player) return <div className={`cam-placeholder ${className ?? ''}`}>Connecting…</div>;
  return <iframe className={`cam-live ${className ?? ''}`} src={player} title="Live camera" allow="autoplay; fullscreen" />;
}

/** Home card: camera tiles in the chosen mode. */
export function CamerasCard() {
  const { data } = useCameras();
  const [open, setOpen] = useState<string | null>(null);
  if (!data?.enabled || data.mode === 'off') return null;
  const live = data.mode === 'live' && data.liveAvailable;
  const tapForLive = data.mode === 'snapshots_live' && data.liveAvailable;
  return (
    <section className="card cam-card">
      <div className="card-head">
        <h2>
          <Icon name="camera" size={18} /> Cameras
        </h2>
        {tapForLive && <span className="muted small">Tap a camera for live video</span>}
      </div>
      {data.error && <div className="alert">{data.error}</div>}
      <div className="cam-grid">
        {data.cameras.map((c) => (
          <button key={c.id} className="cam-tile" onClick={() => setOpen(c.id)} title={`Open ${c.name}`}>
            {live ? <LiveVideo cameraId={c.id} className="cam-media" /> : <Snapshot cameraId={c.id} seconds={data.snapshotSeconds} className="cam-media" />}
            <span className="cam-label">
              {c.state !== 'CONNECTED' && <span className="cam-offline">Offline · </span>}
              {c.name}
            </span>
            {live && <span className="cam-live-badge">LIVE</span>}
          </button>
        ))}
      </div>
      {open && (
        <CameraFullscreen
          cameraId={open}
          name={data.cameras.find((c) => c.id === open)?.name ?? ''}
          live={!!data.liveAvailable && data.mode !== 'snapshots'}
          snapshotSeconds={data.snapshotSeconds}
          onClose={() => setOpen(null)}
        />
      )}
    </section>
  );
}

export function CameraFullscreen({
  cameraId,
  name,
  live,
  snapshotSeconds,
  onClose,
  banner,
  countdown,
}: {
  cameraId: string;
  name: string;
  live: boolean;
  snapshotSeconds: number;
  onClose: () => void;
  banner?: string;
  countdown?: number;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="cam-full" role="dialog" aria-label={name}>
      <div className="cam-full-media">{live ? <LiveVideo cameraId={cameraId} /> : <Snapshot cameraId={cameraId} seconds={Math.min(snapshotSeconds, 2)} hq />}</div>
      <div className="cam-full-bar">
        <div>
          {banner && <div className="cam-full-banner">{banner}</div>}
          <div className="cam-full-name">
            {name}
            {live && <span className="cam-live-badge static">LIVE</span>}
          </div>
        </div>
        <span className="spacer" />
        {countdown !== undefined && <span className="cam-full-count">{countdown}s</span>}
        <button className="btn" onClick={onClose}>
          <Icon name="x" size={16} /> Close
        </button>
      </div>
    </div>
  );
}

/**
 * App-wide listener: when the doorbell rings, show that camera full screen for N seconds,
 * on top of everything (including the photo slideshow).
 */
export function DoorbellPopup() {
  const auth = useAuthStatus().data;
  const { data } = useCameras(!!auth?.user);
  const [ring, setRing] = useState<{ cameraId: string; until: number } | null>(null);
  const [now, setNow] = useState(Date.now());
  const dataRef = useRef(data);
  dataRef.current = data;
  const enabled = !!data?.enabled && !!data.doorbell?.enabled;

  useEffect(() => {
    if (!enabled) return;
    const es = new EventSource('/api/cameras/events');
    es.addEventListener('ring', (e) => {
      try {
        const ev = JSON.parse((e as MessageEvent).data) as { cameraId: string };
        const secs = dataRef.current?.doorbell?.seconds ?? 30;
        setRing({ cameraId: ev.cameraId, until: Date.now() + secs * 1000 });
        setNow(Date.now());
      } catch {
        /* ignore malformed events */
      }
    });
    return () => es.close();
  }, [enabled]);

  useEffect(() => {
    if (!ring) return;
    const t = setInterval(() => {
      const n = Date.now();
      setNow(n);
      if (n >= ring.until) setRing(null);
    }, 500);
    return () => clearInterval(t);
  }, [ring]);

  const close = useCallback(() => setRing(null), []);
  if (!ring || !data) return null;
  const cam = data.cameras.find((c) => c.id === ring.cameraId);
  return (
    <div className="doorbell-layer">
      <CameraFullscreen
        cameraId={ring.cameraId}
        name={cam?.name ?? 'Doorbell'}
        live={!!data.liveAvailable && data.mode !== 'snapshots'}
        snapshotSeconds={1}
        banner="🔔 Someone's at the door"
        countdown={Math.max(0, Math.ceil((ring.until - now) / 1000))}
        onClose={close}
      />
    </div>
  );
}
