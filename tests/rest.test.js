// REST API coverage: auth (register/login), friends, rooms, and the LiveKit
// not-configured fallback. Runs against a real server process + real (throwaway) DB.
const test = require("node:test");
const assert = require("node:assert/strict");
const { startServer } = require("./helpers/server");

let server;

test.before(async () => {
  server = await startServer();
});

test.after(async () => {
  await server.stop();
});

async function post(path, body, token) {
  const res = await fetch(server.baseUrl + path, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  return { status: res.status, data: await res.json() };
}
async function get(path, token) {
  const res = await fetch(server.baseUrl + path, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
  return { status: res.status, data: await res.json() };
}

test("register + login round trip issues a usable JWT", async () => {
  const reg = await post("/api/register", { username: "alice", email: "alice@test.com", password: "password123" });
  assert.equal(reg.status, 200);
  assert.ok(reg.data.token, "register should return a token");
  assert.equal(reg.data.user.username, "alice");

  const login = await post("/api/login", { username: "alice", password: "password123" });
  assert.equal(login.status, 200);
  assert.ok(login.data.token);

  const me = await get("/api/me", login.data.token);
  assert.equal(me.status, 200);
  assert.equal(me.data.user.username, "alice");
});

test("register rejects duplicate username/email and short passwords", async () => {
  await post("/api/register", { username: "bob", email: "bob@test.com", password: "password123" });

  const dupe = await post("/api/register", { username: "bob", email: "someone-else@test.com", password: "password123" });
  assert.equal(dupe.status, 409);

  const shortPw = await post("/api/register", { username: "bobby", email: "bobby@test.com", password: "short" });
  assert.equal(shortPw.status, 400);
});

test("register rejects usernames with unsafe characters or bad length", async () => {
  // The classic stored-XSS payload — must be rejected outright, never stored.
  const xss = await post("/api/register", {
    username: "<img src=x onerror=alert(1)>",
    email: "xss@test.com",
    password: "password123",
  });
  assert.equal(xss.status, 400);

  const spaces = await post("/api/register", { username: "has spaces", email: "s@test.com", password: "password123" });
  assert.equal(spaces.status, 400);

  const tooShort = await post("/api/register", { username: "ab", email: "ab@test.com", password: "password123" });
  assert.equal(tooShort.status, 400);

  const tooLong = await post("/api/register", { username: "a".repeat(21), email: "long@test.com", password: "password123" });
  assert.equal(tooLong.status, 400);

  const badEmail = await post("/api/register", { username: "validname", email: "not-an-email", password: "password123" });
  assert.equal(badEmail.status, 400);
});

test("room names are trimmed and length-capped", async () => {
  await post("/api/register", { username: "roomnamer", email: "roomnamer@test.com", password: "password123" });
  const user = await post("/api/login", { username: "roomnamer", password: "password123" });

  const room = await post("/api/rooms", { name: "  " + "x".repeat(200) + "  " }, user.data.token);
  assert.equal(room.status, 200);
  assert.ok(room.data.room.name.length <= 40, "room name should be capped at 40 chars");
  assert.ok(!room.data.room.name.startsWith(" "), "room name should be trimmed");

  const blank = await post("/api/rooms", { name: "   " }, user.data.token);
  assert.equal(blank.data.room.name, "Hangout", "blank name should fall back to default");
});

test("login rejects wrong password / unknown user", async () => {
  await post("/api/register", { username: "carol", email: "carol@test.com", password: "password123" });

  const wrongPw = await post("/api/login", { username: "carol", password: "nope-nope-nope" });
  assert.equal(wrongPw.status, 401);

  const unknown = await post("/api/login", { username: "nobody-here", password: "password123" });
  assert.equal(unknown.status, 401);
});

test("protected routes reject requests with no/invalid token", async () => {
  const noToken = await get("/api/me");
  assert.equal(noToken.status, 401);

  const badToken = await get("/api/me", "not-a-real-token");
  assert.equal(badToken.status, 401);
});

test("friends: add by username, then appears in friends list", async () => {
  await post("/api/register", { username: "dave", email: "dave@test.com", password: "password123" });
  await post("/api/register", { username: "erin", email: "erin@test.com", password: "password123" });
  const dave = await post("/api/login", { username: "dave", password: "password123" });

  const add = await post("/api/friends/add", { username: "erin" }, dave.data.token);
  assert.equal(add.status, 200);
  assert.equal(add.data.friend.username, "erin");

  const list = await get("/api/friends", dave.data.token);
  assert.equal(list.status, 200);
  assert.ok(list.data.friends.some((f) => f.username === "erin"));
});

test("friends: adding yourself or a nonexistent user fails", async () => {
  await post("/api/register", { username: "frank", email: "frank@test.com", password: "password123" });
  const frank = await post("/api/login", { username: "frank", password: "password123" });

  const self = await post("/api/friends/add", { username: "frank" }, frank.data.token);
  assert.equal(self.status, 400);

  const ghost = await post("/api/friends/add", { username: "does-not-exist" }, frank.data.token);
  assert.equal(ghost.status, 404);
});

test("rooms: create issues a unique 6-char code, and it's joinable by code", async () => {
  await post("/api/register", { username: "grace", email: "grace@test.com", password: "password123" });
  const grace = await post("/api/login", { username: "grace", password: "password123" });

  const room = await post("/api/rooms", { name: "Movie Night" }, grace.data.token);
  assert.equal(room.status, 200);
  assert.match(room.data.room.code, /^[A-Z0-9]{6}$/);
  assert.equal(room.data.room.name, "Movie Night");

  const fetched = await get(`/api/rooms/${room.data.room.code}`, grace.data.token);
  assert.equal(fetched.status, 200);
  assert.equal(fetched.data.room.code, room.data.room.code);
});

test("rooms: unknown code 404s", async () => {
  await post("/api/register", { username: "heidi", email: "heidi@test.com", password: "password123" });
  const heidi = await post("/api/login", { username: "heidi", password: "password123" });

  const missing = await get("/api/rooms/ZZZZZZ", heidi.data.token);
  assert.equal(missing.status, 404);
});

test("config reports LiveKit disabled, and its token endpoint 501s, when unconfigured", async () => {
  const config = await get("/api/config");
  assert.equal(config.status, 200);
  assert.equal(config.data.livekitEnabled, false);
  // Always ships at least a STUN server so the mesh works out of the box.
  assert.ok(Array.isArray(config.data.iceServers));
  assert.ok(config.data.iceServers.some((s) => String(s.urls).includes("stun:")));

  await post("/api/register", { username: "ivan", email: "ivan@test.com", password: "password123" });
  const ivan = await post("/api/login", { username: "ivan", password: "password123" });
  const room = await post("/api/rooms", { name: "x" }, ivan.data.token);

  const lk = await post("/api/livekit/token", { roomCode: room.data.room.code }, ivan.data.token);
  assert.equal(lk.status, 501);
});
