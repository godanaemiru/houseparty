const { verifyToken } = require("./auth");
const db = require("./db");
const logger = require("./logger");

// In-memory presence + room state (fine for a single-process demo server)
const onlineUsers = new Map(); // userId -> Set(socketId)
const roomMembers = new Map(); // roomCode -> Map(userId -> {socketId, username, avatarColor})
const doodleGames = new Map(); // roomCode -> doodle game state
const headsUpGames = new Map(); // roomCode -> heads up game state
const userRooms = new Map(); // userId -> { code, name } — which room a user is currently in, if any

const DOODLE_WORDS = [
  "pizza", "guitar", "dolphin", "rocket", "castle", "umbrella", "penguin", "volcano",
  "sandwich", "robot", "unicorn", "lighthouse", "octopus", "cactus", "pirate", "dragon",
  "campfire", "skateboard", "waterfall", "telescope", "snowman", "butterfly", "tornado",
  "pumpkin", "backpack",
];

// Charades-style words for Heads Up — deliberately generic/describable concepts and
// objects (no real people) so clue-giving stays easy and the content stays safe for
// any group of friends.
const HEADSUP_WORDS = [
  "Pizza", "Astronaut", "Birthday Cake", "Superhero", "Roller Coaster", "Snowman",
  "Pirate Ship", "Dinosaur", "Beach Ball", "Ice Cream Truck", "Magic Trick",
  "Treasure Map", "Robot", "Volcano", "Rainbow", "Campfire", "Skateboard", "Waterfall",
  "Telescope", "Butterfly", "Tornado", "Pumpkin", "Backpack", "Lighthouse", "Octopus",
  "Cactus", "Dragon", "Unicorn", "Penguin", "Dolphin", "Ninja", "Wizard", "Spaceship",
  "Sandcastle", "Fireworks", "Bumblebee", "Kangaroo", "Mermaid", "Vampire", "Werewolf",
  "Karate Chop", "Snowball Fight", "Scuba Diving", "Yoga Pose", "Sleepwalking",
];

// Flag Quiz's question bank — built from flag emoji + country name rather than a DB
// table, since it's static reference data with no reason to round-trip the database.
const FLAG_COUNTRIES = [
  { flag: "🇫🇷", name: "France" }, { flag: "🇯🇵", name: "Japan" },
  { flag: "🇧🇷", name: "Brazil" }, { flag: "🇨🇦", name: "Canada" },
  { flag: "🇩🇪", name: "Germany" }, { flag: "🇮🇹", name: "Italy" },
  { flag: "🇪🇸", name: "Spain" }, { flag: "🇲🇽", name: "Mexico" },
  { flag: "🇮🇳", name: "India" }, { flag: "🇦🇺", name: "Australia" },
  { flag: "🇰🇷", name: "South Korea" }, { flag: "🇬🇧", name: "United Kingdom" },
  { flag: "🇺🇸", name: "United States" }, { flag: "🇨🇳", name: "China" },
  { flag: "🇪🇬", name: "Egypt" }, { flag: "🇿🇦", name: "South Africa" },
  { flag: "🇦🇷", name: "Argentina" }, { flag: "🇸🇪", name: "Sweden" },
  { flag: "🇳🇱", name: "Netherlands" }, { flag: "🇨🇭", name: "Switzerland" },
  { flag: "🇳🇴", name: "Norway" }, { flag: "🇬🇷", name: "Greece" },
  { flag: "🇵🇹", name: "Portugal" }, { flag: "🇹🇷", name: "Turkey" },
  { flag: "🇰🇪", name: "Kenya" }, { flag: "🇯🇲", name: "Jamaica" },
  { flag: "🇮🇪", name: "Ireland" }, { flag: "🇵🇱", name: "Poland" },
  { flag: "🇳🇬", name: "Nigeria" }, { flag: "🇹🇭", name: "Thailand" },
];

