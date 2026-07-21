const path = require("path");
const express = require("express");
const cors = require("cors");
const http = require("http");
const { Server } = require("socket.io");

const db = require("./db");
const routes = require("./routes");
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
  console.warn(
    "[cors] WARNING: ALLOWED_ORIGINS is not set in production — accepting requests from any origin."
  );
}

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: corsOrigin } });

app.use(cors({ origin: corsOrigin }));
app.use(express.json());

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
      console.log(`Houseparty clone server running on http://localhost:${PORT}`);
    });
  })
  .catch((err) => {
    console.error("Failed to initialize database:", err);
    process.exit(1);
  });
