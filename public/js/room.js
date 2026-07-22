Auth.requireAuth();
const me = Auth.getUser();

const params = new URLSearchParams(window.location.search);
const roomCode = (params.get("code") || "").toUpperCase();
document.getElementById("room-code-pill").textContent = roomCode;

const ICE_SERVERS = { iceServers: [{ urls: "stun:stun.l.google.com:19302" }] };

const videoGrid = document.getElementById("video-grid");
const peers = {}; // userId -> { pc, info, isInitiator }  (only used in "mesh" video mode)
let localStream = null;

// "mesh" (default, no setup needed) connects every participant directly to every other
// participant over WebRTC — simple, but tops out around 6-8 people. "livekit" instead
// routes media through a LiveKit SFU server, which scales much further. Which one we use
// is decided by the server based on whether LIVEKIT_* env vars are set (see README).
let videoMode = "mesh";
let livekitRoom = null;

// Caps resolution/framerate instead of asking for the camera's default (often 1080p+),
// which matters a lot on the mesh: every extra pixel/frame is duplicated N-1 times, once
// per peer. 720p/24fps is plenty for a face-in-a-grid video chat.
const CAMERA_CONSTRAINTS = {
  video: { width: { ideal: 1280, max: 1280 }, height: { ideal: 720, max: 720 }, frameRate: { ideal: 24, max: 24 } },
  audio: true,
};

async function init() {
  try {
    localStream = await navigator.mediaDevices.getUserMedia(CAMERA_CONSTRAINTS);
  } catch (err) {
    console.warn("Camera/mic unavailable, joining as viewer only:", err);
    localStream = new MediaStream();
    showMediaPermissionNotice(err);
  }
  addVideoTile("me", localStream, { username: me.username + " (you)", avatarColor: me.avatar_color }, true);

  try {
    const config = await api("/config");
    if (config.livekitEnabled && window.LivekitClient) {
      videoMode = "livekit";
    }
  } catch (err) {
    console.warn("Couldn't load server config, defaulting to WebRTC mesh:", err);
  }

  connectSocket(); // chat, presence, and game events always go over our own Socket.IO server
  if (videoMode === "livekit") {
    initLiveKit();
  }
  // (the mesh path is wired up from inside connectSocket()'s room:joined/peer-joined/webrtc:signal
  // handlers, and those handlers no-op automatically when videoMode is "livekit" — see below)
}

async function initLiveKit() {
  try {
    const { token, url } = await api("/livekit/token", { method: "POST", body: { roomCode } });
    const { Room, RoomEvent, Track } = window.LivekitClient;
    livekitRoom = new Room();

    livekitRoom.on(RoomEvent.TrackSubscribed, (track, _pub, participant) => {
      if (track.kind === Track.Kind.Video || track.kind === Track.Kind.Audio) {
        const el = track.attach();
        let tile = document.getElementById(`tile-${participant.identity}`);
        if (!tile) {
          tile = document.createElement("div");
          tile.className = "video-tile";
          tile.id = `tile-${participant.identity}`;
          const label = document.createElement("div");
          label.className = "label";
          label.textContent = participant.name || "Participant";
          tile.appendChild(label);
          videoGrid.appendChild(tile);
        }
        if (track.kind === Track.Kind.Video) tile.insertBefore(el, tile.firstChild);
      }
    });
    livekitRoom.on(RoomEvent.ParticipantDisconnected, (participant) => {
      removeVideoTile(participant.identity);
    });

    await livekitRoom.connect(url, token);
    // Match the same 720p cap used in mesh mode — LiveKit still forwards media through a
    // server, so keeping publish resolution modest reduces its bandwidth/CPU load too.
    const h720 = window.LivekitClient.VideoPresets && window.LivekitClient.VideoPresets.h720;
    await livekitRoom.localParticipant.setCameraEnabled(true, h720 ? { resolution: h720.resolution } : undefined);
    await livekitRoom.localParticipant.setMicrophoneEnabled(true);
  } catch (err) {
    console.error("LiveKit connection failed, falling back to WebRTC mesh:", err);
    videoMode = "mesh";
    // Re-run the mesh join path now that we know LiveKit isn't usable.
    if (socket && socket.connected) socket.emit("room:join", { code: roomCode, avatarColor: me.avatar_color });
  }
}

