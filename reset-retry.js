const Database = require('better-sqlite3');
const path = require('path');
const db = new Database(path.join(__dirname, 'applypilot.db'));

// Reset all failed jobs for retry
const r1 = db.prepare("UPDATE jobs SET status='new' WHERE status IN ('error', 'skipped')").run();
console.log(`Reset ${r1.changes} error/skipped → new`);

db.close();
