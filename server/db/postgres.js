// Production database backend: used whenever DATABASE_URL is set (e.g. on Render with a
// managed Postgres instance attached). Same method names/shapes as sqlite.js so routes.js
// and sockets.js don't need to know which backend is active.
const { Pool } = require("pg");
const logger = require("../logger");

function isLocalDatabase(connectionString) {
  if (!connectionString) return true;
  try {
    const { hostname } = new URL(connectionString);
    return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
  } catch {
    return false;
  }
}

// Pool size: Render's free Postgres plan caps total connections fairly low (typically
// ~20-ish shared across all of a project's usage), and each web dyno/instance gets its
// own pool. Default to a conservative 10 so a couple of instances can't exhaust the
// database's connection limit between them; override via PG_POOL_MAX if you know your
// plan's limit and want to tune it.
const poolMax = Number.parseInt(process.env.PG_POOL_MAX, 10) || 10;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // Most managed Postgres providers (Render included) require SSL but use a certificate
  // that isn't in Node's default trust store — this is the standard escape hatch for that.
  // A local Postgres (dev/testing) typically has no SSL configured at all, so skip it there.
  ssl: isLocalDatabase(process.env.DATABASE_URL) ? false : { rejectUnauthorized: false },
  max: poolMax,
  // Close connections that have been idle a while so we don't hold onto more of the
  // database's connection budget than we're actually using.
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
});

// Without this, an unexpected error on an *idle* pooled connection (a network blip, the
// database restarting, etc.) is an unhandled 'error' event, which crashes the whole
// Node process. Logging it instead keeps the server up so pg can reconnect on next query.
pool.on("error", (err) => {
  logger.error({ err }, "Unexpected error on idle Postgres client");
});

const TRIVIA_SEED = [
  ["What planet is known as the Red Planet?", ["Venus", "Mars", "Jupiter", "Saturn"], 1, "Science"],
  ["Which ocean is the largest?", ["Atlantic", "Indian", "Arctic", "Pacific"], 3, "Geography"],
  ["How many strings does a standard guitar have?", ["4", "6", "7", "5"], 1, "Music"],
  ["What is the capital of Japan?", ["Seoul", "Beijing", "Tokyo", "Bangkok"], 2, "Geography"],
  ["Which gas do plants primarily absorb?", ["Oxygen", "Nitrogen", "Carbon Dioxide", "Hydrogen"], 2, "Science"],
  ["Who painted the Mona Lisa?", ["Van Gogh", "Da Vinci", "Picasso", "Monet"], 1, "Art"],
  ["What is the smallest prime number?", ["0", "1", "2", "3"], 2, "Math"],
  ["Which animal is the fastest on land?", ["Lion", "Cheetah", "Horse", "Antelope"], 1, "Nature"],
  ["What year did the Titanic sink?", ["1905", "1912", "1918", "1923"], 1, "History"],
  ["How many continents are there?", ["5", "6", "7", "8"], 2, "Geography"],
  ["What is the chemical symbol for gold?", ["Ag", "Au", "Gd", "Go"], 1, "Science"],
  ["Which country invented pizza?", ["France", "Spain", "Italy", "Greece"], 2, "Food"],
];

