const jwt = require("jsonwebtoken");

const isProd = process.env.NODE_ENV === "production";
let JWT_SECRET = process.env.JWT_SECRET;

if (!JWT_SECRET) {
  if (isProd) {
    // Refuse to boot with a guessable secret in production — a leaked/default JWT
    // secret lets anyone forge auth tokens for any user.
    throw new Error(
      "JWT_SECRET environment variable is required when NODE_ENV=production. " +
        "Set it to a long random string (e.g. `openssl rand -hex 32`) before starting the server."
    );
  }
  JWT_SECRET = "houseparty-clone-dev-secret-change-me";
  console.warn(
    "[auth] WARNING: JWT_SECRET is not set — using an insecure default for local development only. " +
      "Set JWT_SECRET before deploying anywhere real."
  );
}

function signToken(user) {
  return jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, {
    expiresIn: "30d",
  });
}

function verifyToken(token) {
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch (e) {
    return null;
  }
}

function requireAuth(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  const payload = token && verifyToken(token);
  if (!payload) return res.status(401).json({ error: "Not authenticated" });
  req.user = payload;
  next();
}

module.exports = { signToken, verifyToken, requireAuth, JWT_SECRET };
