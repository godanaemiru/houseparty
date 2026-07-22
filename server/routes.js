const express = require("express");
const bcrypt = require("bcryptjs");
const rateLimit = require("express-rate-limit");
const db = require("./db");
const logger = require("./logger");
const { signToken, requireAuth } = require("./auth");
const { isLiveKitConfigured, createLiveKitToken } = require("./livekit");

const router = express.Router();

// Auth endpoints are brute-force targets — cap attempts per IP. Generous enough for a
// real user fumbling their password a few times, tight enough to blunt automated guessing.
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many attempts. Please try again in a few minutes." },
});

// Wider net for other write endpoints that are cheap to spam (room creation, friend
// requests) but aren't the primary brute-force target auth is. Generous enough that a
// real user bashing "create room" wouldn't notice, tight enough to blunt scripted abuse.
const writeLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests. Please slow down and try again shortly." },
});

const COLORS = ["#ff5e7e", "#7b5eff", "#5ec6ff", "#ffb85e", "#5effb0", "#ff5ec8"];
function randomColor() {
  return COLORS[Math.floor(Math.random() * COLORS.length)];
}
function randomRoomCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

// Wraps an async route handler so a thrown/rejected error becomes a 500 instead of
// crashing the process or hanging the request.
function asyncRoute(fn) {
  return (req, res) => {
    Promise.resolve(fn(req, res)).catch((err) => {
      logger.error({ err, path: req.path, method: req.method }, "Route error");
      if (!res.headersSent) res.status(500).json({ error: "Something went wrong" });
    });
  };
}

// ---------- Auth ----------
router.post(
  "/register",
  authLimiter,
  asyncRoute(async (req, res) => {
    const { username, email, password } = req.body || {};
    if (!username || !email || !password) {
      return res.status(400).json({ error: "username, email and password are required" });
    }
    if (password.length < 6) {
      return res.status(400).json({ error: "Password must be at least 6 characters" });
    }
    const existing = await db.findUserIdByUsernameOrEmail(username, email);
    if (existing) return res.status(409).json({ error: "Username or email already taken" });

    const hash = bcrypt.hashSync(password, 10);
    const user = await db.createUser({ username, email, passwordHash: hash, avatarColor: randomColor() });
    const token = signToken(user);
    res.json({ token, user });
  })
);

router.post(
  "/login",
  authLimiter,
  asyncRoute(async (req, res) => {
    const { username, password } = req.body || {};
    if (!username || !password) return res.status(400).json({ error: "username and password required" });
    const user = await db.findUserForLogin(username);
    if (!user || !bcrypt.compareSync(password, user.password_hash)) {
      return res.status(401).json({ error: "Invalid credentials" });
    }
    const token = signToken(user);
    res.json({
      token,
      user: { id: user.id, username: user.username, email: user.email, avatar_color: user.avatar_color },
    });
  })
);

router.get(
  "/me",
  requireAuth,
  asyncRoute(async (req, res) => {
    const user = await db.findPublicUserById(req.user.id);
    res.json({ user });
  })
);

// ---------- Users / Friends ----------
router.get(
  "/users/search",
  requireAuth,
  asyncRoute(async (req, res) => {
    const q = (req.query.q || "").toString().trim();
    if (!q) return res.json({ users: [] });
    const users = await db.searchUsersByUsername(q, req.user.id);
    res.json({ users });
  })
);

router.get(
  "/friends",
  requireAuth,
  asyncRoute(async (req, res) => {
    const friends = await db.getFriends(req.user.id);
    res.json({ friends });
  })
);

router.post(
  "/friends/add",
  requireAuth,
  writeLimiter,
  asyncRoute(async (req, res) => {
    const { username } = req.body || {};
    const friend = await db.findUserByUsername(username);
    if (!friend) return res.status(404).json({ error: "User not found" });
    if (friend.id === req.user.id) return res.status(400).json({ error: "Can't add yourself" });

    await db.addFriendshipPair(req.user.id, friend.id);
    res.json({ friend: { id: friend.id, username: friend.username, avatar_color: friend.avatar_color } });
  })
);

// ---------- Rooms ----------
router.post(
  "/rooms",
  requireAuth,
  writeLimiter,
  asyncRoute(async (req, res) => {
    const { name } = req.body || {};
    let code;
    do {
      code = randomRoomCode();
    } while (await db.roomCodeExists(code));

    const room = await db.createRoom({ code, name: name || "Hangout", hostId: req.user.id });
    res.json({ room });
  })
);

router.get(
  "/rooms/:code",
  requireAuth,
  asyncRoute(async (req, res) => {
    const room = await db.findActiveRoomByCode(req.params.code.toUpperCase());
    if (!room) return res.status(404).json({ error: "Room not found" });
    res.json({ room });
  })
);

// Builds the ICE server list handed to the browser's RTCPeerConnection. A public STUN
// server is always included (it's enough for most home networks), but users behind
// symmetric NAT — common on mobile carriers and corporate/university networks — can only
// connect through a TURN relay. If TURN_URL (+ optional credentials) is configured, it's
// appended so those users aren't silently left unable to connect. TURN_URL may be a
// comma-separated list (e.g. udp + tcp/443 fallbacks).
function buildIceServers() {
  const iceServers = [{ urls: "stun:stun.l.google.com:19302" }];
  if (process.env.TURN_URL) {
    const urls = process.env.TURN_URL.split(",").map((u) => u.trim()).filter(Boolean);
    const turn = { urls };
    if (process.env.TURN_USERNAME) turn.username = process.env.TURN_USERNAME;
    if (process.env.TURN_CREDENTIAL) turn.credential = process.env.TURN_CREDENTIAL;
    iceServers.push(turn);
  }
  return iceServers;
}

// ---------- Client config ----------
// Lets the frontend know whether to use the LiveKit SFU path or fall back to the built-in
// WebRTC mesh, and hands it the ICE server list (STUN + optional TURN) — without
// hardcoding any of that into the client bundle.
router.get("/config", (req, res) => {
  res.json({ livekitEnabled: isLiveKitConfigured(), iceServers: buildIceServers() });
});

// ---------- LiveKit (optional SFU video, see README) ----------
router.post(
  "/livekit/token",
  requireAuth,
  asyncRoute(async (req, res) => {
    if (!isLiveKitConfigured()) {
      return res.status(501).json({ error: "LiveKit is not configured on this server" });
    }
    const roomCode = ((req.body && req.body.roomCode) || "").toUpperCase();
    const room = await db.findActiveRoomByCode(roomCode);
    if (!room) return res.status(404).json({ error: "Room not found" });

    try {
      const token = await createLiveKitToken({
        roomCode: room.code,
        userId: req.user.id,
        username: req.user.username,
      });
      res.json({ token, url: process.env.LIVEKIT_URL });
    } catch (err) {
      logger.error({ err }, "LiveKit token error");
      res.status(500).json({ error: "Failed to create LiveKit token" });
    }
  })
);

module.exports = router;
