// Spawns the app server as a real child process (not an in-process require()). Running
// it in-process would share the Node event loop with the test's own synchronous/async
// work and can deadlock the server's ability to respond to the test's own HTTP requests
// (seen firsthand while building this project) — a separate process avoids that entirely
// and also matches how the app actually runs in production.
const { spawn } = require("node:child_process");
const path = require("node:path");
const crypto = require("node:crypto");
const os = require("node:os");
const fs = require("node:fs");

const REPO_ROOT = path.join(__dirname, "..", "..");

let nextPort = 4100;

// Starts a fresh server instance on its own port with its own throwaway SQLite file
// (unless DATABASE_URL is passed in via extraEnv, e.g. from CI's Postgres service
// container), and waits for /healthz to return 200 before resolving.
async function startServer(extraEnv = {}) {
  const port = nextPort++;
  const sqlitePath = path.join(os.tmpdir(), `housie-test-${crypto.randomUUID()}.sqlite`);

  const env = {
    ...process.env,
    NODE_ENV: "test",
    PORT: String(port),
    JWT_SECRET: "test-secret-not-for-production",
    SQLITE_PATH: sqlitePath,
    LOG_LEVEL: "silent",
    // Functional tests fire lots of register/login calls in sequence; a high default keeps
    // the shared auth rate limiter from throttling them. Tests that actually exercise the
    // limiter (security.test.js) override this with a low value via extraEnv.
    AUTH_RATE_LIMIT: "1000",
    ...extraEnv,
  };

  const child = spawn(process.execPath, [path.join(REPO_ROOT, "server", "index.js")], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stderrBuf = "";
  child.stderr.on("data", (d) => { stderrBuf += d.toString(); });

  const baseUrl = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 15000;
  let lastErr;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Server process exited early (code ${child.exitCode}). stderr:\n${stderrBuf}`);
    }
    try {
      const res = await fetch(`${baseUrl}/healthz`);
      if (res.status === 200) {
        return {
          baseUrl,
          stop: () => stopServer(child, sqlitePath),
        };
      }
    } catch (err) {
      lastErr = err;
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  child.kill("SIGKILL");
  throw new Error(`Server did not become healthy in time. Last error: ${lastErr}. stderr:\n${stderrBuf}`);
}

function stopServer(child, sqlitePath) {
  child.kill("SIGKILL");
  try { fs.unlinkSync(sqlitePath); } catch { /* best effort cleanup */ }
}

module.exports = { startServer };