// Fisher-Yates — used for word decks and flag/distractor picks. Never mutates the input.
function shuffleArray(arr) {
  const copy = [...arr];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

function buildFlagQuestions(count) {
  const picks = shuffleArray(FLAG_COUNTRIES).slice(0, Math.min(count, FLAG_COUNTRIES.length));
  return picks.map((target, i) => {
    const distractors = shuffleArray(FLAG_COUNTRIES.filter((c) => c.name !== target.name)).slice(0, 3);
    const options = shuffleArray([target.name, ...distractors.map((c) => c.name)]);
    return {
      id: `flag-${i}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      question: target.flag,
      options,
      correct_index: options.indexOf(target.name),
    };
  });
}

function broadcastToUser(io, userId, event, payload) {
  const sockets = onlineUsers.get(userId);
  if (!sockets) return;
  for (const sid of sockets) io.to(sid).emit(event, payload);
}

function currentPeers(roomCode, excludeUserId) {
  const members = roomMembers.get(roomCode);
  if (!members) return [];
  return [...members.entries()]
    .filter(([uid]) => uid !== excludeUserId)
    .map(([uid, m]) => ({ userId: uid, username: m.username, avatarColor: m.avatarColor }));
}

function attachSockets(io) {
  io.use((socket, next) => {
    const token = socket.handshake.auth && socket.handshake.auth.token;
    const payload = token && verifyToken(token);
    if (!payload) return next(new Error("unauthorized"));
    socket.userId = payload.id;
    socket.username = payload.username;
    next();
  });

  io.on("connection", async (socket) => {
    const userId = socket.userId;

    // ----- Presence -----
    if (!onlineUsers.has(userId)) onlineUsers.set(userId, new Set());
    onlineUsers.get(userId).add(socket.id);

    const friendIds = await db.getFriendIds(userId);
    for (const fid of friendIds) {
      broadcastToUser(io, fid, "friend:online", { userId, username: socket.username });
    }

    socket.emit(
      "friends:status",
      friendIds.map((fid) => ({
        userId: fid,
        online: onlineUsers.has(fid),
        room: userRooms.get(fid) || null,
      }))
    );

    // ----- Rooms -----
    socket.on("room:join", async ({ code, avatarColor }) => {
      const roomCode = (code || "").toUpperCase();
      const room = await db.findActiveRoomByCode(roomCode);
      if (!room) return socket.emit("room:error", { error: "Room not found" });

      socket.join(`room:${roomCode}`);
      socket.roomCode = roomCode;

      if (!roomMembers.has(roomCode)) roomMembers.set(roomCode, new Map());
      const members = roomMembers.get(roomCode);

      socket.emit("room:joined", {
        room: { code: room.code, name: room.name },
        peers: currentPeers(roomCode, userId),
      });

      members.set(userId, { socketId: socket.id, username: socket.username, avatarColor });

      socket.to(`room:${roomCode}`).emit("room:peer-joined", {
        userId,
        username: socket.username,
        avatarColor,
      });

      // Let friends know this user is now in an open room they could drop into.
      userRooms.set(userId, { code: room.code, name: room.name });
      const friendIdsForRoom = await db.getFriendIds(userId);
      for (const fid of friendIdsForRoom) {
        broadcastToUser(io, fid, "friend:room-changed", {
          userId,
          room: { code: room.code, name: room.name },
        });
      }
    });

    socket.on("room:leave", () => leaveRoom(socket));

    // ----- WebRTC signaling relay -----
    socket.on("webrtc:signal", ({ to, data }) => {
      const roomCode = socket.roomCode;
      if (!roomCode) return;
      const members = roomMembers.get(roomCode);
      const target = members && members.get(to);
      if (target) {
        io.to(target.socketId).emit("webrtc:signal", { from: userId, data });
      }
    });

    // ----- Chat (also doubles as the guess box for the doodle game) -----
    socket.on("chat:message", ({ text }) => {
      const roomCode = socket.roomCode;
      if (!roomCode || !text) return;
      const clean = String(text).slice(0, 500);

      const guessResult = tryDoodleGuess(io, roomCode, userId, socket.username, clean);
      if (guessResult.handled) return; // correct guess — a masked system message was already sent

      io.to(`room:${roomCode}`).emit("chat:message", {
        userId,
        username: socket.username,
        text: clean,
        ts: Date.now(),
      });
    });

    // ----- Trivia + Flag Quiz (share the same quiz engine, see createQuizEngine below) -----
    socket.on("game:start", () => {
      const roomCode = socket.roomCode;
      if (!roomCode) return;
      triviaEngine.start(io, roomCode);
    });
    socket.on("game:answer", ({ questionId, answerIndex }) => {
      const roomCode = socket.roomCode;
      if (!roomCode) return;
      triviaEngine.handleAnswer(io, roomCode, userId, socket.username, questionId, answerIndex);
    });

    socket.on("flags:start", () => {
      const roomCode = socket.roomCode;
      if (!roomCode) return;
      flagsEngine.start(io, roomCode);
    });
    socket.on("flags:answer", ({ questionId, answerIndex }) => {
      const roomCode = socket.roomCode;
      if (!roomCode) return;
      flagsEngine.handleAnswer(io, roomCode, userId, socket.username, questionId, answerIndex);
    });

    // ----- Heads Up -----
    socket.on("headsup:start", () => {
      const roomCode = socket.roomCode;
      if (!roomCode) return;
      startHeadsUp(io, roomCode);
    });
    socket.on("headsup:correct", () => {
      const roomCode = socket.roomCode;
      if (!roomCode) return;
      handleHeadsUpAction(io, roomCode, userId, "correct");
    });
    socket.on("headsup:skip", () => {
      const roomCode = socket.roomCode;
      if (!roomCode) return;
      handleHeadsUpAction(io, roomCode, userId, "skip");
    });

    // ----- Doodle (drawing & guessing) game -----
    socket.on("doodle:start", () => {
      const roomCode = socket.roomCode;
      if (!roomCode) return;
      startDoodle(io, roomCode);
    });

    socket.on("doodle:draw", (stroke) => {
      const roomCode = socket.roomCode;
      const game = doodleGames.get(roomCode);
      if (!game || !game.active || game.drawerId !== userId) return; // only the current drawer can draw
      socket.to(`room:${roomCode}`).emit("doodle:draw", stroke);
    });

    socket.on("disconnect", async () => {
      const set = onlineUsers.get(userId);
      if (set) {
        set.delete(socket.id);
        if (set.size === 0) {
          onlineUsers.delete(userId);
          const friendIdsOnDisconnect = await db.getFriendIds(userId);
          for (const fid of friendIdsOnDisconnect) {
            broadcastToUser(io, fid, "friend:offline", { userId });
          }
        }
      }
      leaveRoom(socket);
    });
  });

  async function leaveRoom(socket) {
    const roomCode = socket.roomCode;
    if (!roomCode) return;
    const members = roomMembers.get(roomCode);
    if (members) {
      members.delete(socket.userId);
      if (members.size === 0) {
        roomMembers.delete(roomCode);
        triviaEngine.cleanupRoom(roomCode);
        flagsEngine.cleanupRoom(roomCode);
        const dgame = doodleGames.get(roomCode);
        if (dgame) clearTimeout(dgame.timer);
        doodleGames.delete(roomCode);
        const hgame = headsUpGames.get(roomCode);
        if (hgame) clearTimeout(hgame.timer);
        headsUpGames.delete(roomCode);
        // Room is now empty — retire it so its code can't be re-joined and stale rows
        // don't pile up. A fresh room (new code) is created next time someone starts one.
        db.deactivateRoom(roomCode).catch((err) =>
          logger.error({ err, roomCode }, "Failed to deactivate empty room")
        );
      } else {
        // If the person drawing/performing leaves mid-round, don't leave everyone else
        // waiting forever.
        const dgame = doodleGames.get(roomCode);
        if (dgame && dgame.active && dgame.drawerId === socket.userId) {
          clearTimeout(dgame.timer);
          nextDoodleRound(io, roomCode);
        }
        const hgame = headsUpGames.get(roomCode);
        if (hgame && hgame.active && hgame.performerId === socket.userId) {
          clearTimeout(hgame.timer);
          nextHeadsUpRound(io, roomCode);
        }
      }
    }
    socket.to(`room:${roomCode}`).emit("room:peer-left", { userId: socket.userId });
    socket.leave(`room:${roomCode}`);
    socket.roomCode = null;

    if (userRooms.get(socket.userId)?.code === roomCode) {
      userRooms.delete(socket.userId);
      const friendIds = await db.getFriendIds(socket.userId);
      for (const fid of friendIds) {
        broadcastToUser(io, fid, "friend:room-changed", { userId: socket.userId, room: null });
      }
    }
  }

  function tryDoodleGuess(io, roomCode, userId, username, text) {
    const game = doodleGames.get(roomCode);
    if (!game || !game.active || game.drawerId === userId) return { handled: false };
    if (game.guessedCorrectly.has(userId)) return { handled: false };
    if (text.trim().toLowerCase() !== game.word.toLowerCase()) return { handled: false };

    game.guessedCorrectly.add(userId);
    const secondsLeft = Math.max(0, (game.roundEndsAt - Date.now()) / 1000);
    const points = 50 + Math.round(secondsLeft * 5);
    game.scores[userId] = (game.scores[userId] || 0) + points;
    game.scores[game.drawerId] = (game.scores[game.drawerId] || 0) + 20; // reward the drawer too

    io.to(`room:${roomCode}`).emit("chat:message", {
      userId,
      username,
      text: "🎯 guessed the word correctly!",
      ts: Date.now(),
      system: true,
    });
    io.to(`room:${roomCode}`).emit("doodle:correct-guess", {
      userId,
      username,
      scores: doodleScoreboard(game, roomCode),
    });

    const members = roomMembers.get(roomCode);
    const guessersCount = members ? members.size - 1 : 0; // everyone except the drawer
    if (guessersCount > 0 && game.guessedCorrectly.size >= guessersCount) {
      clearTimeout(game.timer);
      revealDoodleWord(io, roomCode);
    }
    return { handled: true };
  }

  function doodleScoreboard(game, roomCode) {
    const members = roomMembers.get(roomCode) || new Map();
    return Object.entries(game.scores)
      .map(([uid, score]) => ({
        userId: Number(uid),
        username: (members.get(Number(uid)) || {}).username || "Player",
        score,
      }))
      .sort((a, b) => b.score - a.score);
  }

  function startDoodle(io, roomCode) {
    const existing = doodleGames.get(roomCode);
    if (existing && existing.active) return;

    const members = roomMembers.get(roomCode);
    if (!members || members.size === 0) return;
    const order = [...members.keys()];

    const game = {
      active: true,
      order,
      roundIndex: -1,
      totalRounds: order.length,
      drawerId: null,
      word: null,
      guessedCorrectly: new Set(),
      roundEndsAt: 0,
      timer: null,
      scores: existing ? existing.scores : {},
    };
    doodleGames.set(roomCode, game);
    io.to(`room:${roomCode}`).emit("doodle:started", { totalRounds: game.totalRounds });
    nextDoodleRound(io, roomCode);
  }

  function nextDoodleRound(io, roomCode) {
    const game = doodleGames.get(roomCode);
    if (!game) return;

    game.roundIndex += 1;
    const members = roomMembers.get(roomCode);

    if (game.roundIndex >= game.totalRounds || !members || members.size < 2) {
      game.active = false;
      io.to(`room:${roomCode}`).emit("doodle:end", { scores: doodleScoreboard(game, roomCode) });
      return;
    }

    // Skip anyone who's since left the room.
    let drawerId = game.order[game.roundIndex % game.order.length];
    if (!members.has(drawerId)) {
      return nextDoodleRound(io, roomCode);
    }

    const word = DOODLE_WORDS[Math.floor(Math.random() * DOODLE_WORDS.length)];
    const timeLimit = 45000;
    game.drawerId = drawerId;
    game.word = word;
    game.guessedCorrectly = new Set();
    game.roundEndsAt = Date.now() + timeLimit;

    const drawerInfo = members.get(drawerId);
    io.to(`room:${roomCode}`).emit("doodle:clear");
    io.to(`room:${roomCode}`).emit("doodle:round-start", {
      drawerId,
      drawerName: drawerInfo.username,
      wordLength: word.length,
      round: game.roundIndex + 1,
      totalRounds: game.totalRounds,
      timeLimit,
    });
    io.to(drawerInfo.socketId).emit("doodle:your-word", { word });

    clearTimeout(game.timer);
    game.timer = setTimeout(() => revealDoodleWord(io, roomCode), timeLimit);
  }

  function revealDoodleWord(io, roomCode) {
    const game = doodleGames.get(roomCode);
    if (!game) return;
    io.to(`room:${roomCode}`).emit("doodle:reveal", {
      word: game.word,
      scores: doodleScoreboard(game, roomCode),
    });
    setTimeout(() => nextDoodleRound(io, roomCode), 3000);
  }

  // Trivia and Flag Quiz are both "N multiple-choice questions with a countdown timer and
  // a live scoreboard" — this factory holds that shared logic once, parameterized by which
  // socket events to emit and where its questions come from. Each call gets its own private
  // per-room state Map, so the two games never see each other's rounds/scores.
  function createQuizEngine({ eventPrefix, fetchQuestions }) {
    const games = new Map(); // roomCode -> quiz state

    function scoreboardFor(game, roomCode) {
      const members = roomMembers.get(roomCode) || new Map();
      return Object.entries(game.scores).map(([uid, score]) => ({
        userId: Number(uid),
        username: (members.get(Number(uid)) || {}).username || "Player",
        score,
      })).sort((a, b) => b.score - a.score);
    }

    async function start(io, roomCode) {
      const existing = games.get(roomCode);
      if (existing && existing.active) return;

      const questions = await fetchQuestions();
      const game = {
        active: true,
        questions,
        index: -1,
        scores: existing ? existing.scores : {},
        answered: new Set(),
        questionId: null,
        correctIndex: null,
        questionStartedAt: 0,
        timer: null,
      };
      games.set(roomCode, game);

      io.to(`room:${roomCode}`).emit(`${eventPrefix}:started`, { totalQuestions: questions.length });
      nextQuestion(io, roomCode);
    }

    function nextQuestion(io, roomCode) {
      const game = games.get(roomCode);
      if (!game) return;
      game.index += 1;

      if (game.index >= game.questions.length) {
        game.active = false;
        io.to(`room:${roomCode}`).emit(`${eventPrefix}:end`, { scores: scoreboardFor(game, roomCode) });
        return;
      }

      const q = game.questions[game.index];
      game.questionId = q.id;
      game.correctIndex = q.correct_index;
      game.answered = new Set();
      game.questionStartedAt = Date.now();
      const timeLimit = q.timeLimit || 10000;

      io.to(`room:${roomCode}`).emit(`${eventPrefix}:question`, {
        questionId: q.id,
        index: game.index,
        total: game.questions.length,
        question: q.question,
        options: q.options,
        timeLimit,
      });

      clearTimeout(game.timer);
      game.timer = setTimeout(() => {
        io.to(`room:${roomCode}`).emit(`${eventPrefix}:reveal`, {
          questionId: q.id,
          correctIndex: q.correct_index,
          scores: scoreboardFor(game, roomCode),
        });
        setTimeout(() => nextQuestion(io, roomCode), 2500);
      }, timeLimit);
    }

    function handleAnswer(io, roomCode, userId, username, questionId, answerIndex) {
      const game = games.get(roomCode);
      if (!game || !game.active || game.questionId !== questionId) return;
      if (game.answered.has(userId)) return; // one answer per question
      game.answered.add(userId);

      const correct = answerIndex === game.correctIndex;
      if (correct) {
        const now = Date.now();
        const speedBonus = Math.max(0, 1000 - (now - game.questionStartedAt));
        const points = 100 + Math.round(speedBonus / 10);
        game.scores[userId] = (game.scores[userId] || 0) + points;
      }
      io.to(`room:${roomCode}`).emit(`${eventPrefix}:answer-result`, {
        userId,
        username,
        correct,
        scores: scoreboardFor(game, roomCode),
      });
    }

    function cleanupRoom(roomCode) {
      const game = games.get(roomCode);
      if (game) clearTimeout(game.timer);
      games.delete(roomCode);
    }

    return { start, handleAnswer, cleanupRoom };
  }

  const triviaEngine = createQuizEngine({
    eventPrefix: "game",
    fetchQuestions: () => db.getRandomTriviaQuestions(5),
  });
  const flagsEngine = createQuizEngine({
    eventPrefix: "flags",
    fetchQuestions: async () => buildFlagQuestions(6),
  });

  // ---------- Heads Up ----------
  // Rotates through everyone in the room as "performer" — the one person who can't see
  // the word. Everyone else sees it (privately, over their own socket) and reads out
  // clues; anyone but the performer can tap Correct/Skip to advance the deck. Points go
  // to the performer, since it's their turn being scored.
  function headsUpScoreboard(game, roomCode) {
    const members = roomMembers.get(roomCode) || new Map();
    return Object.entries(game.scores).map(([uid, score]) => ({
      userId: Number(uid),
      username: (members.get(Number(uid)) || {}).username || "Player",
      score,
    })).sort((a, b) => b.score - a.score);
  }

  function sendWordToGuessers(io, roomCode, performerId, word) {
    const members = roomMembers.get(roomCode);
    if (!members) return;
    for (const [uid, member] of members) {
      if (uid !== performerId) io.to(member.socketId).emit("headsup:word", { word });
    }
  }

  function startHeadsUp(io, roomCode) {
    const existing = headsUpGames.get(roomCode);
    if (existing && existing.active) return;

    const members = roomMembers.get(roomCode);
    if (!members || members.size === 0) return;
    const order = [...members.keys()];

    const game = {
      active: true,
      order,
      roundIndex: -1,
      totalRounds: order.length,
      performerId: null,
      deck: [],
      currentWord: null,
      wordsThisRound: 0,
      roundEndsAt: 0,
      timer: null,
      scores: existing ? existing.scores : {},
    };
    headsUpGames.set(roomCode, game);
    io.to(`room:${roomCode}`).emit("headsup:started", { totalRounds: game.totalRounds });
    nextHeadsUpRound(io, roomCode);
  }

  function nextHeadsUpRound(io, roomCode) {
    const game = headsUpGames.get(roomCode);
    if (!game) return;

    game.roundIndex += 1;
    const members = roomMembers.get(roomCode);

    if (game.roundIndex >= game.totalRounds || !members || members.size < 2) {
      game.active = false;
      io.to(`room:${roomCode}`).emit("headsup:end", { scores: headsUpScoreboard(game, roomCode) });
      return;
    }

    let performerId = game.order[game.roundIndex % game.order.length];
    if (!members.has(performerId)) {
      return nextHeadsUpRound(io, roomCode); // skip anyone who's since left
    }

    const timeLimit = 60000;
    game.performerId = performerId;
    game.deck = shuffleArray(HEADSUP_WORDS);
    game.currentWord = game.deck.pop();
    game.wordsThisRound = 0;
    game.roundEndsAt = Date.now() + timeLimit;

    const performerInfo = members.get(performerId);
    io.to(`room:${roomCode}`).emit("headsup:round-start", {
      performerId,
      performerName: performerInfo.username,
      round: game.roundIndex + 1,
      totalRounds: game.totalRounds,
      timeLimit,
    });
    sendWordToGuessers(io, roomCode, performerId, game.currentWord);

    clearTimeout(game.timer);
    game.timer = setTimeout(() => revealHeadsUpRound(io, roomCode), timeLimit);
  }

  function handleHeadsUpAction(io, roomCode, userId, action) {
    const game = headsUpGames.get(roomCode);
    if (!game || !game.active) return;
    if (userId === game.performerId) return; // performer can't score their own round

    if (action === "correct") {
      game.scores[game.performerId] = (game.scores[game.performerId] || 0) + 10;
      game.wordsThisRound += 1;
    }

    if (game.deck.length === 0) game.deck = shuffleArray(HEADSUP_WORDS);
    game.currentWord = game.deck.pop();
    sendWordToGuessers(io, roomCode, game.performerId, game.currentWord);
    io.to(`room:${roomCode}`).emit("headsup:progress", {
      wordsThisRound: game.wordsThisRound,
      scores: headsUpScoreboard(game, roomCode),
    });
  }

  function revealHeadsUpRound(io, roomCode) {
    const game = headsUpGames.get(roomCode);
    if (!game) return;
    const members = roomMembers.get(roomCode);
    const performerInfo = members && members.get(game.performerId);
    io.to(`room:${roomCode}`).emit("headsup:round-end", {
      performerName: performerInfo ? performerInfo.username : "Player",
      wordsThisRound: game.wordsThisRound,
      scores: headsUpScoreboard(game, roomCode),
    });
    setTimeout(() => nextHeadsUpRound(io, roomCode), 3000);
  }
}

module.exports = { attachSockets };
