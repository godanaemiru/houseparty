const path = require("path");
const { DatabaseSync } = require("node:sqlite");

const dbPath = path.join(__dirname, "..", "data.sqlite");
const db = new DatabaseSync(dbPath);

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

// Seed trivia questions once
const count = db.prepare("SELECT COUNT(*) AS c FROM trivia_questions").get().c;
if (count === 0) {
  const insert = db.prepare(
    "INSERT INTO trivia_questions (question, options, correct_index, category) VALUES (?, ?, ?, ?)"
  );
  const seed = [
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
  db.exec("BEGIN");
  try {
    for (const row of seed) {
      insert.run(row[0], JSON.stringify(row[1]), row[2], row[3]);
    }
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

module.exports = db;
