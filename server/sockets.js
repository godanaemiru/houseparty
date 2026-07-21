const { verifyToken } = require("./auth");
const db = require("./db");

// In-memory presence + room state (fine for a single-process demo server)
const onlineUsers = new Map(); // userId -> Set(socketId)
const roomMembers = new Map(); // roomCode -> Map(userId -> {socketId, username, avatarColor})
const roomGames = new Map(); // roomCode -> trivia game state
const doodleGames = new Map(); // roomCode -> doodle game state
const userRooms = new Map(); // userId -> { code, name } — which room a user is currently in, if any

const DOODLE_WORDS = [
  "pizza", "guitar", "dolphin", "rocket", "castle", "umbrella", "penguin", "volcano",
  "sandwich", "robot", "unicorn", "lighthouse", "octopus", "cactus", "pirate", "dragon",
  "campfire", "skateboard", "waterfall", "telescope", "snowman", "butterfly", "tornado",
  "pumpkin", "backpack",
];

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

    // ----- Trivia game -----
    socket.on("game:start", () => {
      const roomCode = socket.roomCode;
      if (!roomCode) return;
      startTrivia(io, roomCode);
    });

    socket.on("game:answer", ({ questionId, answerIndex }) => {
      const roomCode = socket.roomCode;
      const game = roomGames.get(roomCode);
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
      io.to(`room:${roomCode}`).emit("game:answer-result", {
        userId,
        username: socket.username,
        correct,
        scores: scoreboard(game, roomCode),
      });
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
        roomGames.delete(roomCode);
        const dgame = doodleGames.get(roomCode);
        if (dgame) clearTimeout(dgame.timer);
        doodleGames.delete(roomCode);
      } else {
        // If the person drawing leaves mid-round, don't leave everyone else waiting forever.
        const dgame = doodleGames.get(roomCode);
        if (dgame && dgame.active && dgame.drawerId === socket.userId) {
          clearTimeout(dgame.timer);
          nextDoodleRound(io, roomCode);
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

  function scoreboard(game, roomCode) {
    const members = roomMembers.get(roomCode) || new Map();
    return Object.entries(game.scores).map(([uid, score]) => ({
      userId: Number(uid),
      username: (members.get(Number(uid)) || {}).username || "Player",
      score,
    })).sort((a, b) => b.score - a.score);
  }

  async function startTrivia(io, roomCode) {
    const existing = roomGames.get(roomCode);
    if (existing && existing.active) return;

    const questions = await db.getRandomTriviaQuestions(5);

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
    roomGames.set(roomCode, game);

    io.to(`room:${roomCode}`).emit("game:started", { totalQuestions: questions.length });
    nextQuestion(io, roomCode);
  }

  function nextQuestion(io, roomCode) {
    const game = roomGames.get(roomCode);
    if (!game) return;
    game.index += 1;

    if (game.index >= game.questions.length) {
      game.active = false;
      io.to(`room:${roomCode}`).emit("game:end", { scores: scoreboard(game, roomCode) });
      return;
    }

    const q = game.questions[game.index];
    game.questionId = q.id;
    game.correctIndex = q.correct_index;
    game.answered = new Set();
    game.questionStartedAt = Date.now();

    io.to(`room:${roomCode}`).emit("game:question", {
      questionId: q.id,
      index: game.index,
      total: game.questions.length,
      question: q.question,
      options: q.options,
      timeLimit: 10000,
    });

    clearTimeout(game.timer);
    game.timer = setTimeout(() => {
      io.to(`room:${roomCode}`).emit("game:reveal", {
        questionId: q.id,
        correctIndex: q.correct_index,
        scores: scoreboard(game, roomCode),
      });
      setTimeout(() => nextQuestion(io, roomCode), 2500);
    }, q.timeLimit || 10000);
  }
}

module.exports = { attachSockets };
