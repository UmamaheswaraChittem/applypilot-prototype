require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const { chromium } = require('playwright');
const { humanDelay, saveCookies, loadCookies, parseSalaryLPA, parsePostedAt } = require('./utils');
const { waitForPageStable } = require('../stealth');
const { upsertJob } = require('../db/database');

const SEARCH_QUERIES = [
  // Core Node.js roles — primary skill
  'Senior Node.js Engineer',
  'Technical Lead Node.js',
  'Node.js TypeScript Developer',
  'Principal Backend Engineer',

  // Conversational AI / Chatbot — key differentiator on resume
  'Conversational AI Engineer',
  'Chatbot Developer',
  'Cognigy Developer',
  'IVR Developer',
  'AI Platform Engineer',
  'Virtual Assistant Developer',
  'WhatsApp Bot Developer',

  // LLM / GenAI — hot market
  'LLM Engineer',
  'Generative AI Engineer',
  'AI Engineer Node.js',
  'Technical Lead AI',

  // Senior / high-paying
  'Engineering Manager Node.js',
  'Solution Architect Node.js',
  'Senior Software Engineer Remote',
];

const JOBS_PER_SEARCH = parseInt(process.env.JOBS_PER_SEARCH || '20');
const HEADLESS = process.env.HEADLESS !== 'false';
const PARALLEL = parseInt(process.env.PARALLEL_QUERIES || '3');
// Use a lower salary floor for URL filter so we don't miss jobs (we filter precisely in scorer)
const SALARY_FILTER = Math.max(20, parseInt(process.env.EXPECTED_CTC_LPA || '30') - 15);