function showMediaPermissionNotice(err) {
  const denied = err && (err.name === "NotAllowedError" || err.name === "PermissionDeniedError");
  const notFound = err && (err.name === "NotFoundError" || err.name === "DevicesNotFoundError");
  const message = denied
    ? "Camera/mic access was blocked. You can still watch and chat, but others won't see or hear you."
    : notFound
    ? "No camera or microphone was found on this device. You can still watch and chat."
    : "Couldn't access your camera/mic. You can still watch and chat.";

  const banner = document.createElement("div");
  banner.id = "media-notice";
  banner.style.cssText =
    "background:rgba(255,94,94,0.15);border:1px solid rgba(255,94,94,0.4);color:var(--text);" +
    "padding:10px 14px;border-radius:10px;margin-bottom:12px;font-size:0.85rem;display:flex;" +
    "align-items:center;justify-content:space-between;gap:10px;";
  banner.innerHTML = `<span>${escapeHtml(message)}</span>`;

  const retryBtn = document.createElement("button");
  retryBtn.className = "secondary";
  retryBtn.textContent = "Try again";
  retryBtn.style.flexShrink = "0";
  retryBtn.onclick = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia(CAMERA_CONSTRAINTS);
      localStream.getTracks().forEach((t) => t.stop());
      localStream = stream;
      const meTile = document.getElementById("tile-me");
      if (meTile) meTile.querySelector("video").srcObject = localStream;
      // Swap the fresh tracks into any already-established peer connections.
      for (const id in peers) {
        const pc = peers[id].pc;
        for (const track of localStream.getTracks()) {
          const sender = pc.getSenders().find((s) => s.track && s.track.kind === track.kind);
          if (sender) sender.replaceTrack(track);
          else pc.addTrack(track, localStream);
        }
      }
      banner.remove();
    } catch (e) {
      console.warn("Retry failed:", e);
    }
  };
  banner.appendChild(retryBtn);
  videoGrid.parentElement.insertBefore(banner, videoGrid);
}

function addVideoTile(id, stream, info, muted) {
  const tile = document.createElement("div");
  tile.className = "video-tile";
  tile.id = `tile-${id}`;
  const video = document.createElement("video");
  video.autoplay = true;
  video.playsInline = true;
  if (muted) video.muted = true;
  video.srcObject = stream;
  const label = document.createElement("div");
  label.className = "label";
  label.textContent = info.username;
  tile.appendChild(video);
  tile.appendChild(label);
  videoGrid.appendChild(tile);
}

function removeVideoTile(id) {
  const tile = document.getElementById(`tile-${id}`);
  if (tile) tile.remove();
}

function setConnectionBanner(text) {
  let banner = document.getElementById("connection-banner");
  if (!text) {
    if (banner) banner.remove();
    return;
  }
  if (!banner) {
    banner = document.createElement("div");
    banner.id = "connection-banner";
    banner.style.cssText =
      "background:rgba(255,184,94,0.15);border:1px solid rgba(255,184,94,0.4);color:var(--text);" +
      "padding:8px 14px;border-radius:10px;margin-bottom:12px;font-size:0.85rem;";
    videoGrid.parentElement.insertBefore(banner, videoGrid);
  }
  banner.textContent = text;
}

function setPeerReconnecting(userId, isReconnecting) {
  const tile = document.getElementById(`tile-${userId}`);
  if (!tile) return;
  let tag = tile.querySelector(".reconnect-tag");
  if (isReconnecting) {
    if (!tag) {
      tag = document.createElement("div");
      tag.className = "reconnect-tag";
      tag.style.cssText =
        "position:absolute;top:8px;right:8px;background:rgba(255,184,94,0.85);color:#1a0b30;" +
        "font-size:0.7rem;font-weight:700;padding:3px 8px;border-radius:999px;";
      tag.textContent = "Reconnecting...";
      tile.appendChild(tag);
    }
  } else if (tag) {
    tag.remove();
  }
}

