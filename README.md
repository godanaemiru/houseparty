# Housie — a Houseparty-style group video chat app

Face-to-face group video rooms with live chat and four in-room mini-games, built as a single Node.js app (Express + Socket.IO) with a vanilla JS/HTML/CSS frontend — no build step required, and tuned for mobile as well as desktop. Uses a zero-setup local SQLite database by default, or a managed Postgres database in production (see "Deploying" below) so accounts and rooms survive restarts.

## Features

- Accounts: register/login with hashed passwords and JWT sessions, rate-limited against brute-force attempts
- Friends: add friends by username, see who's online in real time
- **Drop-in presence**: see which friends are *currently in an open room* (not just online) and join them with one click — the "Friends hanging out now" section on the dashboard
- Rooms: create a room, share a 6-character invite code/link, join from any browser
- Group video: peer-to-peer WebRTC mesh by default (works out of the box, best for up to ~6-8 people), with an optional LiveKit SFU mode for larger rooms — see below. Includes automatic ICE-restart/reconnect handling and a clear on-screen message if camera/mic access is blocked
- In-room text chat
- Four mini-games:
  - **Trivia**: host starts a round, everyone answers 5 random questions with a countdown timer, live scoreboard, speed bonus for fast correct answers
  - **Flag Quiz**: same format as Trivia, but the "question" is a country's flag and the options are country names
  - **Doodle**: players take turns drawing a secret word on a shared canvas while everyone else guesses in Chat; first correct guess (and the drawer) score points, then it rotates to the next drawer
  - **Heads Up**: players take turns as the "performer," who can't see the word while everyone else can and describes it out loud; anyone but the performer taps Correct/Skip to advance through a 60-second deck, then it rotates to the next performer
- Mobile-first UI: touch-sized controls, a sticky bottom action bar in the room so mic/camera/leave stay reachable one-thumb, a horizontally scrollable tab strip for the five side-panel tabs, safe-area support for notch phones, and inputs sized to avoid iOS's auto-zoom-on-focus
- Installable PWA: "Add to Home Screen" / desktop install support, with an app icon, standalone window, and an in-app "Install app" button on the dashboard
- Production-readiness basics: gzip compression, `helmet` security headers, rate limiting on auth *and* on room/friend-request creation, a `/healthz` endpoint for uptime monitors, structured JSON logging (`pino`), and a real automated test suite running in CI against both database backends

## Requirements

- Node.js 22.5+ (uses the built-in `node:sqlite` module — no native module compilation needed)
- A modern browser (Chrome, Edge, Firefox, Safari) with camera/mic permissions
- To video chat between *different computers*, the site needs to be served over **HTTPS** (or `localhost`) — browsers block camera access on plain HTTP for any other host. Deploy behind HTTPS (see below) or use a tunnel like `ngrok`/`cloudflared` for quick testing.

## Run it locally

```bash
cd houseparty-clone
npm install
npm start
```

Then open `http://localhost:3000` in your browser. Open it in a second browser (or incognito window) to test with two accounts, or share your `ngrok`/deployed URL with a friend.

The first run creates a local `data.sqlite` file (users, friendships, rooms, trivia questions) — no external database needed. This only happens when `DATABASE_URL` isn't set; see "Configuration" and "Deploying" below for the production path.

## Configuration

Copy `.env.example` to `.env` as a reference for what's configurable (this app reads plain `process.env` — wire up `dotenv` in `server/index.js`, or just set these as real environment variables on your host):