async function loginNaukri(page) {
  const cookies = loadCookies('naukri');
  if (cookies) {
    console.log('[naukri] Loading saved session cookies...');
    await page.context().addCookies(cookies);
  }

  // Check session via login page — if it redirects away, we're logged in
  await page.goto('https://www.naukri.com/nlogin/login', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await waitForPageStable(page, { maxWait: 1500 });
  const url = page.url();
  if (!url.includes('/login')) {
    console.log('[naukri] Session valid');
    return;
  }

  // Actually on login page — fill credentials
  console.log('[naukri] Logging in...');
  // Wait for field to be visible (not just in DOM)
  await page.waitForSelector('#usernameField:not([type="hidden"])', { timeout: 15000 });
  await page.fill('#usernameField', process.env.NAUKRI_EMAIL);
  await humanDelay();
  await page.fill('#passwordField', process.env.NAUKRI_PASSWORD);
  await humanDelay();
  const btn = await page.$('button[type="submit"]') || await page.$('.loginButton');
  if (btn) await btn.click(); else await page.keyboard.press('Enter');
  await waitForPageStable(page, { maxWait: 5000 });
  const cookies2 = await page.context().cookies();
  saveCookies('naukri', cookies2);
  console.log('[naukri] Logged in');
}

function parseApiJob(j) {
  try {
    const title    = (j.title || j.jobTitle || '').trim();
    const company  = (j.companyName || j.company || 'Unknown').trim();
    const location = (j.placeholders || []).find(p => p.type === 'location')?.label ||
                     (Array.isArray(j.location) ? j.location.join(', ') : j.location || '');
    const salary   = (j.placeholders || []).find(p => p.type === 'salary')?.label || '';
    const rawUrl   = j.jdURL || j.jobUrl || '';
    const url      = rawUrl.startsWith('http') ? rawUrl : `https://www.naukri.com${rawUrl}`;
    const skills   = j.tagsAndSkills || j.keySkills || '';
    const desc     = j.jobDescription || (j.snippets || []).join(' ') || '';
    const posted   = j.footerPlaceholderLabel || j.modifiedDate || '';
    const applyType = (j.applyButton?.buttonText || '').toLowerCase().includes('quick') ? 'quick_apply' : 'external';

    if (!title || !url || url === 'https://www.naukri.com') return null;

    const { min, max } = parseSalaryLPA(salary);
    return {
      source: 'naukri', title, company,
      location: location.trim(),
      url: url.split('?')[0],
      description: `${desc}\n\nSkills: ${skills}`.trim(),
      salary_raw: salary || null,
      salary_min_lpa: min, salary_max_lpa: max,
      apply_type: applyType,
      posted_at: parsePostedAt(posted),
    };
  } catch { return null; }
}

async function scrapeQuery(page, query) {
  const slug = query.toLowerCase().replace(/[^a-z0-9\s]/g, '').trim().replace(/\s+/g, '-');
  const searchUrl = `https://www.naukri.com/${slug}-jobs-in-india?jobAge=7&salary=${SALARY_FILTER}&experience=5`;

  console.log(`\n[naukri] Scraping: "${query}"`);

  // Intercept Naukri's internal API response
  let capturedJobs = [];
  const responseHandler = async (response) => {
    const url = response.url();
    if (url.includes('/jobapi/') && url.includes('search')) {
      try {
        const json = await response.json();
        if (json?.jobDetails?.length) capturedJobs = json.jobDetails;
      } catch {}
    }
  };

  page.on('response', responseHandler);
  try {
    await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 35000 });
  } catch {
    console.warn('  Navigation slow — continuing anyway');
  }

  // Wait for API call to complete
  await waitForPageStable(page, { maxWait: 6000 });
  page.off('response', responseHandler);

  if (capturedJobs.length === 0) {
    // Fallback: try without salary filter
    console.log('  No jobs from API — retrying without salary filter...');
    const fallbackUrl = `https://www.naukri.com/${slug}-jobs-in-india?jobAge=15&experience=5`;
    let capturedFallback = [];
    const fallbackHandler = async (response) => {
      const url = response.url();
      if (url.includes('/jobapi/') && url.includes('search')) {
        try {
          const json = await response.json();
          if (json?.jobDetails?.length) capturedFallback = json.jobDetails;
        } catch {}
      }
    };
    page.on('response', fallbackHandler);
    try {
      await page.goto(fallbackUrl, { waitUntil: 'domcontentloaded', timeout: 35000 });
    } catch {}
    await waitForPageStable(page, { maxWait: 6000 });
    page.off('response', fallbackHandler);
    capturedJobs = capturedFallback;
  }

  if (capturedJobs.length === 0) {
    console.log('  No jobs captured from API');
    return 0;
  }

  let saved = 0;
  for (const j of capturedJobs.slice(0, JOBS_PER_SEARCH)) {
    const job = parseApiJob(j);
    if (job) {
      upsertJob(job);
      saved++;
      console.log(`  [${saved}] ${job.title} @ ${job.company} | ${job.location} | ${job.salary_raw || 'N/A'}`);
    }
  }
  console.log(`  → Saved ${saved} jobs`);
  return saved;
}

async function run() {
  const browser = await chromium.launch({
    headless: HEADLESS,
    args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'],
  });

  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    viewport: { width: 1366, height: 768 },
    locale: 'en-IN',
  });

  // Login on first page
  const loginPage = await context.newPage();
  await loginNaukri(loginPage);
  await loginPage.close();

  // Run queries in parallel batches
  let total = 0;
  for (let i = 0; i < SEARCH_QUERIES.length; i += PARALLEL) {
    const batch = SEARCH_QUERIES.slice(i, i + PARALLEL);
    console.log(`\n[naukri] Batch ${Math.floor(i / PARALLEL) + 1}: ${batch.join(' | ')}`);

    const results = await Promise.all(
      batch.map(async (query) => {
        const page = await context.newPage();
        try {
          return await scrapeQuery(page, query);
        } finally {
          await page.close();
        }
      })
    );

    total += results.reduce((a, b) => a + b, 0);
  }

  saveCookies('naukri', await context.cookies());
  await browser.close();
  console.log(`\n[naukri] Done — total: ${total}`);
  return total;
}

if (require.main === module) {
  run().catch(err => { console.error('[naukri] Fatal:', err.message); process.exit(1); });
}

module.exports = { run, loginNaukri };