let socket;
let hasConnectedBefore = false;
function connectSocket() {
  socket = io({ auth: { token: Auth.getToken() } });

  socket.on("connect", () => {
    if (hasConnectedBefore) {
      // We dropped and reconnected (new socket.id server-side) — tear down the old mesh
      // before rejoining so we don't end up with duplicate/stale peer connections.
      pushChatSystemMessage("Reconnected — restoring video...");
      for (const id in peers) {
        peers[id].pc.close();
        removeVideoTile(id);
      }
      for (const id in peers) delete peers[id];
    }
    hasConnectedBefore = true;
    setConnectionBanner(null);
    socket.emit("room:join", { code: roomCode, avatarColor: me.avatar_color });
  });

  socket.on("disconnect", () => {
    setConnectionBanner("Connection lost — trying to reconnect...");
  });

  socket.on("connect_error", (err) => {
    if (err.message === "unauthorized") { Auth.clear(); window.location.href = "/index.html"; }
  });

  socket.on("room:error", ({ error }) => {
    alert(error);
    window.location.href = "/dashboard.html";
  });

  socket.on("room:joined", ({ peers: existingPeers }) => {
    if (videoMode !== "mesh") return; // LiveKit handles peer video itself
    for (const p of existingPeers) {
      createPeerConnection(p.userId, true, p);
    }
  });

  socket.on("room:peer-joined", (info) => {
    if (videoMode === "mesh") createPeerConnection(info.userId, false, info);
    pushChatSystemMessage(`${info.username} joined the room`);
  });

  socket.on("room:peer-left", ({ userId }) => {
    const entry = peers[userId];
    if (entry) {
      entry.pc.close();
      delete peers[userId];
    }
    removeVideoTile(userId);
    pushChatSystemMessage(`A participant left`);
  });

  socket.on("webrtc:signal", async ({ from, data }) => {
    if (videoMode !== "mesh") return;
    let entry = peers[from];
    if (!entry) entry = createPeerConnection(from, false, { username: "Participant", avatarColor: "#7b5eff" });
    const pc = entry.pc;
    try {
      if (data.sdp) {
        await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
        if (data.sdp.type === "offer") {
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          socket.emit("webrtc:signal", { to: from, data: { sdp: pc.localDescription } });
        }
      } else if (data.candidate) {
        await pc.addIceCandidate(new RTCIceCandidate(data.candidate));
      }
    } catch (err) {
      console.error("signal handling error", err);
    }
  });

  // Chat
  socket.on("chat:message", ({ userId, username, text }) => {
    appendChatMessage(username, text, userId === me.id);
  });

  // Trivia + Flag Quiz (both driven by the shared quiz UI factory below)
  socket.on("game:started", triviaUI.onStarted);
  socket.on("game:question", triviaUI.renderQuestion);
  socket.on("game:reveal", triviaUI.renderReveal);
  socket.on("game:end", triviaUI.renderEnd);
  socket.on("game:answer-result", ({ scores }) => triviaUI.renderLiveScores(scores));

  socket.on("flags:started", flagsUI.onStarted);
  socket.on("flags:question", flagsUI.renderQuestion);
  socket.on("flags:reveal", flagsUI.renderReveal);
  socket.on("flags:end", flagsUI.renderEnd);
  socket.on("flags:answer-result", ({ scores }) => flagsUI.renderLiveScores(scores));

  // Heads Up
  socket.on("headsup:started", () => {
    document.getElementById("start-headsup-btn").disabled = true;
  });
  socket.on("headsup:round-start", renderHeadsUpRound);
  socket.on("headsup:word", renderHeadsUpWord);
  socket.on("headsup:progress", renderHeadsUpProgress);
  socket.on("headsup:round-end", renderHeadsUpRoundEnd);
  socket.on("headsup:end", renderHeadsUpEnd);

  // Doodle game
  socket.on("doodle:started", startedDoodleUI);
  socket.on("doodle:round-start", renderDoodleRound);
  socket.on("doodle:your-word", ({ word }) => {
    isDrawingTurn = true;
    document.getElementById("doodle-word-display").textContent = word.toUpperCase();
    document.getElementById("doodle-hint").textContent = "Draw this word — others are guessing in Chat!";
  });
  socket.on("doodle:clear", clearDoodleCanvas);
  socket.on("doodle:draw", replayDoodleStroke);
  socket.on("doodle:correct-guess", ({ scores }) => renderDoodleScores(scores));
  socket.on("doodle:reveal", ({ word, scores }) => {
    document.getElementById("doodle-word-display").textContent = `The word was: ${word.toUpperCase()}`;
    renderDoodleScores(scores);
  });
  socket.on("doodle:end", renderDoodleEnd);
}

