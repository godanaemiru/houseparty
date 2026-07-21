const base = "http://127.0.0.1:3000";
async function post(path, body, token) {
  const res = await fetch(base + path, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  return { status: res.status, data: await res.json() };
}
async function get(path, token) {
  const res = await fetch(base + path, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
  return { status: res.status, data: await res.json() };
}
(async () => {
  console.log("start");
  await post("/api/register", { username: "alice", email: "alice@test.com", password: "password123" });
  await post("/api/register", { username: "bob", email: "bob@test.com", password: "password123" });
  const alice = await post("/api/login", { username: "alice", password: "password123" });
  console.log("login alice status", alice.status);
  const bob = await post("/api/login", { username: "bob", password: "password123" });
  console.log("login bob status", bob.status);
  const addFriend = await post("/api/friends/add", { username: "bob" }, alice.data.token);
  console.log("add friend status", addFriend.status, JSON.stringify(addFriend.data));
  const friendsList = await get("/api/friends", alice.data.token);
  console.log("friends list", JSON.stringify(friendsList.data));
  const room = await post("/api/rooms", { name: "Test Room" }, alice.data.token);
  console.log("room created", JSON.stringify(room.data));

  const config = await get("/api/config");
  console.log("config (no LiveKit env set):", JSON.stringify(config.data));
  const lkToken = await post("/api/livekit/token", { roomCode: room.data.room.code }, alice.data.token);
  console.log("livekit token status (expect 501, not configured):", lkToken.status, JSON.stringify(lkToken.data));

  console.log("REST_TEST_OK");
  process.exit(0);
})().catch((e) => { console.error("REST_TEST_FAILED", e); process.exit(1); });
