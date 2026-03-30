const db = require('better-sqlite3')('./applypilot.db');

// Reset skipped (incomplete external applies) + errors back to 'new' so we retry
const r1 = db.prepare("UPDATE jobs SET status='new', applied_at=NULL WHERE status='skipped'").run();
const r2 = db.prepare("UPDATE jobs SET status='new', applied_at=NULL WHERE status='error'").run();
console.log(`Reset: ${r1.changes} skipped + ${r2.changes} errors back to new`);

// Optionally also reset 'applied' (uncomment to re-apply all):
// const r3 = db.prepare("UPDATE jobs SET status='new', applied_at=NULL WHERE status='applied'").run();
// console.log(`Reset: ${r3.changes} applied jobs back to new`);

db.close();