function createPeerConnection(userId, isInitiator, info) {
  const pc = new RTCPeerConnection(ICE_SERVERS);
  peers[userId] = { pc, info, isInitiator, reconnectTimer: null };

  for (const track of localStream.getTracks()) pc.addTrack(track, localStream);

  pc.onicecandidate = (e) => {
    if (e.candidate) socket.emit("webrtc:signal", { to: userId, data: { candidate: e.candidate } });
  };

  pc.ontrack = (e) => {
    if (!document.getElementById(`tile-${userId}`)) {
      addVideoTile(userId, e.streams[0], info, false);
    }
  };

  pc.oniceconnectionstatechange = () => {
    const state = pc.iceConnectionState;
    const entry = peers[userId];
    if (!entry) return;

    if (state === "connected" || state === "completed") {
      setPeerReconnecting(userId, false);
      clearTimeout(entry.reconnectTimer);
    } else if (state === "disconnected") {
      // Transient — WebRTC often recovers on its own within a few seconds. Show a hint
      // but don't force a restart yet.
      setPeerReconnecting(userId, true);
      clearTimeout(entry.reconnectTimer);
      entry.reconnectTimer = setTimeout(() => {
        if (pc.iceConnectionState === "disconnected") attemptIceRestart(userId);
      }, 3000);
    } else if (state === "failed") {
      setPeerReconnecting(userId, true);
      attemptIceRestart(userId);
    }
  };

  if (isInitiator) {
    pc.onnegotiationneeded = async () => {
      try {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        socket.emit("webrtc:signal", { to: userId, data: { sdp: pc.localDescription } });
      } catch (err) {
        console.error(err);
      }
    };
  }

  return peers[userId];
}

async function attemptIceRestart(userId) {
  const entry = peers[userId];
  if (!entry) return;
  const { pc, isInitiator } = entry;
  // Only the side that originally initiated the connection re-offers, so both sides don't
  // race to restart at once.
  if (!isInitiator) return;
  try {
    const offer = await pc.createOffer({ iceRestart: true });
    await pc.setLocalDescription(offer);
    socket.emit("webrtc:signal", { to: userId, data: { sdp: pc.localDescription } });
  } catch (err) {
    console.warn("ICE restart failed for", userId, err);
  }
}

// ---------- Controls ----------
let micOn = true, camOn = true;
document.getElementById("toggle-mic").onclick = (e) => {
  micOn = !micOn;
  localStream.getAudioTracks().forEach((t) => (t.enabled = micOn));
  e.currentTarget.classList.toggle("off", !micOn);
  e.currentTarget.textContent = micOn ? "🎙️" : "🔇";
};
document.getElementById("toggle-cam").onclick = (e) => {
  camOn = !camOn;
  localStream.getVideoTracks().forEach((t) => (t.enabled = camOn));
  e.currentTarget.classList.toggle("off", !camOn);
  e.currentTarget.textContent = camOn ? "📷" : "🚫";
};
document.getElementById("leave-room").onclick = () => {
  socket.emit("room:leave");
  for (const id in peers) peers[id].pc.close();
  if (livekitRoom) livekitRoom.disconnect();
  localStream.getTracks().forEach((t) => t.stop());
  window.location.href = "/dashboard.html";
};
document.getElementById("copy-link-btn").onclick = async () => {
  const link = `${window.location.origin}/room.html?code=${roomCode}`;
  try {
    await navigator.clipboard.writeText(link);
    const btn = document.getElementById("copy-link-btn");
    const original = btn.textContent;
    btn.textContent = "Copied!";
    setTimeout(() => (btn.textContent = original), 1500);
  } catch {
    prompt("Copy this invite link:", link);
  }
};

