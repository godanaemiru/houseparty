const { AccessToken } = require("livekit-server-sdk");

// LiveKit is an optional upgrade over the built-in WebRTC mesh (see README). It's only
// "on" when all three of these are set — otherwise the app quietly falls back to the mesh.
function isLiveKitConfigured() {
  return Boolean(
    process.env.LIVEKIT_URL && process.env.LIVEKIT_API_KEY && process.env.LIVEKIT_API_SECRET
  );
}

async function createLiveKitToken({ roomCode, userId, username }) {
  const at = new AccessToken(process.env.LIVEKIT_API_KEY, process.env.LIVEKIT_API_SECRET, {
    identity: String(userId),
    name: username,
  });
  at.addGrant({
    room: roomCode,
    roomJoin: true,
    canPublish: true,
    canSubscribe: true,
  });
  return at.toJwt();
}

module.exports = { isLiveKitConfigured, createLiveKitToken };
