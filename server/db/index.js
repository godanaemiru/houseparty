// Picks the database backend based on environment: a managed Postgres instance in
// production (DATABASE_URL set, e.g. by Render), or the zero-setup local SQLite file
// otherwise. Both backends implement the exact same async function names — see
// sqlite.js/postgres.js — so nothing else in the app needs to know which one is active.
const logger = require("../logger");

const backend = process.env.DATABASE_URL ? "postgres" : "sqlite";

if (!process.env.DATABASE_URL) {
  logger.info("[db] No DATABASE_URL set — using local SQLite (data.sqlite).");
} else {
  logger.info("[db] DATABASE_URL set — using Postgres.");
}

module.exports = require(`./${backend}`);