async function init() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      avatar_color TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS friendships (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL,
      friend_id INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'accepted',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE(user_id, friend_id)
    );

    CREATE TABLE IF NOT EXISTS rooms (
      id SERIAL PRIMARY KEY,
      code TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      host_id INTEGER NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      active INTEGER NOT NULL DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS trivia_questions (
      id SERIAL PRIMARY KEY,
      question TEXT NOT NULL,
      options TEXT NOT NULL,
      correct_index INTEGER NOT NULL,
      category TEXT
    );
  `);

  const { rows } = await pool.query("SELECT COUNT(*)::int AS c FROM trivia_questions");
  if (rows[0].c === 0) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      for (const row of TRIVIA_SEED) {
        await client.query(
          "INSERT INTO trivia_questions (question, options, correct_index, category) VALUES ($1, $2, $3, $4)",
          [row[0], JSON.stringify(row[1]), row[2], row[3]]
        );
      }
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  }
}

async function findUserIdByUsernameOrEmail(username, email) {
  const { rows } = await pool.query("SELECT id FROM users WHERE username = $1 OR email = $2", [username, email]);
  return rows[0] || null;
}

async function createUser({ username, email, passwordHash, avatarColor }) {
  const { rows } = await pool.query(
    `INSERT INTO users (username, email, password_hash, avatar_color)
     VALUES ($1, $2, $3, $4)
     RETURNING id, username, email, avatar_color`,
    [username, email, passwordHash, avatarColor]
  );
  return rows[0];
}

async function findUserForLogin(identifier) {
  const { rows } = await pool.query("SELECT * FROM users WHERE username = $1 OR email = $1", [identifier]);
  return rows[0] || null;
}

async function findPublicUserById(id) {
  const { rows } = await pool.query(
    "SELECT id, username, email, avatar_color FROM users WHERE id = $1",
    [id]
  );
  return rows[0] || null;
}

async function searchUsersByUsername(query, excludeId) {
  const { rows } = await pool.query(
    "SELECT id, username, avatar_color FROM users WHERE username ILIKE $1 AND id != $2 LIMIT 10",
    [`%${query}%`, excludeId]
  );
  return rows;
}

async function findUserByUsername(username) {
  const { rows } = await pool.query("SELECT * FROM users WHERE username = $1", [username]);
  return rows[0] || null;
}

async function getFriends(userId) {
  const { rows } = await pool.query(
    `SELECT u.id, u.username, u.avatar_color FROM friendships f
     JOIN users u ON u.id = f.friend_id
     WHERE f.user_id = $1 AND f.status = 'accepted'`,
    [userId]
  );
  return rows;
}

async function addFriendshipPair(userId, friendId) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "INSERT INTO friendships (user_id, friend_id, status) VALUES ($1, $2, 'accepted') ON CONFLICT (user_id, friend_id) DO NOTHING",
      [userId, friendId]
    );
    await client.query(
      "INSERT INTO friendships (user_id, friend_id, status) VALUES ($1, $2, 'accepted') ON CONFLICT (user_id, friend_id) DO NOTHING",
      [friendId, userId]
    );
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

async function getFriendIds(userId) {
  const { rows } = await pool.query(
    "SELECT friend_id FROM friendships WHERE user_id = $1 AND status = 'accepted'",
    [userId]
  );
  return rows.map((r) => r.friend_id);
}

async function roomCodeExists(code) {
  const { rows } = await pool.query("SELECT id FROM rooms WHERE code = $1", [code]);
  return rows.length > 0;
}

async function createRoom({ code, name, hostId }) {
  const { rows } = await pool.query(
    "INSERT INTO rooms (code, name, host_id) VALUES ($1, $2, $3) RETURNING *",
    [code, name, hostId]
  );
  return rows[0];
}

async function findActiveRoomByCode(code) {
  const { rows } = await pool.query("SELECT * FROM rooms WHERE code = $1 AND active = 1", [code]);
  return rows[0] || null;
}

async function getRandomTriviaQuestions(limit) {
  const { rows } = await pool.query("SELECT * FROM trivia_questions ORDER BY RANDOM() LIMIT $1", [limit]);
  return rows.map((q) => ({ ...q, options: JSON.parse(q.options) }));
}

async function ping() {
  await pool.query("SELECT 1");
}

module.exports = {
  init,
  ping,
  findUserIdByUsernameOrEmail,
  createUser,
  findUserForLogin,
  findPublicUserById,
  searchUsersByUsername,
  findUserByUsername,
  getFriends,
  addFriendshipPair,
  getFriendIds,
  roomCodeExists,
  createRoom,
  findActiveRoomByCode,
  getRandomTriviaQuestions,
};
