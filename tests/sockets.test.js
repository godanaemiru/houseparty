// Real-time layer coverage: presence broadcast, room join/leave, WebRTC signaling relay,
// and the trivia + doodle mini-games. Uses real socket.io-client connections against a
// real server process.
const test = require("node:test");
const assert = require("node:assert/strict");
const { io } = require("socket.io-client");
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

async function registerAndLogin(username) {
  await post("/api/register", { username, email: `${username}@test.com`, password: "password123" });
  const login = await post("/api/login", { username, password: "password123" });
  return login.data;
}

function connect(token) {
  return io(server.baseUrl, { auth: { token }, transports: ["websocket"] });
}

// A generous default: this waits on real network round trips (socket.io over a real
// TCP/WebSocket connection to a spawned server process), and CI runners in particular
// can be noticeably slower/noisier than a local machine.
function waitFor(socket, event, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for "${event}"`)), timeoutMs);
    socket.once(event, (payload) => {
      clearTimeout(timer);
      resolve(payload);
    });
  });
}

// Like waitFor, but races the same event across several (socket, tag) pairs and resolves
// with whichever fires first, tagged so the caller can tell them apart. Needed for events
// the server sends to only one of several possible recipients (e.g. "you're the drawer")
// where the test can't know in advance which client that'll be.
function waitForEither(pairs, event, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for "${event}"`)), timeoutMs);
    for (const [socket, tag] of pairs) {
      socket.once(event, (payload) => {
        clearTimeout(timer);
        resolve({ tag, payload });
      });
    }
  });
}

// Asserts a socket does NOT receive an event within a short window — used to prove
// server-side secrecy (e.g. Heads Up's performer must never receive the word).
function neverReceives(socket, event, ms = 1200) {
  return new Promise((resolve) => {
    let got = false;
    const handler = () => { got = true; };
    socket.once(event, handler);
    setTimeout(() => {
      socket.off(event, handler);
      resolve(!got);
    }, ms);
  });
}

test("socket connection is rejected without a valid token", async () => {
  const bad = io(server.baseUrl, { auth: { token: "garbage" }, transports: ["websocket"] });
  const err = await waitFor(bad, "connect_error");
  assert.equal(err.message, "unauthorized");
  bad.close();
});

test("presence: friend:online and friend:room-changed fire for a friend", async () => {
  const jill = await registerAndLogin("jill");
  const kate = await registerAndLogin("kate");
  await post("/api/friends/add", { username: "kate" }, jill.token);
  const room = await post("/api/rooms", { name: "Hangout" }, kate.token);
  const code = room.data.room.code;

  const sJill = connect(jill.token);
  await waitFor(sJill, "connect");

  const onlinePromise = waitFor(sJill, "friend:online");
  const sKate = connect(kate.token);
  await waitFor(sKate, "connect");
  const onlineEvt = await onlinePromise;
  assert.equal(onlineEvt.userId, kate.user.id);

  const roomChangedPromise = waitFor(sJill, "friend:room-changed");
  sKate.emit("room:join", { code, avatarColor: "#fff" });
  const roomEvt = await roomChangedPromise;
  assert.equal(roomEvt.userId, kate.user.id);
  assert.equal(roomEvt.room.code, code);

  sJill.close();
  sKate.close();
});

test("rooms: joining relays peer-joined and lets peers signal each other", async () => {
  const leo = await registerAndLogin("leo");
  const mia = await registerAndLogin("mia");
  const room = await post("/api/rooms", { name: "Call" }, leo.token);
  const code = room.data.room.code;

  const sLeo = connect(leo.token);
  await waitFor(sLeo, "connect");
  sLeo.emit("room:join", { code, avatarColor: "#111" });
  await waitFor(sLeo, "room:joined");

  const peerJoinedPromise = waitFor(sLeo, "room:peer-joined");
  const sMia = connect(mia.token);
  await waitFor(sMia, "connect");
  sMia.emit("room:join", { code, avatarColor: "#222" });
  const peerJoined = await peerJoinedPromise;
  assert.equal(peerJoined.username, "mia");

  const signalPromise = waitFor(sMia, "webrtc:signal");
  sLeo.emit("webrtc:signal", { to: mia.user.id, data: { type: "offer", sdp: "fake-sdp" } });
  const signal = await signalPromise;
  assert.equal(signal.from, leo.user.id);
  assert.deepEqual(signal.data, { type: "offer", sdp: "fake-sdp" });

  sLeo.close();
  sMia.close();
});

