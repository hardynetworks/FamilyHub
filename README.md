# FamilyHub

A self-hosted family organizer: shared calendar with **two-way Google Calendar sync**, shopping and to-do lists, chores with points, and a weekly meal planner with a recipe box. It runs as a responsive web app / PWA, so you can install it on phones or put it on a wall-mounted tablet. Everything runs in Docker (Node + Postgres).

Sign-in options: **Authentik (OIDC)** and/or local email + password accounts.

## Features

| Area | What you get |
|---|---|
| **Home** | Clock and greeting, the week's agenda, today's chores by person, today's meals, shopping list, open to-dos. Refreshes itself every minute, so it works well on a wall tablet. |
| **Calendar** | Fills the window and resizes with it (agenda view on phones). Shows the daily weather forecast on each day. Month / week / day / agenda views, color-coded by family member, member filters, drag-to-move/resize, repeating events (daily, weekly, every 2 weeks, monthly, yearly, with an optional end date). |
| **Google sync** | Each person connects their own Google account(s) and picks which calendars to sync and who each calendar belongs to. Google events show up in FamilyHub. Events created or edited in FamilyHub on a Google calendar are written to Google right away. Changes made in Google are pulled in every 5 minutes (configurable) or when you click **Sync now**. |
| **Lists** | Multiple shopping and to-do lists. Paste several lines to add many items at once. Items can have an assignee and a due date. You can hide or clear completed items. |
| **Chores** | Daily, specific-weekday, or one-time chores, assigned to a person or to "anyone". Tap to complete. Points feed a weekly leaderboard. |
| **Meals** | Weekly planner (breakfast, lunch, dinner, snack) and a recipe box. You can send a recipe's ingredients, or the whole week's ingredients (de-duplicated), to a shopping list in one click. |
| **Family** | Admins add members, including kids without logins, and set their colors and avatars. SSO users are matched to members by email. |

## Quick start

```bash
git clone https://github.com/hardynetworks/FamilyHub.git && cd FamilyHub
cp .env.example .env        # only POSTGRES_PASSWORD is required
docker compose pull         # prebuilt image from ghcr.io (amd64 + arm64)
docker compose up -d
docker compose logs -f app
```

To build from source instead of pulling, run `docker compose up -d --build`. To update later, run `git pull && docker compose pull && docker compose up -d`.

Open the app in a browser. The first screen creates the admin account and records the app's address and your time zone. Everything else is set up from inside the app, under **Settings → App settings** (admins only):

- **General:** app name, public address (App URL), household time zone
- **Sign-in:** Authentik / OIDC details, the admin group, auto-creating members, and whether password sign-in is allowed
- **Google Calendar:** OAuth client ID and secret, sync interval, and the sync window

Each section shows the exact redirect URI to paste into Authentik or Google, and has a **Test** button that checks your details before you rely on them. Changes take effect right away; no restart is needed.

The session secret and the encryption key are generated on first start and stored in the `familyhub-data` volume (`/data/secrets.json`). Client secrets and Google tokens are stored encrypted in the database. Secrets are never sent back to the browser; the form only shows whether one is saved.

The database schema is created and migrated automatically on startup.

> **First run:** until the first account is created, anyone who can reach the app can create it. Do that right away, before exposing the app more widely.

### Reverse proxy

Put FamilyHub behind your usual proxy (Traefik, Caddy, NPM, etc.) at a hostname such as `family.example.com`, pointing at port 3000.

- Set **Settings → App settings → Public address** to the URL your family uses (the setup screen fills it in from the address you first opened). OAuth redirect URIs are built from it.
- The proxy must send `X-Forwarded-Proto` so cookies are marked `Secure` over HTTPS. Most proxies do this by default.
- The app can stay VPN-only (e.g. behind NetBird). The OAuth redirects happen in the user's browser, so Google and Authentik never need to reach FamilyHub directly. The browser just needs to be able to reach both.

## Authentik (OIDC) setup

1. In FamilyHub, open **Settings → App settings → Sign-in: Authentik** and copy the redirect URI shown there, e.g. `https://family.example.com/api/auth/oidc/callback`.
2. In Authentik, go to **Applications → Providers → Create → OAuth2/OpenID Provider**.
   - Client type: **Confidential**
   - Redirect URI (strict): the URI from step 1
   - Scopes: keep the defaults (`openid`, `profile`, `email`)
