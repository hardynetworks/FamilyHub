import { Router } from 'express';
import { photosConfig } from '../config';
import { getPhotos, sendPhoto } from '../photos';

export const photosRouter = Router();

/** Photo list for the slideshow (ids only; images are proxied below). */
photosRouter.get('/', async (req, res) => {
  const cfg = photosConfig();
  if (!cfg.enabled) return res.json({ enabled: false, slideSeconds: cfg.slideSeconds, photos: [] });
  const c = await getPhotos();
  res.json({
    enabled: true,
    slideSeconds: cfg.slideSeconds,
    photos: c.photos.map((p) => ({ id: p.id, takenAt: p.takenAt, width: p.width, height: p.height })),
    errors: req.user!.role === 'admin' ? c.errors : undefined,
  });
});

photosRouter.get('/:id/image', async (req, res) => {
  await sendPhoto(String(req.params.id), res);
});