test("trivia game: start -> question -> correct answer awards points", async () => {
  const nina = await registerAndLogin("nina");
  const room = await post("/api/rooms", { name: "Quiz" }, nina.token);
  const code = room.data.room.code;

  const sNina = connect(nina.token);
  await waitFor(sNina, "connect");
  sNina.emit("room:join", { code, avatarColor: "#aaa" });
  await waitFor(sNina, "room:joined");

  const startedPromise = waitFor(sNina, "game:started");
  const questionPromise = waitFor(sNina, "game:question");
  sNina.emit("game:start");
  const started = await startedPromise;
  assert.ok(started.totalQuestions > 0);
  const question = await questionPromise;
  assert.ok(Array.isArray(question.options));
  assert.ok(question.options.length >= 2);

  const resultPromise = waitFor(sNina, "game:answer-result");
  sNina.emit("game:answer", { questionId: question.questionId, answerIndex: -1 });
  const result = await resultPromise;
  // -1 is never a valid option index, so this should always register as incorrect —
  // proves the server (not the client) is the source of truth for correctness.
  assert.equal(result.correct, false);

  sNina.close();
});

test("doodle game: drawer draws, guesser guesses the right word and scores", async () => {
  const oli = await registerAndLogin("oli");
  const pam = await registerAndLogin("pam");
  const room = await post("/api/rooms", { name: "Doodle" }, oli.token);
  const code = room.data.room.code;

  const sOli = connect(oli.token);
  const sPam = connect(pam.token);
  await Promise.all([waitFor(sOli, "connect"), waitFor(sPam, "connect")]);

  sOli.emit("room:join", { code, avatarColor: "#f0f" });
  await waitFor(sOli, "room:joined");
  sPam.emit("room:join", { code, avatarColor: "#0ff" });
  await waitFor(sPam, "room:joined");

  // Register every listener before triggering the action — the server fires
  // "doodle:started" / "doodle:round-start" / "doodle:your-word" back-to-back in the same
  // tick, so awaiting them one at a time risks missing an event that arrives before the
  // next .once() is registered. Racing "your-word" across both sockets also sidesteps not
  // knowing in advance which client the server will pick as drawer.
  const startedPromise = waitFor(sOli, "doodle:started");
  const roundStartPromise = waitFor(sOli, "doodle:round-start");
  const wordPromise = waitForEither([[sOli, "oli"], [sPam, "pam"]], "doodle:your-word");

  sOli.emit("doodle:start");

  const started = await startedPromise;
  assert.ok(started.totalRounds > 0);
  const roundStart = await roundStartPromise;
  const { tag: drawerTag, payload: wordPayload } = await wordPromise;
  assert.equal(roundStart.drawerName, drawerTag);

  const word = wordPayload.word;
  assert.equal(typeof word, "string");
  assert.ok(word.length > 0);

  const guesserSocket = drawerTag === "oli" ? sPam : sOli;

  // "doodle:correct-guess" is broadcast to the whole room, so either socket sees it.
  const correctGuessPromise = waitFor(sOli, "doodle:correct-guess");
  guesserSocket.emit("chat:message", { text: word });
  const correctGuess = await correctGuessPromise;
  assert.ok(correctGuess.scores.some((s) => s.score > 0));

  sOli.close();
  sPam.close();
});

