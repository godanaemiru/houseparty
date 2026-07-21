# Housie — a Houseparty-style group video chat app

Face-to-face group video rooms with live chat and two in-room mini-games, built as a single Node.js app (Express + Socket.IO) with a vanilla JS/HTML/CSS frontend — no build step required. Uses a zero-setup local SQLite database by default, or a managed Postgres database in production (see "Deploying" below) so accounts and rooms survive restarts.

## Features

- Accounts: register/login with hashed passwords and JWT sessions, rate-limited against brute-force attempts
- Friends: add friends by username, see who's online in real time
- **Drop-in presence**: see which friends are *currently in an open room* (not just online) and join them with one click — the "Friends hanging out now" section on the dashboard
- Rooms: create a room, share a 6-character invite code/link, join from any browser
- Group video: peer-to-peer WebRTC mesh by default (works out of the box, best for up to ~6-8 people), with an optional LiveKit SFU mode for larger rooms — see below. Includes automatic ICE-restart/reconnect handling and a clear on-screen message if camera/mic access is blocked
- In-room text chat
- Two mini-games:
  - **Trivia**: host starts a round, everyone answers 5 random questions with a countdown timer, live scoreboard, speed bonus for fast correct answers
  - **Doodle**: players take turns drawing a secret word on a shared canvas while everyone else guesses in Chat; first correct guess (and the drawer) score points, then it rotates to the next drawer
- Installable PWA: "Add to Home Screen" / desktop install support, with an app icon, standalone window, and an in-app "Install app" button on the dashboard

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
- `LIVEKIT_URL` / `LIVEKIT_API_KEY` / `LIVEKIT_API_SECRET` — optional, see "Scaling video past ~8 people" below.

## Testing multi-person video locally

1. Register two different accounts (e.g. in a normal window and an incognito window).
2. Add each other as friends (optional — you can also just share a room code).
3. From one account, click **Create & join** to start a room and note the room code.
4. From the other account, enter that code under **Join a room** (or, once you're friends, just click **Join** next to their name once they're in a room).
5. Allow camera/mic access when prompted in both windows.

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
  index.js      Express + Socket.IO bootstrap, CORS lockdown, serves the frontend
  db/
    index.js    Picks sqlite.js or postgres.js based on DATABASE_URL
    sqlite.js   Local SQLite backend (node:sqlite) — zero setup, used in development
    postgres.js Managed Postgres backend (pg) — used in production, same function names
  auth.js       JWT sign/verify + auth middleware (fails fast without JWT_SECRET in production)
  routes.js     REST API: register, login, friends, rooms, client config, LiveKit tokens
  sockets.js    Real-time layer: presence + "friend in a room" broadcasts, room join/leave,
                WebRTC signaling relay, chat (doubles as the Doodle guess box), Trivia and
                Doodle game engines
  livekit.js    Optional LiveKit access-token minting
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
- No automated test suite ships with the app (a set of throwaway test scripts — REST endpoints, WebRTC/chat/Trivia/Doodle over sockets, and a full run against a real Postgres instance — was used during development but isn't part of the product). No structured logging/error tracking is set up either.
- Local development uses Node's `node:sqlite`, which is still explicitly marked experimental and could change between Node versions. Production (Postgres) is unaffected by that.
- Render's free Postgres tier expires after 30 days (see "Deploying" above) — fine for testing, worth knowing before you treat a free deployment as permanent.
