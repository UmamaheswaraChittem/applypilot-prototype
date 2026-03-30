const Database = require('better-sqlite3');
const path = require('path');
const db = new Database(path.join(__dirname, 'applypilot.db'));

console.log('=== Status Counts ===');
db.prepare("SELECT source, status, count(1) as c FROM jobs GROUP BY source, status ORDER BY source, status")
  .all().forEach(r => console.log(`  ${r.source} ${r.status}: ${r.c}`));

console.log('\n=== LinkedIn New Jobs (top 20 by score) ===');
db.prepare("SELECT title, company, url, score FROM jobs WHERE source='linkedin' AND status='new' ORDER BY score DESC LIMIT 20")
  .all().forEach(r => {
    const isEasyApply = !r.url.includes('jobs/search');
    console.log(`  [${r.score.toFixed(2)}] ${r.title.substring(0, 50)} @ ${r.company.substring(0, 20)} ${r.url.substring(0, 60)}`);
  });

console.log('\n=== Naukri New Jobs (top 10 by score) ===');
db.prepare("SELECT title, company, url, score FROM jobs WHERE source='naukri' AND status='new' ORDER BY score DESC LIMIT 10")
  .all().forEach(r => console.log(`  [${r.score.toFixed(2)}] ${r.title.substring(0, 50)} @ ${r.company.substring(0, 20)} ${r.url.substring(0, 60)}`));

console.log('\n=== LinkedIn Applied Jobs ===');
db.prepare("SELECT title, company, score FROM jobs WHERE source='linkedin' AND status='applied' ORDER BY score DESC")
  .all().forEach(r => console.log(`  [${r.score.toFixed(2)}] ${r.title.substring(0, 50)} @ ${r.company.substring(0, 25)}`));

db.close();