// ---------- Tabs ----------
const TAB_NAMES = ["chat", "game", "flags", "doodle", "headsup"];
document.querySelectorAll(".tab").forEach((tab) => {
  tab.onclick = () => {
    document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
    tab.classList.add("active");
    for (const name of TAB_NAMES) {
      document.getElementById(`${name}-tab`).style.display = tab.dataset.tab === name ? "flex" : "none";
    }
  };
});

// ---------- Chat ----------
const chatMessages = document.getElementById("chat-messages");
function appendChatMessage(username, text, isMe) {
  const div = document.createElement("div");
  div.className = "chat-msg";
  div.innerHTML = `<span class="who">${isMe ? "You" : escapeHtml(username)}:</span> ${escapeHtml(text)}`;
  chatMessages.appendChild(div);
  chatMessages.scrollTop = chatMessages.scrollHeight;
}
function pushChatSystemMessage(text) {
  const div = document.createElement("div");
  div.className = "chat-msg";
  div.style.color = "var(--text-dim)";
  div.style.fontStyle = "italic";
  div.textContent = text;
  chatMessages.appendChild(div);
  chatMessages.scrollTop = chatMessages.scrollHeight;
}
function escapeHtml(s) {
  const d = document.createElement("div");
  d.textContent = s;
  return d.innerHTML;
}
function sendChat() {
  const input = document.getElementById("chat-input");
  const text = input.value.trim();
  if (!text) return;
  socket.emit("chat:message", { text });
  input.value = "";
}
document.getElementById("chat-send-btn").onclick = sendChat;
document.getElementById("chat-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter") sendChat();
});

// ---------- Trivia + Flag Quiz ----------
// Both are "N multiple-choice questions with a countdown timer and live scoreboard" —
// this factory holds that UI logic once, parameterized by event-name prefix and which
// DOM panel to render into, so Flag Quiz didn't need its own copy-pasted 80 lines.
function createQuizUI({ prefix, panelId, startBtnId, questionExtraClass }) {
  let timer = null;

  function renderQuestion({ questionId, index, total, question, options, timeLimit }) {
    const panel = document.getElementById(panelId);
    panel.innerHTML = `
      <div style="width:100%">
        <div style="display:flex;justify-content:space-between;font-size:0.8rem;color:var(--text-dim);margin-bottom:8px">
          <span>Question ${index + 1}/${total}</span>
        </div>
        <div class="timer-bar"><div class="timer-fill" id="${prefix}-timer-fill" style="width:100%"></div></div>
      </div>
      <div class="game-question ${questionExtraClass || ""}">${escapeHtml(question)}</div>
      <div class="game-options" id="${prefix}-options"></div>
    `;
    const optionsEl = document.getElementById(`${prefix}-options`);
    options.forEach((opt, i) => {
      const btn = document.createElement("div");
      btn.className = "game-option";
      btn.textContent = opt;
      btn.onclick = () => {
        if (optionsEl.dataset.answered) return;
        optionsEl.dataset.answered = "1";
        btn.style.outline = "2px solid var(--blue)";
        socket.emit(`${prefix}:answer`, { questionId, answerIndex: i });
      };
      optionsEl.appendChild(btn);
    });

    const startedAt = Date.now();
    clearInterval(timer);
    timer = setInterval(() => {
      const pct = Math.max(0, 100 - ((Date.now() - startedAt) / timeLimit) * 100);
      const fill = document.getElementById(`${prefix}-timer-fill`);
      if (fill) fill.style.width = pct + "%";
      if (pct <= 0) clearInterval(timer);
    }, 100);
  }

  function renderReveal({ correctIndex, scores }) {
    clearInterval(timer);
    const optionsEl = document.getElementById(`${prefix}-options`);
    if (optionsEl) {
      [...optionsEl.children].forEach((btn, i) => {
        btn.classList.add(i === correctIndex ? "correct" : "wrong");
      });
    }
    renderLiveScores(scores);
  }

  function renderLiveScores(scores) {
    let board = document.getElementById(`${prefix}-live-scoreboard`);
    const panel = document.getElementById(panelId);
    if (!board) {
      board = document.createElement("div");
      board.className = "scoreboard";
      board.id = `${prefix}-live-scoreboard`;
      panel.appendChild(board);
    }
    board.innerHTML =
      "<div class='section-title'>Scores</div>" +
      scores.map((s) => `<div class="score-row"><span>${escapeHtml(s.username)}</span><span>${s.score}</span></div>`).join("");
  }

  function renderEnd({ scores }) {
    clearInterval(timer);
    const panel = document.getElementById(panelId);
    const winner = scores[0];
    panel.innerHTML = `
      <p style="font-size:1.1rem;font-weight:700">${winner ? escapeHtml(winner.username) + " wins! 🎉" : "Game over"}</p>
      <div class="scoreboard">
        <div class="section-title">Final Scores</div>
        ${scores.map((s) => `<div class="score-row"><span>${escapeHtml(s.username)}</span><span>${s.score}</span></div>`).join("")}
      </div>
      <button id="${prefix}-start-btn-2">Play again</button>
    `;
    document.getElementById(`${prefix}-start-btn-2`).onclick = () => socket.emit(`${prefix}:start`);
  }

  document.getElementById(startBtnId).onclick = () => socket.emit(`${prefix}:start`);

  return {
    renderQuestion,
    renderReveal,
    renderLiveScores,
    renderEnd,
    onStarted: () => { document.getElementById(startBtnId).disabled = true; },
  };
}

