// Zero-setup local database: Node's built-in node:sqlite, used whenever DATABASE_URL isn't
// set. All methods are async (return Promises) purely so callers can use the same `await
// db.foo()` code regardless of which backend (this or postgres.js) is active — the actual
// work here is synchronous under the hood.
const path = require("path");
const { DatabaseSync } = require("node:sqlite");

// Overridable so tests (and anyone running multiple instances locally) can point at an
// isolated file instead of sharing the app's real data.sqlite.
const dbPath = process.env.SQLITE_PATH || path.join(__dirname, "..", "..", "data.sqlite");
const db = new DatabaseSync(dbPath);

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
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      avatar_color TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS friendships (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      friend_id INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'accepted',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(user_id, friend_id)
    );

    CREATE TABLE IF NOT EXISTS rooms (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      host_id INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      active INTEGER NOT NULL DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS trivia_questions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      question TEXT NOT NULL,
      options TEXT NOT NULL,
      correct_index INTEGER NOT NULL,
      category TEXT
    );
  `);

  const count = db.prepare("SELECT COUNT(*) AS c FROM trivia_questions").get().c;
  if (count === 0) {
    const insert = db.prepare(
      "INSERT INTO trivia_questions (question, options, correct_index, category) VALUES (?, ?, ?, ?)"
    );
    db.exec("BEGIN");
    try {
      for (const row of TRIVIA_SEED) insert.run(row[0], JSON.stringify(row[1]), row[2], row[3]);
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  }
}

async function findUserIdByUsernameOrEmail(username, email) {
  return db.prepare("SELECT id FROM users WHERE username = ? OR email = ?").get(username, email) || null;
}

async function createUser({ username, email, passwordHash, avatarColor }) {
  const info = db
    .prepare("INSERT INTO users (username, email, password_hash, avatar_color) VALUES (?, ?, ?, ?)")
    .run(username, email, passwordHash, avatarColor);
  return db
    .prepare("SELECT id, username, email, avatar_color FROM users WHERE id = ?")
    .get(info.lastInsertRowid);
}

async function findUserForLogin(identifier) {
  return db.prepare("SELECT * FROM users WHERE username = ? OR email = ?").get(identifier, identifier) || null;
}

async function findPublicUserById(id) {
  return db.prepare("SELECT id, username, email, avatar_color FROM users WHERE id = ?").get(id) || null;
}

async function searchUsersByUsername(query, excludeId) {
  return db
    .prepare("SELECT id, username, avatar_color FROM users WHERE username LIKE ? AND id != ? LIMIT 10")
    .all(`%${query}%`, excludeId);
}

async function findUserByUsername(username) {
  return db.prepare("SELECT * FROM users WHERE username = ?").get(username) || null;
}

async function getFriends(userId) {
  return db
    .prepare(
      `SELECT u.id, u.username, u.avatar_color FROM friendships f
       JOIN users u ON u.id = f.friend_id
       WHERE f.user_id = ? AND f.status = 'accepted'`
    )
    .all(userId);
}

async function addFriendshipPair(userId, friendId) {
  const insert = db.prepare(
    "INSERT OR IGNORE INTO friendships (user_id, friend_id, status) VALUES (?, ?, 'accepted')"
  );
  db.exec("BEGIN");
  try {
    insert.run(userId, friendId);
    insert.run(friendId, userId);
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

async function getFriendIds(userId) {
  return db
    .prepare("SELECT friend_id FROM friendships WHERE user_id = ? AND status = 'accepted'")
    .all(userId)
    .map((r) => r.friend_id);
}

async function roomCodeExists(code) {
  return Boolean(db.prepare("SELECT id FROM rooms WHERE code = ?").get(code));
}

async function createRoom({ code, name, hostId }) {
  const info = db
    .prepare("INSERT INTO rooms (code, name, host_id) VALUES (?, ?, ?)")
    .run(code, name, hostId);
  return db.prepare("SELECT * FROM rooms WHERE id = ?").get(info.lastInsertRowid);
}

async function findActiveRoomByCode(code) {
  return db.prepare("SELECT * FROM rooms WHERE code = ? AND active = 1").get(code) || null;
}

async function getRandomTriviaQuestions(limit) {
  return db
    .prepare("SELECT * FROM trivia_questions ORDER BY RANDOM() LIMIT ?")
    .all(limit)
    .map((q) => ({ ...q, options: JSON.parse(q.options) }));
}

// Cheap liveness/readiness check for the /healthz route — confirms the DB handle can
// actually run a query, not just that the process holding it is alive.
async function ping() {
  db.prepare("SELECT 1").get();
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
