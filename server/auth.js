const jwt = require("jsonwebtoken");
const logger = require("./logger");

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
  logger.warn(
    "[auth] JWT_SECRET is not set — using an insecure default for local development only. " +
      "Set JWT_SECRET before deploying anywhere real."
  );
}

// Token lifetime is a security/convenience tradeoff: the token is stored in the browser's
// localStorage (so it's readable by any injected script), which means a shorter life
// limits the damage window if one ever leaks. Default 7 days is a reasonable middle ground
// for a casual hangout app; shorten it further (e.g. "1d") via JWT_EXPIRES_IN for anything
// more sensitive. A hardening step beyond this app's scope would be an httpOnly cookie plus
// a refresh-token rotation scheme.
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || "7d";

function signToken(user) {
  return jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, {
    expiresIn: JWT_EXPIRES_IN,
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
