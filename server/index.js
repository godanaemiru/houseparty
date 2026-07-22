const path = require("path");
const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const compression = require("compression");
const http = require("http");
const { Server } = require("socket.io");

const db = require("./db");
const routes = require("./routes");
const logger = require("./logger");
const { attachSockets } = require("./sockets");

// Lock down cross-origin access when ALLOWED_ORIGINS is set (comma-separated list of
// origins, e.g. "https://myapp.com,https://www.myapp.com"). Falls back to allowing any
// origin, which is fine for local development but should be set explicitly in production.
const allowedOrigins = (process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);
const corsOrigin = allowedOrigins.length > 0 ? allowedOrigins : "*";
if (allowedOrigins.length === 0 && process.env.NODE_ENV === "production") {
  logger.warn(
    "[cors] ALLOWED_ORIGINS is not set in production — accepting requests from any origin."
  );
}

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: corsOrigin } });

// Security headers (helmet sets a solid baseline: X-Content-Type-Options, X-Frame-Options,
// HSTS, etc.). Content-Security-Policy is disabled because every page in this app relies
// on inline <script> blocks (no separate bundle/build step) — a default CSP would block
// all of them from running. If a stricter CSP is wanted later, it needs nonces/hashes
// threaded through every inline script tag first.
app.use(helmet({ contentSecurityPolicy: false }));

// Compress JSON/HTML/JS/CSS responses. Doesn't touch WebSocket traffic (socket.io runs
// its own framing over the upgraded connection) so this is purely for the REST API and
// static frontend assets.
app.use(compression());

app.use(cors({ origin: corsOrigin }));
app.use(express.json());

// Liveness/readiness check for uptime monitors and Render's health check config. Confirms
// not just that the process is up but that it can actually reach the database.
app.get("/healthz", async (req, res) => {
  try {
    await db.ping();
    res.json({ status: "ok" });
  } catch (err) {
    logger.error({ err }, "Health check failed");
    res.status(503).json({ status: "error" });
  }
});

app.use("/api", routes);

app.use(express.static(path.join(__dirname, "..", "public")));
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "..", "public", "index.html"));
});

attachSockets(io);

const PORT = process.env.PORT || 3000;

db.init()
  .then(() => {
    server.listen(PORT, () => {
      logger.info(`Houseparty clone server running on http://localhost:${PORT}`);
    });
  })
  .catch((err) => {
    logger.error({ err }, "Failed to initialize database");
    process.exit(1);
  });