3. Go to **Applications → Create**, set the slug to `familyhub`, and choose the provider. Use policy bindings to control who can access it (for example, a `family` group).
4. Back in FamilyHub, paste the **Issuer URL** (shown on the Authentik provider page, e.g. `https://auth.example.com/application/o/familyhub/`), the **Client ID** and the **Client secret**. Click **Test connection**, then **Save**. The sign-in button appears on the login page immediately.
5. Optional: set an **Admin group**. Members of that Authentik group become FamilyHub admins, and the role is re-checked at every sign-in.

Account matching on SSO login works in this order: an existing link, then a family member with the same email (which gets linked automatically), then a new member if auto-create is on.

**Turning off password sign-in.** This is only allowed once Authentik is configured and you have signed in with it at least once. Password sign-in also switches itself back on if the SSO settings are ever removed.

**Locked out?** Add `LOCAL_LOGIN_ENABLED=true` to `.env` and run `docker compose up -d`.

## Google Calendar setup (two-way sync)

1. In FamilyHub, open **Settings → App settings → Google Calendar** and copy the redirect URI shown there, e.g. `https://family.example.com/api/google/callback`.
2. In [Google Cloud Console](https://console.cloud.google.com/), create a project and enable the **Google Calendar API**.
3. Configure the **OAuth consent screen**: user type **External**, and add the scope `https://www.googleapis.com/auth/calendar`.
4. Create **Credentials → OAuth client ID → Web application**, with the redirect URI from step 1 as an **Authorized redirect URI**.
5. Paste the client ID and secret into FamilyHub, click **Test credentials**, then **Save**.
6. Each person goes to **Settings → Google Calendar → Connect account**. Their primary calendar is synced automatically. They can turn on any others and set **Belongs to** so events get that person's color.

> **Important:** while the consent screen is in **Testing**, Google expires refresh tokens after 7 days, so sync will stop and ask you to reconnect. For a family install, click **Publish app** on the Audience page. You don't need Google's verification: users will see an "unverified app" warning once when they connect, which is fine for personal use.

### How sync behaves

- **Choosing where an event lives.** When creating an event, you pick **FamilyHub only** or a Google calendar you can write to. Google-backed events are written to Google first, so Google stays the source of truth.
- **Pull sync.** FamilyHub mirrors a rolling window of 60 days back to 400 days ahead (configurable). Events deleted in Google disappear from FamilyHub on the next sync.
- **Repeating events.** A repeating event created in FamilyHub on a Google calendar is created in Google as a real recurring series. Google series appear as individual occurrences, and editing or deleting one in FamilyHub changes only that occurrence. To change a whole Google series, use Google Calendar.
- **Moving events.** You can move an event between FamilyHub-only and any writable Google calendar.
- **Who an event is for.** The "Who's it for?" members are stored on the Google event as a private extended property, so they survive round trips.
- **Read-only calendars.** Calendars shared with you as read-only (holidays, school calendars, etc.) can be synced and viewed but not edited.
- **Token storage.** OAuth tokens and client secrets are encrypted at rest (AES-256-GCM) with the auto-generated key in `/data/secrets.json`.

## Customizing the Home page

Tap **Customize** (bottom-right of Home) to edit the page in place:

- **Move widgets** by dragging the ⠿ handle; this works with touch too.
- **Resize** by dragging the corner, or with the −/+ buttons. The page uses a 12-column grid on wide screens, 6 columns on tablets, and a single column on phones.
- **Add or remove widgets:** greeting & clock, big clock, weather, cameras, coming up, today's chores, today's meals, shopping list (more than one allowed), to-dos, and family notes.
- **Widget options (⚙):** for example how many days of events to show, which shopping list to show, or the text and colour of a note.
- **Look & feel:** accent colour (applies to the whole app), light/dark/automatic, text size (great for a wall tablet), background and spacing.

Each person's Home page is their own. A head of household can press **Save for family** to make a layout the default for everyone who hasn't customized theirs, and anyone can **Reset** back to the family layout.

## Family & roles

**Settings → Family members** is where the head of household manages the family:

- Set the family name.
- Add adults and children, and edit anyone's name, colour, avatar and login.
- **Head of household:** manages the family and all app settings. There can be more than one, and FamilyHub always keeps at least one.
- **Adult:** full use of calendar, lists, chores and meals.
- **Child:** appears on the calendar and chore charts, and doesn't need a login.

Settings are organised into tabs grouped by **You**, **Family**, **Connections** and **App settings** (heads of household only).

## Cameras (UniFi Protect)

FamilyHub can show your UniFi Protect cameras on the Home page and pop up the doorbell camera when someone rings. It uses the official **Protect Integration API**, which needs Protect 5.3 or newer and an API key.

1. In your UniFi console, create an API key. It's under **Settings → Control Plane → Integrations**, or **Protect → Settings → Integrations** on some versions.
2. In FamilyHub, go to **Settings → App settings → Cameras**:
   - Enter the console address (e.g. `https://192.168.1.1`) and the API key.
   - Click **Test connection**, then **Choose cameras** to pick which cameras appear on Home and in what order.
3. Choose the default display. Each person can change it for themselves under **Settings → Cameras**:
   - **Snapshots.** A still image from each camera, refreshed every few seconds.
   - **Live video.** Live streams on the Home page.
   - **Snapshots, live when tapped.** Snapshot tiles; tapping one opens full-screen live video.
4. **Doorbell pop-up.** When the doorbell rings, every open FamilyHub screen shows that camera full screen for 30 seconds (configurable), even over the photo slideshow. Each person can turn this off for themselves.

**Smooth, fast live video** (Settings → App settings → Cameras):

- **Keep cameras ready in the background** (on by default for tile streams). The video relay stays connected to your cameras around the clock (go2rtc "preload"), so live video starts almost instantly instead of waiting a few seconds each time. It uses a little constant bandwidth on your home network, with no transcoding.
- **Two qualities.** Small Home tiles use Protect's *low* stream, and full screen uses *high*. Both can be changed.
- **Low-latency WebRTC** (optional). Turn it on and enter the server's home-network IP (e.g. `192.168.1.20`).

  Devices on your home network then connect straight to the server on port **8555 (TCP and UDP)**, which `docker-compose.yml` publishes. Allow it through the server's firewall (e.g. `sudo ufw allow 8555`). FamilyHub writes the go2rtc config and restarts go2rtc for you. If a browser can't reach that port, video falls back to standard streaming automatically. If 8555 is taken, set `WEBRTC_PORT=xxxx` in `.env`.

**How live video works:** browsers can't play Protect's RTSPS streams, so the bundled `go2rtc` container converts them into video the browser can play. FamilyHub passes the video through to signed-in users. go2rtc's control API is never published; only its WebRTC media port (8555) is, and that only carries video that FamilyHub has already set up for a signed-in user. If you use a reverse proxy, make sure **WebSocket support** is enabled for FamilyHub; live video, like the doorbell, depends on it.

## Kiosk screens (wall tablets, Raspberry Pi)

Turn a tablet or a Raspberry Pi display into a family dashboard that stays signed in on its own.

1. A head of household opens **Settings → Kiosk screens → Add a screen**, picks whose Home page it shows and which pages it can open, and gets a one-time pairing code (valid 30 minutes).
2. On the screen, open `https://<your FamilyHub>/kiosk` and enter the code (or open the pairing link, which pairs straight away).

A kiosk screen:

- Opens full screen ("Tap anywhere to start" the first time), keeps the display awake (Screen Wake Lock, needs HTTPS) and hides the sidebar and Settings.
- Goes back to Home after a chosen idle time, shows a "Reconnecting…" banner if the server can't be reached and refreshes itself when it's back, reloads after app updates and once a night.
- Stays signed in with its own device token (an httpOnly cookie). No one's password is stored on it, and it never gets head-of-household access, even when it shows a head of household's Home page. Remove the screen in Settings to sign it out instantly.
- Has a small lock button that asks for the **kiosk PIN** (set it on the same Settings tab). After the PIN you can unlock all pages for 5 minutes, customize Home, reload, or sign the screen out.

To stop people leaving the browser, lock the device to it: **App pinning** on Android (after "Add to Home screen"), **Guided Access** on iPad, or on a Raspberry Pi start Chromium with `chromium-browser --kiosk --noerrdialogs --disable-infobars https://<your FamilyHub>/kiosk` and turn off screen blanking in `raspi-config`.

## Weather

The Home page shows the current conditions and a 6-day forecast, and the photo slideshow shows the temperature in the corner. The data comes from [Open-Meteo](https://open-meteo.com), which is free and needs no API key; FamilyHub fetches it on the server and caches it for 15 minutes.

To set it up, an admin goes to **Settings → App settings → Weather**, searches for a city or ZIP code (or uses the device's location), and picks °F or °C.

## Photo slideshow (Home screensaver)

When someone has been idle on the Home page (1 minute by default), a full-screen slideshow of family photos appears with the time and date. Any touch, click, key press or mouse movement closes it. There's also a **Photos** button on Home to start it by hand.

- **Per person:** go to **Settings → Photo slideshow** to turn it on or off and change how many minutes of inactivity start it.
- **Photo sources (admin):** go to **Settings → App settings → Photos**:
  - **Amazon Photos shared links.** In Amazon Photos, choose **Share → Copy link** on an album or group, allow anyone with the link to view, and paste the link, one per line. Amazon has no public API, so FamilyHub reads the same public data as the share page. No Amazon login is stored, but if Amazon changes that page, photos may stop loading until FamilyHub is updated.
  - **Immich.** Enter your server URL and an API key, then pick albums. If you don't pick any, your Immich favorites are used.
  - Click **Load photos** to check what was found.

Images are fetched by the FamilyHub server and passed on to the browser, so the browser never needs access to Amazon or Immich, and your Immich API key stays on the server.

## Configuration reference

Only `POSTGRES_PASSWORD` has to be set in `.env`: the app needs it to reach the database where every other setting is stored.

Every in-app setting can also be set with an environment variable, which takes priority. It then appears as locked in the UI, which is handy for infrastructure-as-code. See the commented list in `.env.example`: `APP_URL`, `TZ`, `LOCAL_LOGIN_ENABLED`, `OIDC_*`, `GOOGLE_*`, `SESSION_SECRET`, `ENCRYPTION_KEY`.

## Backups

Back up **both** volumes: `familyhub-db` (all data) and `familyhub-data` (the keys that decrypt saved secrets and Google tokens).

```bash
docker compose exec -T db pg_dump -U familyhub familyhub | gzip > familyhub-$(date +%F).sql.gz
docker compose cp app:/data/secrets.json ./familyhub-secrets-$(date +%F).json
```

## Development

```bash
# terminal 1: Postgres
docker compose up db -d
# terminal 2: API (http://localhost:3000)
cd server && npm install && DATABASE_URL=postgres://familyhub:<pw>@localhost:5432/familyhub npm run dev
# terminal 3: web (http://localhost:5173, proxies /api to :3000)
cd web && npm install && npm run dev
```

For the dev setup, expose the DB port by adding `ports: ["5432:5432"]` to the `db` service. Run `npm run typecheck` in `server/` and `web/` for strict type checks.

### Project layout

```
server/src
  index.ts        Express app, sessions, static hosting
  auth.ts         local login, first-run setup, Authentik OIDC (PKCE)
  settings.ts     in-app settings store (env overrides, encrypted secrets)
  env.ts          static env + auto-generated secrets in DATA_DIR
  google.ts       Google OAuth, calendar list, pull sync loop, push helpers
  migrate.ts      SQL schema migrations
  routes/         members, events, lists, chores, meals/recipes, google, admin (app settings)
web/src
  pages/          Home, Calendar (FullCalendar), Lists, Chores, Meals, Settings, Login
  components/     EventModal, UI primitives
```

## Roadmap ideas

Photo album, family message board, push notifications, a kiosk/"wall" mode with auto-rotating views, Google push notifications (webhooks) for instant sync, and CalDAV/iCloud support.

## License

[GNU GPL-3.0](LICENSE). You're free to use, modify and self-host FamilyHub. If you distribute a modified version, you must share its source code under the same license.