const triviaUI = createQuizUI({ prefix: "game", panelId: "game-panel", startBtnId: "start-game-btn" });
const flagsUI = createQuizUI({
  prefix: "flags",
  panelId: "flags-panel",
  startBtnId: "start-flags-btn",
  questionExtraClass: "flag-question",
});

// ---------- Heads Up ----------
document.getElementById("start-headsup-btn").onclick = () => socket.emit("headsup:start");
document.getElementById("headsup-correct-btn").onclick = () => socket.emit("headsup:correct");
document.getElementById("headsup-skip-btn").onclick = () => socket.emit("headsup:skip");

let headsUpTimerInterval = null;
let isHeadsUpPerformer = false;

function startedHeadsUpUI() {
  document.getElementById("headsup-idle-panel").style.display = "none";
  document.getElementById("headsup-active-panel").style.display = "flex";
}

function renderHeadsUpRound({ performerId, performerName, round, totalRounds, timeLimit }) {
  startedHeadsUpUI();
  isHeadsUpPerformer = performerId === me.id;

  document.getElementById("headsup-status").textContent = isHeadsUpPerformer
    ? `Your turn! Don't look — everyone else can see the word and will describe it. (Round ${round}/${totalRounds})`
    : `${performerName} is guessing — describe the word out loud! (Round ${round}/${totalRounds})`;
  document.getElementById("headsup-actions").style.display = isHeadsUpPerformer ? "none" : "flex";

  const wordEl = document.getElementById("headsup-word-display");
  wordEl.classList.toggle("hidden-for-performer", isHeadsUpPerformer);
  wordEl.textContent = isHeadsUpPerformer ? "🙈" : "…";
  document.getElementById("headsup-tally").textContent = "";

  const startedAt = Date.now();
  clearInterval(headsUpTimerInterval);
  headsUpTimerInterval = setInterval(() => {
    const pct = Math.max(0, 100 - ((Date.now() - startedAt) / timeLimit) * 100);
    const fill = document.getElementById("headsup-timer-fill");
    if (fill) fill.style.width = pct + "%";
    if (pct <= 0) clearInterval(headsUpTimerInterval);
  }, 100);
}

// Sent only to non-performer sockets — the performer's client never receives this event.
function renderHeadsUpWord({ word }) {
  if (isHeadsUpPerformer) return; // extra guard, shouldn't be reachable
  document.getElementById("headsup-word-display").textContent = word;
}

