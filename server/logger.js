// Shared structured logger. In development this prints readable colored lines (via
// pino-pretty); in production it prints newline-delimited JSON, which is what most host
// log viewers (including Render's) expect for filtering/searching by level or field.
const pino = require("pino");

const isProd = process.env.NODE_ENV === "production";

const logger = pino({
  level: process.env.LOG_LEVEL || "info",
  transport: isProd
    ? undefined
    : {
        target: "pino-pretty",
        options: { colorize: true, translateTime: "HH:MM:ss", ignore: "pid,hostname" },
      },
});

module.exports = logger;