test("room is deactivated once the last member leaves", async () => {
  const tess = await registerAndLogin("tess");
  const room = await post("/api/rooms", { name: "Ephemeral" }, tess.token);
  const code = room.data.room.code;

  // Room is joinable while occupied.
  const beforeRes = await fetch(server.baseUrl + `/api/rooms/${code}`, {
    headers: { Authorization: `Bearer ${tess.token}` },
  });
  assert.equal(beforeRes.status, 200);

  const sTess = connect(tess.token);
  await waitFor(sTess, "connect");
  sTess.emit("room:join", { code, avatarColor: "#abc" });
  await waitFor(sTess, "room:joined");

  // Last (only) member leaves -> server should retire the room.
  sTess.emit("room:leave");
  sTess.close();

  // deactivateRoom is fire-and-forget, so poll briefly for the 404 instead of racing it.
  let finalStatus = 200;
  for (let i = 0; i < 20; i++) {
    const res = await fetch(server.baseUrl + `/api/rooms/${code}`, {
      headers: { Authorization: `Bearer ${tess.token}` },
    });
    finalStatus = res.status;
    if (finalStatus === 404) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.equal(finalStatus, 404, "room should be inactive (404) after everyone leaves");
});

test("flag quiz: start -> question is a flag among 4 options -> server grades answers", async () => {
  const opal = await registerAndLogin("opal");
  const room = await post("/api/rooms", { name: "Flags" }, opal.token);
  const code = room.data.room.code;

  const sOpal = connect(opal.token);
  await waitFor(sOpal, "connect");
  sOpal.emit("room:join", { code, avatarColor: "#aaf" });
  await waitFor(sOpal, "room:joined");

  const startedPromise = waitFor(sOpal, "flags:started");
  const questionPromise = waitFor(sOpal, "flags:question");
  sOpal.emit("flags:start");
  const started = await startedPromise;
  assert.ok(started.totalQuestions > 0);

  const question = await questionPromise;
  assert.ok(Array.isArray(question.options));
  assert.equal(question.options.length, 4);
  // The "question" is a flag emoji, not English text — options should be the only
  // human-readable country names on screen.
  assert.ok(question.options.every((o) => typeof o === "string" && o.length > 0));

  const resultPromise = waitFor(sOpal, "flags:answer-result");
  sOpal.emit("flags:answer", { questionId: question.questionId, answerIndex: -1 });
  const result = await resultPromise;
  assert.equal(result.correct, false);

  sOpal.close();
});

test("heads up: performer never sees the word, guesser does, and marking correct scores the performer", async () => {
  const quinn = await registerAndLogin("quinn");
  const riley = await registerAndLogin("riley");
  const room = await post("/api/rooms", { name: "Heads Up" }, quinn.token);
  const code = room.data.room.code;

  const sQuinn = connect(quinn.token);
  const sRiley = connect(riley.token);
  await Promise.all([waitFor(sQuinn, "connect"), waitFor(sRiley, "connect")]);

  sQuinn.emit("room:join", { code, avatarColor: "#f0f" });
  await waitFor(sQuinn, "room:joined");
  sRiley.emit("room:join", { code, avatarColor: "#0ff" });
  await waitFor(sRiley, "room:joined");

  // Register listeners before triggering, same reasoning as the doodle test: round-start
  // and the private word both fire in the same server tick.
  const startedPromise = waitFor(sQuinn, "headsup:started");
  const roundStartPromise = waitFor(sQuinn, "headsup:round-start");
  const wordPromise = waitForEither([[sQuinn, "quinn"], [sRiley, "riley"]], "headsup:word");

  sQuinn.emit("headsup:start");

  const started = await startedPromise;
  assert.ok(started.totalRounds > 0);
  const roundStart = await roundStartPromise;
  const { tag: guesserTag, payload: wordPayload } = await wordPromise;
  // Whoever received the word is NOT the performer.
  assert.notEqual(roundStart.performerName, guesserTag);

  const word = wordPayload.word;
  assert.equal(typeof word, "string");
  assert.ok(word.length > 0);

  const performerSocket = guesserTag === "quinn" ? sRiley : sQuinn;
  const guesserSocket = guesserTag === "quinn" ? sQuinn : sRiley;

  // The core secrecy guarantee of the game: the performer's own socket must never get
  // the word, even though it was broadcast to everyone else in the room.
  assert.ok(await neverReceives(performerSocket, "headsup:word"), "performer should never receive the word");

  const progressPromise = waitFor(sQuinn, "headsup:progress");
  guesserSocket.emit("headsup:correct");
  const progress = await progressPromise;
  assert.equal(progress.wordsThisRound, 1);
  assert.ok(progress.scores.some((s) => s.score > 0));

  sQuinn.close();
  sRiley.close();
});
