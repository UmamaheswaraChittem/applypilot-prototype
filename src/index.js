require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const { run: runLinkedIn } = require('./scrapers/linkedin');
const { run: runNaukri } = require('./scrapers/naukri');
const { run: runScorer } = require('./scoring/scorer');
const { run: applyLinkedIn } = require('./apply/linkedin');
const { run: applyNaukri } = require('./apply/naukri');
const { getStats, resetFailedJobs } = require('./db/database');

async function main() {
  const args = process.argv.slice(2);
  const cmd = args[0] || 'all';

  console.log('╔══════════════════════════════════════╗');
  console.log('║         ApplyPilot AI v1.0           ║');
  console.log('╚══════════════════════════════════════╝\n');

  try {
    if (cmd === 'linkedin') {
      await runLinkedIn();

    } else if (cmd === 'naukri') {
      await runNaukri();

    } else if (cmd === 'score') {
      runScorer();

    } else if (cmd === 'apply' || cmd === 'apply:all') {
      // Score first so we apply to the best jobs
      console.log('Scoring jobs before applying...\n');
      try { runScorer(); } catch (err) { console.error('Scorer error (non-fatal):', err.message); }
      console.log('\nApplying via LinkedIn + Naukri in parallel...\n');
      const [li, nk] = await Promise.allSettled([
        applyLinkedIn(),
        applyNaukri(),
      ]);
      const liResult = li.status === 'fulfilled' ? li.value : { applied: 0, skipped: 0, error: 0 };
      const nkResult = nk.status === 'fulfilled' ? nk.value : { applied: 0, skipped: 0, error: 0 };
      if (li.status === 'rejected') console.error('[apply:linkedin] Fatal:', li.reason?.message || li.reason);
      if (nk.status === 'rejected') console.error('[apply:naukri] Fatal:', nk.reason?.message || nk.reason);
      console.log(`\n✓ Apply complete — LinkedIn: ${liResult.applied} applied | Naukri: ${nkResult.applied} applied`);

    } else if (cmd === 'apply:linkedin') {
      runScorer();
      await applyLinkedIn();

    } else if (cmd === 'apply:naukri') {
      runScorer();
      await applyNaukri();

    } else if (cmd === 'retry') {
      // Reset failed/skipped jobs back to 'new' so they can be re-applied
      const count = resetFailedJobs();
      console.log(`Reset ${count} failed/skipped jobs back to 'new' status.`);
      console.log('Now running apply...\n');
      try { runScorer(); } catch (err) { console.error('Scorer error (non-fatal):', err.message); }
      const [li, nk] = await Promise.allSettled([applyLinkedIn(), applyNaukri()]);
      const liResult = li.status === 'fulfilled' ? li.value : { applied: 0, skipped: 0, error: 0 };
      const nkResult = nk.status === 'fulfilled' ? nk.value : { applied: 0, skipped: 0, error: 0 };
      if (li.status === 'rejected') console.error('[apply:linkedin] Fatal:', li.reason?.message || li.reason);
      if (nk.status === 'rejected') console.error('[apply:naukri] Fatal:', nk.reason?.message || nk.reason);
      console.log(`\n✓ Retry complete — LinkedIn: ${liResult.applied} applied | Naukri: ${nkResult.applied} applied`);

    } else if (cmd === 'stats') {
      const stats = getStats();
      console.log('Database Stats:');
      console.log(`  Total jobs  : ${stats.total}`);
      console.log(`  Scored      : ${stats.scored}`);
      console.log(`  Applied     : ${stats.applied}`);
      console.log('  By source   :', stats.bySource);
      console.log('\nTop Jobs:');
      stats.topJobs.forEach((j, i) => {
        console.log(`  ${i + 1}. [${((j.score || 0) * 100).toFixed(0)}%] ${j.title} @ ${j.company}`);
      });

    } else {
      // Default: scrape → score → apply
      console.log('Step 1/3: Scraping LinkedIn + Naukri in parallel...\n');
      const [liTotal, nkTotal] = await Promise.all([
        runLinkedIn().catch(err => { console.error('[linkedin] Error:', err.message); return 0; }),
        runNaukri().catch(err => { console.error('[naukri] Error:', err.message); return 0; }),
      ]);
      console.log(`\nScraped: LinkedIn=${liTotal} Naukri=${nkTotal}`);

      console.log('\nStep 2/3: Scoring all jobs...\n');
      runScorer();

      console.log('\nStep 3/3: Auto-applying to top jobs (LinkedIn + Naukri in parallel)...\n');
      const [liSettled, nkSettled] = await Promise.allSettled([
        applyLinkedIn(),
        applyNaukri(),
      ]);
      const li = liSettled.status === 'fulfilled' ? liSettled.value : { applied: 0, skipped: 0, error: 0 };
      const nk = nkSettled.status === 'fulfilled' ? nkSettled.value : { applied: 0, skipped: 0, error: 0 };
      if (liSettled.status === 'rejected') console.error('[apply:linkedin] Fatal:', liSettled.reason?.message);
      if (nkSettled.status === 'rejected') console.error('[apply:naukri] Fatal:', nkSettled.reason?.message);

      console.log('\n╔══════════════════════════════════════╗');
      console.log('║              SUMMARY                 ║');
      console.log('╚══════════════════════════════════════╝');
      console.log(`  Scraped  : LinkedIn=${liTotal}  Naukri=${nkTotal}`);
      console.log(`  Applied  : LinkedIn=${li.applied}  Naukri=${nk.applied}`);
      console.log(`  Skipped  : LinkedIn=${li.skipped}  Naukri=${nk.skipped}`);
      console.log('\nCommands:');
      console.log('  node src/index.js stats          — view DB stats');
      console.log('  node src/index.js apply          — re-run apply only');
      console.log('  node src/index.js apply:linkedin — LinkedIn only');
      console.log('  node src/index.js apply:naukri   — Naukri only');
    }
  } catch (err) {
    console.error('Fatal error:', err);
    process.exit(1);
  }
}

main();
