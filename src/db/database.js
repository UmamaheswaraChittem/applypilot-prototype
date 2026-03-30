const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = path.join(__dirname, '../../applypilot.db');

let db;

function getDb() {
  if (!db) {
    db = new Database(DB_PATH);
    // Use DELETE journal mode to avoid WAL sidecar files (.db-wal/.db-shm)
    // which corrupt when the DB is accessed from both WSL and Windows
    db.pragma('journal_mode = DELETE');
    db.pragma('synchronous = FULL');
    initSchema();
  }
  return db;
}

function initSchema() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source TEXT NOT NULL,
      title TEXT NOT NULL,
      company TEXT NOT NULL,
      location TEXT,
      url TEXT UNIQUE NOT NULL,
      description TEXT,
      salary_raw TEXT,
      salary_min_lpa REAL,
      salary_max_lpa REAL,
      apply_type TEXT,
      posted_at TEXT,
      scraped_at TEXT DEFAULT (datetime('now')),
      score REAL,
      score_breakdown TEXT,
      status TEXT DEFAULT 'new',
      applied_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_jobs_source ON jobs(source);
    CREATE INDEX IF NOT EXISTS idx_jobs_score ON jobs(score DESC);
    CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);
  `);
  // Migration for existing DBs
  try { db.exec(`ALTER TABLE jobs ADD COLUMN applied_at TEXT`); } catch {}
}

function upsertJob(job) {
  const db = getDb();
  const stmt = db.prepare(`
    INSERT INTO jobs (source, title, company, location, url, description, salary_raw,
                      salary_min_lpa, salary_max_lpa, apply_type, posted_at)
    VALUES (@source, @title, @company, @location, @url, @description, @salary_raw,
            @salary_min_lpa, @salary_max_lpa, @apply_type, @posted_at)
    ON CONFLICT(url) DO UPDATE SET
      description = excluded.description,
      salary_raw = excluded.salary_raw,
      salary_min_lpa = excluded.salary_min_lpa,
      salary_max_lpa = excluded.salary_max_lpa,
      posted_at = excluded.posted_at
  `);
  return stmt.run(job);
}

function updateJobScore(url, score, breakdown) {
  const db = getDb();
  db.prepare(`UPDATE jobs SET score = ?, score_breakdown = ? WHERE url = ?`)
    .run(score, JSON.stringify(breakdown), url);
}

function getAllJobs(filter = {}) {
  const db = getDb();
  let query = 'SELECT * FROM jobs WHERE 1=1';
  const params = [];

  if (filter.source) { query += ' AND source = ?'; params.push(filter.source); }
  if (filter.minScore != null) { query += ' AND score >= ?'; params.push(filter.minScore); }
  if (filter.status) { query += ' AND status = ?'; params.push(filter.status); }

  query += ' ORDER BY score DESC NULLS LAST, scraped_at DESC';
  return db.prepare(query).all(...params);
}

function updateJobStatus(url, status) {
  const db = getDb();
  if (status === 'applied') {
    db.prepare(`UPDATE jobs SET status = ?, applied_at = datetime('now') WHERE url = ?`).run(status, url);
  } else {
    db.prepare(`UPDATE jobs SET status = ? WHERE url = ?`).run(status, url);
  }
}

function getJobsToApply({ source, minScore = 0.6, limit = 50 } = {}) {
  const db = getDb();
  // Include 'unknown' for LinkedIn (Easy Apply detection often fails at scrape time)
  // and 'external'/'quick_apply' for Naukri
  let query = `SELECT * FROM jobs WHERE status = 'new' AND score >= ?`;
  const params = [minScore];
  if (source) { query += ' AND source = ?'; params.push(source); }
  query += ' ORDER BY score DESC LIMIT ?';
  params.push(limit);
  return db.prepare(query).all(...params);
}

function getStats() {
  const db = getDb();
  return {
    total: db.prepare('SELECT COUNT(*) as n FROM jobs').get().n,
    bySource: db.prepare('SELECT source, COUNT(*) as n FROM jobs GROUP BY source').all(),
    scored: db.prepare('SELECT COUNT(*) as n FROM jobs WHERE score IS NOT NULL').get().n,
    applied: db.prepare("SELECT COUNT(*) as n FROM jobs WHERE status = 'applied'").get().n,
    topJobs: db.prepare('SELECT title, company, score FROM jobs WHERE score IS NOT NULL ORDER BY score DESC LIMIT 5').all(),
  };
}

function resetFailedJobs() {
  const db = getDb();
  const result = db.prepare(`UPDATE jobs SET status = 'new' WHERE status IN ('skipped', 'error', 'incomplete')`).run();
  return result.changes;
}

module.exports = { getDb, upsertJob, updateJobScore, getAllJobs, updateJobStatus, getJobsToApply, getStats, resetFailedJobs };
