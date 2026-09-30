import { useQuery } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import { PhotoList, api } from '../lib/api';
import { fmt, fmtTime } from '../lib/dates';
import { useMe } from '../lib/hooks';
import { SlideWeather } from './Weather';

export function usePhotos(enabled = true) {
  return useQuery({
    queryKey: ['photos'],
    queryFn: () => api<PhotoList>('/photos'),
    enabled,
    staleTime: 10 * 60_000,
    refetchInterval: 30 * 60_000,
  });
}

function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

const ACTIVITY_EVENTS = ['pointermove', 'pointerdown', 'keydown', 'wheel', 'touchstart', 'scroll'] as const;

/**
 * Starts a full-screen photo slideshow after the user's idle time (Settings → Photo slideshow).
 * Mounted on the Home page only. Any touch, click, key or mouse movement closes it.
 */
export function IdleSlideshow({ startSignal }: { startSignal?: number }) {
  const me = useMe();
  const enabled = me.prefs.slideshowEnabled;
  const idleMs = Math.max(1, me.prefs.slideshowIdleMinutes) * 60_000;
  const photos = usePhotos(enabled);
  const [active, setActive] = useState(false);
  const lastActivity = useRef(Date.now());
  const hasPhotos = !!photos.data?.enabled && (photos.data?.photos.length ?? 0) > 0;

  // Manual start (the "Photos" button on Home).
  useEffect(() => {
    if (startSignal && hasPhotos) setActive(true);
  }, [startSignal, hasPhotos]);

  useEffect(() => {
    if (!enabled || !hasPhotos) return;
    let lastMove = 0;
    const onActivity = (e: Event) => {
      // Ignore tiny pointer jitter so a mouse resting on a desk doesn't keep the page awake.
      if (e.type === 'pointermove') {
        const now = Date.now();
        if (now - lastMove < 250) return;
        lastMove = now;
      }
      lastActivity.current = Date.now();
    };
    ACTIVITY_EVENTS.forEach((ev) => window.addEventListener(ev, onActivity, { passive: true }));
    const timer = setInterval(() => {
      if (!document.hidden && Date.now() - lastActivity.current >= idleMs) setActive(true);
    }, 3000);
    return () => {
      ACTIVITY_EVENTS.forEach((ev) => window.removeEventListener(ev, onActivity));
      clearInterval(timer);
    };
  }, [enabled, hasPhotos, idleMs]);

  const close = useCallback(() => {
    lastActivity.current = Date.now();
    setActive(false);
  }, []);

  if (!active || !hasPhotos) return null;
  return <SlideshowOverlay photos={photos.data!.photos} slideSeconds={photos.data!.slideSeconds} onClose={close} />;
}

function SlideshowOverlay({ photos, slideSeconds, onClose }: { photos: PhotoList['photos']; slideSeconds: number; onClose: () => void }) {
  const [order] = useState(() => shuffle(photos));
  const [index, setIndex] = useState(0);
  const [layers, setLayers] = useState<{ key: number; src: string; takenAt: string | null }[]>([]);
  const [now, setNow] = useState(new Date());
  const openedAt = useRef(Date.now());

  const srcFor = (i: number) => `/api/photos/${encodeURIComponent(order[i % order.length].id)}/image`;

  // Show the current photo once it has loaded, cross-fading over the previous one.
  useEffect(() => {
    let cancelled = false;
    const photo = order[index % order.length];
    const img = new Image();
    img.onload = () => {
      if (cancelled) return;
      setLayers((ls) => [...ls.slice(-1), { key: index, src: img.src, takenAt: photo.takenAt }]);
      new Image().src = srcFor(index + 1); // preload the next one
    };
    img.onerror = () => !cancelled && setIndex((i) => i + 1); // skip broken photos
    img.src = srcFor(index);
    return () => {
      cancelled = true;
    };
  }, [index]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const t = setInterval(() => setIndex((i) => i + 1), slideSeconds * 1000);
    return () => clearInterval(t);
  }, [slideSeconds]);

  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 15_000);
    return () => clearInterval(t);
  }, []);

  // Any interaction closes the slideshow (ignoring events in the first moment after opening).
  useEffect(() => {
    let lastMove = 0;
    const exit = (e: Event) => {
      if (Date.now() - openedAt.current < 800) return;
      if (e.type === 'pointermove') {
        const t = Date.now();
        if (t - lastMove > 400) return void (lastMove = t); // need two moves in quick succession
      }
      e.preventDefault();
      e.stopPropagation();
      // The tap that closes the slideshow shouldn't also click whatever is underneath it.
      const swallow = (ev: Event) => {
        ev.stopPropagation();
        ev.preventDefault();
      };
      window.addEventListener('click', swallow, { capture: true, once: true });
      setTimeout(() => window.removeEventListener('click', swallow, { capture: true }), 600);
      onClose();
    };
    const evs = ['pointerdown', 'keydown', 'wheel', 'pointermove', 'touchstart'];
    evs.forEach((ev) => window.addEventListener(ev, exit, { capture: true }));
    return () => evs.forEach((ev) => window.removeEventListener(ev, exit, { capture: true }));
  }, [onClose]);

  const current = layers[layers.length - 1];
  return (
    <div className="slideshow" role="dialog" aria-label="Photo slideshow">
      {layers.map((l) => (
        <div key={l.key} className={`slide ${l === current ? 'slide-in' : 'slide-out'}`}>
          <div className="slide-bg" style={{ backgroundImage: `url("${l.src}")` }} />
          <img className="slide-img" src={l.src} alt="" style={{ animationDuration: `${slideSeconds + 2}s` }} />
        </div>
      ))}
      <SlideWeather />
      <div className="slide-info">
        <div className="slide-time">{fmtTime(now)}</div>
        <div className="slide-date">{fmt(now, { weekday: 'long', month: 'long', day: 'numeric' })}</div>
      </div>
      {current?.takenAt && <div className="slide-taken">{fmt(current.takenAt, { month: 'long', year: 'numeric' })}</div>}
    </div>
  );
}

/** Home background made from the family photos: one photo at a time, dimmed, changing every few minutes. */
export function PhotoBackdrop({ minutes = 5 }: { minutes?: number }) {
  const photos = usePhotos();
  const list = photos.data?.enabled ? photos.data.photos : [];
  const [idx, setIdx] = useState(() => Math.floor(Math.random() * 1000));
  useEffect(() => {
    const t = setInterval(() => setIdx((i) => i + 1), minutes * 60_000);
    return () => clearInterval(t);
  }, [minutes]);
  if (!list.length) return <div className="photo-backdrop" />;
  const p = list[idx % list.length];
  return (
    <div className="photo-backdrop">
      <div key={p.id} className="photo-backdrop-img" style={{ backgroundImage: `url(/api/photos/${encodeURIComponent(p.id)}/image)` }} />
    </div>
  );
}
