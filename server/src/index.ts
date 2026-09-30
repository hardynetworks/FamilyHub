import compression from 'compression';
import connectPgSimple from 'connect-pg-simple';
import express from 'express';
import session from 'express-session';
import fs from 'fs';
import path from 'path';
import { authRouter, loadUser, requireAdmin, requireAuth } from './auth';
import { config } from './config';
import { pool, waitForDb } from './db';
import { startSyncLoop } from './google';
import { migrate } from './migrate';
import { adminRouter } from './routes/admin';
import { loadSettings } from './settings';
import { choresRouter } from './routes/chores';
import { eventsRouter } from './routes/events';
import { googleRouter } from './routes/google';
import { itemsRouter, listsRouter } from './routes/lists';
import { mealsRouter, recipesRouter } from './routes/meals';
import { membersRouter } from './routes/members';
import { photosRouter } from './routes/photos';
import { weatherRouter } from './routes/weather';
import { homeRouter } from './routes/home';
import { devicesAdminRouter, kioskRouter } from './routes/kiosk';
import { camerasRouter, go2rtcRouter } from './routes/cameras';
import { attachGo2rtcProxy } from './go2rtcProxy';
import { startEvents, startLiveVideoManager } from './protect';
import { errorHandler } from './util';

async function main() {
  await waitForDb();
  await migrate();
  await loadSettings();

  const app = express();
  app.set('trust proxy', 1);
  app.disable('x-powered-by');
  app.use(compression());
  app.use(express.json({ limit: '1mb' }));

  const PgStore = connectPgSimple(session);
  const sessionMiddleware = session({
      name: 'familyhub.sid',
      store: new PgStore({ pool, createTableIfMissing: true, tableName: 'user_sessions' }),
      secret: config.sessionSecret,
      resave: false,
      saveUninitialized: false,
      rolling: true,
      proxy: true,
      cookie: {
        httpOnly: true,
        sameSite: 'lax',
        secure: 'auto', // Secure cookie whenever the request arrived over HTTPS (via X-Forwarded-Proto behind a proxy)
        maxAge: 1000 * 60 * 60 * 24 * 90,
      },
  });
  app.use(sessionMiddleware);
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    next();
  });
  app.use(loadUser);

  // Basic CSRF defence for the JSON API: state-changing requests must be JSON (forces a CORS preflight cross-site).
  app.use('/api', (req, _res, next) => {
    if (['POST', 'PUT', 'PATCH'].includes(req.method) && req.headers['content-type']?.split(';')[0] !== 'application/json') {
      return next(Object.assign(new Error('Content-Type must be application/json'), { status: 415 }));
    }
    next();
  });

  app.get('/api/health', (_req, res) => res.json({ ok: true }));
  app.use('/api/auth', authRouter);
  app.use('/api/google', googleRouter);
  app.use('/api/kiosk', kioskRouter);
  app.use('/api/admin/devices', requireAdmin, devicesAdminRouter);
  app.use('/api/admin', requireAdmin, adminRouter);
  app.use('/api/members', requireAuth, membersRouter);
  app.use('/api/events', requireAuth, eventsRouter);
  app.use('/api/lists', requireAuth, listsRouter);
  app.use('/api/items', requireAuth, itemsRouter);
  app.use('/api/chores', requireAuth, choresRouter);
  app.use('/api/recipes', requireAuth, recipesRouter);
  app.use('/api/meals', requireAuth, mealsRouter);
  app.use('/api/photos', requireAuth, photosRouter);
  app.use('/api/weather', requireAuth, weatherRouter);
  app.use('/api/home', requireAuth, homeRouter);
  app.use('/api/cameras', requireAuth, camerasRouter);
  app.use('/go2rtc', requireAuth, go2rtcRouter);
  app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found' }));

  // Serve the built web app (SPA).
  if (fs.existsSync(config.staticDir)) {
    app.use(express.static(config.staticDir, { index: false, maxAge: '1h' }));
    const indexHtml = path.join(config.staticDir, 'index.html');
    app.use((req, res, next) => {
      if (req.method !== 'GET') return next();
      res.setHeader('Cache-Control', 'no-cache');
      res.sendFile(indexHtml);
    });
  } else {
    console.warn(`Static dir ${config.staticDir} not found; serving API only.`);
  }

  app.use(errorHandler);

  const server = app.listen(config.port, () => {
    console.log(`${config.appName} listening on :${config.port} (App URL: ${config.appUrl || 'auto-detect'}, TZ: ${config.timezone})`);
    console.log(`Local login: ${config.localLogin ? 'on' : 'off'} | SSO: ${config.oidc.enabled ? 'on' : 'off'} | Google sync: ${config.google.enabled ? 'on' : 'off'}`);
  });
  attachGo2rtcProxy(server, sessionMiddleware);
  startEvents();
  startLiveVideoManager();
  startSyncLoop();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