function renderHeadsUpProgress({ wordsThisRound, scores }) {
  document.getElementById("headsup-tally").textContent = `Words this round: ${wordsThisRound}`;
  renderHeadsUpScores(scores);
}

function renderHeadsUpScores(scores) {
  let board = document.getElementById("headsup-scoreboard");
  const panel = document.getElementById("headsup-active-panel");
  if (!board) {
    board = document.createElement("div");
    board.className = "scoreboard";
    board.id = "headsup-scoreboard";
    panel.appendChild(board);
  }
  board.innerHTML =
    "<div class='section-title'>Scores</div>" +
    scores.map((s) => `<div class="score-row"><span>${escapeHtml(s.username)}</span><span>${s.score}</span></div>`).join("");
}

function renderHeadsUpRoundEnd({ performerName, wordsThisRound, scores }) {
  clearInterval(headsUpTimerInterval);
  const wordEl = document.getElementById("headsup-word-display");
  wordEl.classList.remove("hidden-for-performer");
  wordEl.textContent = `${escapeHtml(performerName)} got ${wordsThisRound} word${wordsThisRound === 1 ? "" : "s"}!`;
  document.getElementById("headsup-actions").style.display = "none";
  renderHeadsUpScores(scores);
}

function renderHeadsUpEnd({ scores }) {
  clearInterval(headsUpTimerInterval);
  isHeadsUpPerformer = false;
  const winner = scores[0];
  const activePanel = document.getElementById("headsup-active-panel");
  activePanel.style.display = "none";
  const idlePanel = document.getElementById("headsup-idle-panel");
  idlePanel.style.display = "flex";
  idlePanel.innerHTML = `
    <p style="font-size:1.1rem;font-weight:700">${winner ? escapeHtml(winner.username) + " wins! 🎉" : "Game over"}</p>
    <div class="scoreboard">
      <div class="section-title">Final Scores</div>
      ${scores.map((s) => `<div class="score-row"><span>${escapeHtml(s.username)}</span><span>${s.score}</span></div>`).join("")}
    </div>
    <button id="start-headsup-btn-2">Play again</button>
  `;
  document.getElementById("start-headsup-btn-2").onclick = () => socket.emit("headsup:start");
}

// ---------- Doodle (drawing & guessing) ----------
const doodleCanvas = document.getElementById("doodle-canvas");
const doodleCtx = doodleCanvas.getContext("2d");
let isDrawingTurn = false;
let isPointerDown = false;
let doodleTimerInterval = null;

document.getElementById("start-doodle-btn").onclick = () => socket.emit("doodle:start");

function clearDoodleCanvas() {
  doodleCtx.fillStyle = "#ffffff";
  doodleCtx.fillRect(0, 0, doodleCanvas.width, doodleCanvas.height);
}
clearDoodleCanvas();

function canvasPointFromEvent(e) {
  const rect = doodleCanvas.getBoundingClientRect();
  const clientX = e.touches ? e.touches[0].clientX : e.clientX;
  const clientY = e.touches ? e.touches[0].clientY : e.clientY;
  // Normalize to 0..1 so strokes replay correctly regardless of each viewer's canvas size.
  return {
    x: (clientX - rect.left) / rect.width,
    y: (clientY - rect.top) / rect.height,
  };
}

function drawSegment(fromNorm, toNorm) {
  doodleCtx.strokeStyle = "#1a0b30";
  doodleCtx.lineWidth = 4;
  doodleCtx.lineCap = "round";
  doodleCtx.beginPath();
  doodleCtx.moveTo(fromNorm.x * doodleCanvas.width, fromNorm.y * doodleCanvas.height);
  doodleCtx.lineTo(toNorm.x * doodleCanvas.width, toNorm.y * doodleCanvas.height);
  doodleCtx.stroke();
}

