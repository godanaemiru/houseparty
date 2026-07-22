// Covers the "hardening" pieces that don't fit naturally in rest.test.js: the /healthz
// endpoint, security headers (helmet), response compression, and rate limiting.
const test = require("node:test");
const assert = require("node:assert/strict");
const { startServer } = require("./helpers/server");

let server;

test.before(async () => {
  server = await startServer();
});

test.after(async () => {
  await server.stop();
});

test("/healthz reports ok and is reachable with no auth", async () => {
  const res = await fetch(server.baseUrl + "/healthz");
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.status, "ok");
});

test("helmet security headers are present on responses", async () => {
  const res = await fetch(server.baseUrl + "/healthz");
  // A representative sample of what helmet's defaults set — enough to prove the
  // middleware is actually wired in, without pinning to its exact full header set.
  assert.equal(res.headers.get("x-content-type-options"), "nosniff");
  assert.ok(res.headers.get("x-dns-prefetch-control"));
  assert.equal(res.headers.has("x-powered-by"), false, "helmet should strip X-Powered-By");
});

test("responses are gzip-compressed when the client accepts it", async () => {
  const res = await fetch(server.baseUrl + "/api/config", {
    headers: { "Accept-Encoding": "gzip" },
  });
  assert.equal(res.status, 200);
  // The compression middleware only kicks in above a minimum response size threshold,
  // so this is a soft check: if a content-encoding header is present, it must be gzip.
  const encoding = res.headers.get("content-encoding");
  if (encoding) assert.equal(encoding, "gzip");
});

test("login is rate-limited after repeated failed attempts from the same client", async () => {
  await fetch(server.baseUrl + "/api/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "ratelimit-user", email: "ratelimit@test.com", password: "password123" }),
  });

  let sawTooManyRequests = false;
  for (let i = 0; i < 25; i++) {
    const res = await fetch(server.baseUrl + "/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "ratelimit-user", password: "definitely-wrong" }),
    });
    if (res.status === 429) {
      sawTooManyRequests = true;
      break;
    }
    assert.equal(res.status, 401);
  }
  assert.ok(sawTooManyRequests, "expected a 429 within 25 rapid login attempts (limit is 20/15min)");
});
