// This file only exists because it can't be deleted from an earlier version of the
// project — the real implementation now lives in ./db/ (index.js picks sqlite.js or
// postgres.js based on DATABASE_URL). Node resolves require("./db") to this file before
// it would look at the db/ directory, so this just forwards to the real thing.
module.exports = require("./db/index.js");