let lastLocalPoint = null;
function startLocalStroke(e) {
  if (!isDrawingTurn) return;
  isPointerDown = true;
  lastLocalPoint = canvasPointFromEvent(e);
  socket.emit("doodle:draw", { type: "start", ...lastLocalPoint });
}
function moveLocalStroke(e) {
  if (!isDrawingTurn || !isPointerDown) return;
  const point = canvasPointFromEvent(e);
  drawSegment(lastLocalPoint, point);
  socket.emit("doodle:draw", { type: "move", ...point });
  lastLocalPoint = point;
}
function endLocalStroke() {
  if (!isDrawingTurn) return;
  isPointerDown = false;
  lastLocalPoint = null;
}
doodleCanvas.addEventListener("mousedown", startLocalStroke);
doodleCanvas.addEventListener("mousemove", moveLocalStroke);
window.addEventListener("mouseup", endLocalStroke);
doodleCanvas.addEventListener("touchstart", (e) => { e.preventDefault(); startLocalStroke(e); });
doodleCanvas.addEventListener("touchmove", (e) => { e.preventDefault(); moveLocalStroke(e); });
doodleCanvas.addEventListener("touchend", (e) => { e.preventDefault(); endLocalStroke(); });

let lastRemotePoint = null;
function replayDoodleStroke(stroke) {
  if (stroke.type === "start") {
    lastRemotePoint = { x: stroke.x, y: stroke.y };
  } else if (stroke.type === "move" && lastRemotePoint) {
    drawSegment(lastRemotePoint, stroke);
    lastRemotePoint = { x: stroke.x, y: stroke.y };
  } else if (stroke.type === "end") {
    lastRemotePoint = null;
  }
}

function startedDoodleUI() {
  document.getElementById("doodle-idle-panel").style.display = "none";
  document.getElementById("doodle-active-panel").style.display = "flex";
}

function renderDoodleRound({ drawerId, drawerName, wordLength, round, totalRounds, timeLimit }) {
  startedDoodleUI();
  isDrawingTurn = drawerId === me.id;
  clearDoodleCanvas();

  document.getElementById("doodle-status").textContent = isDrawingTurn
    ? `Your turn to draw! (Round ${round}/${totalRounds})`
    : `${drawerName} is drawing (Round ${round}/${totalRounds})`;
  document.getElementById("doodle-hint").textContent = isDrawingTurn
    ? "Draw the word shown above — others are guessing in Chat!"
    : "Guess in the Chat tab!";
  document.getElementById("doodle-word-display").textContent = isDrawingTurn
    ? ""
    : Array(wordLength).fill("_").join(" ");

  const startedAt = Date.now();
  clearInterval(doodleTimerInterval);
  doodleTimerInterval = setInterval(() => {
    const pct = Math.max(0, 100 - ((Date.now() - startedAt) / timeLimit) * 100);
    const fill = document.getElementById("doodle-timer-fill");
    if (fill) fill.style.width = pct + "%";
    if (pct <= 0) clearInterval(doodleTimerInterval);
  }, 100);
}

function renderDoodleScores(scores) {
  let board = document.getElementById("doodle-scoreboard");
  const panel = document.getElementById("doodle-active-panel");
  if (!board) {
    board = document.createElement("div");
    board.className = "scoreboard";
    board.id = "doodle-scoreboard";
    panel.appendChild(board);
  }
  board.innerHTML =
    "<div class='section-title'>Scores</div>" +
    scores.map((s) => `<div class="score-row"><span>${escapeHtml(s.username)}</span><span>${s.score}</span></div>`).join("");
}

function renderDoodleEnd({ scores }) {
  clearInterval(doodleTimerInterval);
  isDrawingTurn = false;
  const winner = scores[0];
  const activePanel = document.getElementById("doodle-active-panel");
  activePanel.style.display = "none";
  const idlePanel = document.getElementById("doodle-idle-panel");
  idlePanel.style.display = "flex";
  idlePanel.innerHTML = `
    <p style="font-size:1.1rem;font-weight:700">${winner ? escapeHtml(winner.username) + " wins! 🎉" : "Game over"}</p>
    <div class="scoreboard">
      <div class="section-title">Final Scores</div>
      ${scores.map((s) => `<div class="score-row"><span>${escapeHtml(s.username)}</span><span>${s.score}</span></div>`).join("")}
    </div>
    <button id="start-doodle-btn-2">Play again</button>
  `;
  document.getElementById("start-doodle-btn-2").onclick = () => socket.emit("doodle:start");
}

init();