- `JWT_SECRET` — **required** once `NODE_ENV=production`. A long random string (`openssl rand -hex 32`) used to sign login sessions. Without it in production the server refuses to start, since a guessable secret lets anyone forge auth tokens.
- `NODE_ENV` — set to `production` on your host to enable the strict checks above.
- `DATABASE_URL` — a Postgres connection string. When set, the app uses Postgres (`server/db/postgres.js`) instead of local SQLite (`server/db/sqlite.js`) — see "Deploying" below. Both backends implement the same interface, so nothing else changes.
- `ALLOWED_ORIGINS` — comma-separated list of origins allowed to call the API / connect via Socket.IO (e.g. `https://myapp.com`). Defaults to allowing any origin, which is fine locally but should be locked down in production.
- `PORT` — defaults to 3000; most hosts set this automatically.
- `JWT_EXPIRES_IN` — how long a login session stays valid (e.g. `1d`, `12h`, `7d`). Defaults to `7d`. Shorter is safer since the token lives in the browser's `localStorage`; the client automatically clears the session and redirects to login when a token expires.
- `TURN_URL` / `TURN_USERNAME` / `TURN_CREDENTIAL` — **strongly recommended for real use.** A TURN relay so users behind symmetric NAT (many mobile carriers, corporate/university networks) can actually establish a WebRTC connection — STUN alone isn't enough for them. `TURN_URL` may be a comma-separated list (e.g. `turn:host:3478,turns:host:5349`). Without it the app still works for most home networks, but some users simply won't connect. See "Making video connect reliably" below.
- `LOG_LEVEL` — `trace`/`debug`/`info`/`warn`/`error`/`silent`, defaults to `info`. Controls the structured (`pino`) logger's verbosity.
- `PG_POOL_MAX` — max Postgres connections per running instance, defaults to `10`. Only relevant when `DATABASE_URL` is set; tune this down if you're running several instances against a database plan with a low connection cap.
- `AUTH_RATE_LIMIT` — max register/login attempts per IP per 15 minutes, defaults to `20`. Raise it if you're behind a shared proxy/NAT where many users share an IP.
- `LIVEKIT_URL` / `LIVEKIT_API_KEY` / `LIVEKIT_API_SECRET` — optional, see "Scaling video past ~8 people" below.

## Testing multi-person video locally

1. Register two different accounts (e.g. in a normal window and an incognito window).
2. Add each other as friends (optional — you can also just share a room code).
3. From one account, click **Create & join** to start a room and note the room code.
4. From the other account, enter that code under **Join a room** (or, once you're friends, just click **Join** next to their name once they're in a room).
5. Allow camera/mic access when prompted in both windows.

## Testing

A real automated test suite lives in `tests/` (Node's built-in `node:test` runner — no extra test framework dependency). It spawns the actual server as a child process and exercises it over real HTTP and Socket.IO connections against a throwaway database, rather than mocking anything:

- `tests/rest.test.js` — auth (register/login/duplicate/short-password/wrong-password), friends, rooms, and the `/api/config` + LiveKit-not-configured fallback
- `tests/sockets.test.js` — token-based socket auth rejection, presence broadcasts, room join/peer-joined/WebRTC signaling relay, and full playthroughs of all four mini-games (including Heads Up's core secrecy guarantee: the performer's socket never receives the word)
- `tests/security.test.js` — `/healthz`, helmet security headers, gzip compression, and the login rate limiter actually triggering a 429

Run it locally:

```bash
npm test
```

By default this runs against a fresh temporary SQLite file (auto-cleaned up after). To run the exact same suite against Postgres instead, set `DATABASE_URL` first (e.g. pointing at a local Postgres or Docker container):

```bash
DATABASE_URL=postgres://user:pass@localhost:5432/housie_test npm test
```

**CI**: `.github/workflows/ci.yml` runs this suite on every push/PR twice — once against SQLite, once against a real Postgres 16 service container — so both database backends stay verified automatically.

Running the real-time tests against Postgres specifically matters: because SQLite queries resolve almost instantly, timing bugs in the Socket.IO layer can hide there and only appear against a networked database. One real example this caught — socket listeners were being registered after an `await` on a DB query, so a `room:join` emitted immediately on connect was silently dropped and the room hung with no error. It reproduced constantly on Postgres and almost never on SQLite.

## Making video connect reliably (TURN)

The WebRTC mesh needs to punch through each participant's NAT/firewall. A public STUN server (always included) handles that for most home networks, but users behind **symmetric NAT** — very common on mobile carriers and corporate/university networks — can only connect through a **TURN relay** that forwards their media. Without one, those users' video tiles simply never appear, with no obvious error.

To fix that, set `TURN_URL` (and usually `TURN_USERNAME` / `TURN_CREDENTIAL`) to a TURN service. Options:

- A managed provider like [Twilio Network Traversal](https://www.twilio.com/stun-turn) or [Metered](https://www.metered.ca/tools/openrelay/) — quickest to set up.
- Self-hosted [coturn](https://github.com/coturn/coturn) on a small VPS.

The server merges these into the ICE server list it hands the browser via `GET /api/config`, so no client changes are needed — set the env vars and restart. (The LiveKit SFU mode below also relays media, so if you enable that you don't separately need TURN.)

## Scaling video past ~8 people (optional LiveKit SFU mode)

By default, video uses a WebRTC **mesh** — every participant connects directly to every other participant. That needs no extra setup, but each person's upload bandwidth/CPU has to handle N-1 connections, so it gets rough above ~6-8 people in a room.

This app also has an optional integration with [LiveKit](https://livekit.io), an open-source SFU (selective forwarding unit) that routes everyone's media through a media server instead, scaling to much larger rooms. To enable it:

1. Get a LiveKit deployment — either a free project on [LiveKit Cloud](https://cloud.livekit.io), or self-host the open-source server.
2. Set `LIVEKIT_URL` (the `wss://...` URL), `LIVEKIT_API_KEY`, and `LIVEKIT_API_SECRET` as environment variables on your server.
3. Restart the app. `GET /api/config` will now report `livekitEnabled: true`, and `public/js/room.js` automatically switches from the WebRTC mesh to connecting via LiveKit instead — no other changes needed. If the LiveKit connection fails for any reason, it falls back to the mesh automatically.

**Note on testing**: the server-side token minting (`server/livekit.js`) is pure local JWT signing and has been verified directly. The actual browser-to-LiveKit connection (`initLiveKit()` in `public/js/room.js`) has *not* been tested end-to-end, since that requires a real LiveKit deployment and credentials that only you can provide. Test it with two browser tabs once you've set the environment variables above, and check the browser console for connection errors if video tiles don't appear.

## Installing as an app (PWA)

The app ships with a manifest, icons, and a service worker, so browsers offer to install it like a native app — a standalone window, home-screen icon, and instant loads for the static shell (chat/video/games still need a live connection, so this isn't an offline mode).

- **Desktop Chrome/Edge**: an install icon appears in the address bar; there's also an "Install app" button in the dashboard sidebar once the browser signals it's installable.
- **Android Chrome**: "Add to Home screen" from the browser menu, or the same in-app button.
- **iOS Safari**: Share button → "Add to Home Screen" (iOS doesn't support the automatic install prompt, so there's no in-app button there — this is a platform limitation, not a bug).

**Important**: like camera access, service workers require **HTTPS** (localhost is exempt). On plain HTTP over a non-localhost address, `sw.js` will fail to register — this is expected and is logged as a warning in the browser console, not an error in the app. Once you deploy behind HTTPS (see below), installability works automatically.

**Known iOS limitation — video calls from the home-screen icon.** When launched from its home-screen icon, iOS runs the app in a restricted WebKit context ("standalone" mode) where camera/mic access and WebRTC peer connections are unreliable — participants can end up unable to see or hear themselves *or* anyone else. This is an iOS platform limitation (well documented across WebRTC-in-PWA discussions), not a bug in this app, and it doesn't affect Android's home-screen install. The app detects this (`navigator.standalone === true`) and shows a banner on the dashboard and in the room offering a one-tap "Open in Safari" link, which reliably escapes the restricted context — video calling is fully reliable in a normal Safari tab. There's no code-level fix for the standalone case itself; if Apple loosens this restriction in a future iOS release, this is the first place to re-test.

If you change any static file in `public/`, bump `CACHE_NAME` in `public/sw.js` (e.g. `housie-shell-v2`) so installed clients pick up the update instead of serving a stale cached copy.

## Deploying so friends can join from anywhere

This app needs a **persistent Node.js process** (it holds WebSocket connections and an in-memory presence/game state), so it needs a host that runs a real long-lived server — Render, Railway, Fly.io, or a small VPS — rather than a static host or serverless functions (confirmed while building this: Netlify/Vercel-style serverless functions explicitly can't hold persistent WebSocket connections, so those are ruled out).

### Deploying to Render (recommended path, has a free tier)

This repo includes a `render.yaml` Blueprint that provisions both the web service *and* a managed Postgres database in one step, wired together automatically.

1. **Push this project to a Git repo** (GitHub, GitLab, or Bitbucket — Render needs to pull from one). From the `houseparty-clone` folder:
   ```bash
   git init
   git add .
   git commit -m "Initial commit"
   ```
   Then create a new empty repository on GitHub (github.com → New repository — don't initialize it with a README), and push:
   ```bash
   git remote add origin https://github.com/<your-username>/<repo-name>.git
   git branch -M main
   git push -u origin main
   ```
2. **Create a Render account** at [render.com](https://render.com) (free) and connect your GitHub account when prompted.
3. In the Render dashboard, click **New +** → **Blueprint**, and select the repo you just pushed. Render reads `render.yaml` and shows you a plan: one web service (`housie`) and one Postgres database (`housie-db`), both on the free tier.
4. Click **Apply**. Render will provision the database, generate a random `JWT_SECRET` automatically, wire `DATABASE_URL` from the database to the web service, build (`npm install`), and start (`npm start`) the app.
5. Once the deploy finishes, Render gives you an `https://housie-xxxx.onrender.com`-style URL — that's what you share with friends.

**About the free tier**: free Render web services spin down after ~15 minutes of no traffic and take ~30-60 seconds to wake back up on the next request (a normal cold start, not a bug). Because this project now uses Postgres instead of local SQLite, accounts/friends/rooms *do* survive that spin-down/restart cycle. The one thing to know: Render's **free Postgres databases expire after 30 days** and are deleted — for anything beyond a month of casual testing with friends, either recreate the database blueprint before then, or upgrade the database to a paid Render Postgres plan (which doesn't expire).

If you'd rather set it up by hand instead of using the Blueprint: create a Postgres instance and a Web Service separately in the Render dashboard, then set the web service's `DATABASE_URL` env var to the database's *Internal Connection String*, plus `NODE_ENV=production` and a `JWT_SECRET` you generate yourself (`openssl rand -hex 32`).

### Other hosts (Railway, Fly.io, a VPS)

The same shape works anywhere that runs a persistent Node process: push to Git, point the platform at this repo, set the build command to `npm install` and start command to `npm start`, and set `NODE_ENV=production`, `JWT_SECRET`, and `DATABASE_URL` (pointing at a Postgres instance from that provider, or their equivalent) as environment variables.

### Quick temporary demo (no deployment)

Run `npm start` locally and expose it with a tunnel (e.g. `ngrok http 3000`), then share the `https://*.ngrok.io` link. This uses local SQLite and resets whenever you stop the server — fine for a single test session, not for anything longer.

## Project structure

```
server/
  index.js      Express + Socket.IO bootstrap: CORS lockdown, helmet, gzip compression,
                /healthz, serves the frontend
  logger.js     Shared structured logger (pino) — JSON in production, pretty-printed locally
  db/
    index.js    Picks sqlite.js or postgres.js based on DATABASE_URL
    sqlite.js   Local SQLite backend (node:sqlite) — zero setup, used in development
    postgres.js Managed Postgres backend (pg, tunable pool size) — used in production
  auth.js       JWT sign/verify + auth middleware (fails fast without JWT_SECRET in production)
  routes.js     REST API: register, login, friends, rooms, client config, LiveKit tokens —
                rate-limited (auth endpoints and room/friend creation separately)
  sockets.js    Real-time layer: presence + "friend in a room" broadcasts, room join/leave,
                WebRTC signaling relay, chat (doubles as the Doodle guess box), and four
                game engines — Trivia + Flag Quiz (share one quiz engine), Doodle, Heads Up
  livekit.js    Optional LiveKit access-token minting
tests/          node:test suite — REST, sockets/games, and security/health (see "Testing")
.github/workflows/ci.yml  Runs the test suite against SQLite and a Postgres service container
render.yaml     Render Blueprint: provisions the web service + a managed Postgres database
public/
  index.html      Login / register
  dashboard.html  Friend list + live presence + "friends hanging out now", create/join room
  room.html       Video grid, chat, Trivia panel, Doodle canvas
  js/api.js       Tiny fetch + auth-token helper
  js/room.js      WebRTC mesh (with ICE-restart/reconnect) or LiveKit, signaling, chat,
                  Trivia UI, Doodle canvas + drawing sync
  js/pwa.js       Service worker registration + "Install app" prompt handling
  css/style.css   Dark/gradient "party" theme
  manifest.json   PWA metadata (name, icons, standalone display)
  sw.js           Service worker: caches the static app shell, passes through API/Socket.IO
  icons/          App icons (192/512/maskable/apple-touch/favicon)
```

## Notes & limitations

- Presence and room/game state (who's online, who's in which room, live trivia/doodle rounds) live in server memory, so they reset if the server restarts, and won't work if you try to run more than one server instance (there's no shared state like Redis between processes). Accounts, friendships, and rooms persist in the database (SQLite locally, Postgres in production) and survive restarts.
- The WebRTC mesh mode doesn't scale much past ~6-8 participants; use the LiveKit mode above for bigger rooms.
- Local development uses Node's `node:sqlite`, which is still explicitly marked experimental and could change between Node versions. Production (Postgres) is unaffected by that.
- Render's free Postgres tier expires after 30 days (see "Deploying" above) — fine for testing, worth knowing before you treat a free deployment as permanent.
