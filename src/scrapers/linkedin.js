require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const { chromium } = require('playwright');
const { humanDelay, saveCookies, loadCookies, parseSalaryLPA, parsePostedAt } = require('./utils');
const { waitForPageStable } = require('../stealth');
const { upsertJob } = require('../db/database');

const SEARCH_QUERIES = [
  // Core Node.js roles — primary skill
  'Senior Node.js Engineer',
  'Technical Lead Node.js',
  'Node.js TypeScript Backend Engineer',
  'Staff Engineer Node.js',
  'Principal Backend Engineer Node.js',

  // Conversational AI / Chatbot — key differentiator
  'Conversational AI Engineer',
  'Chatbot Developer Node.js',
  'Cognigy Developer',
  'Cognigy AI Engineer',
  'IVR Developer Node.js',
  'AI Platform Engineer',
  'Virtual Assistant Developer',
  'Dialogue Engineer',

  // LLM / GenAI — hot market
  'LLM Engineer',
  'Generative AI Engineer Node.js',
  'AI Engineer Node.js',
  'Technical Lead AI',
  'GenAI Backend Engineer',

  // Senior remote titles — high pay
  'Remote Senior Node.js Engineer',
  'Remote Technical Lead Node.js',
  'Remote AI Engineer TypeScript',
  'Staff Software Engineer Remote',
  'Engineering Manager Node.js',
];

// India locations for hybrid/on-site
const LOCATIONS = [
  'Hyderabad, Telangana, India',
  'Bangalore, Karnataka, India',
  'Mumbai, Maharashtra, India',
  'Chennai, Tamil Nadu, India',
  'Pune, Maharashtra, India',
];
const REMOTE_FILTER = true; // also scrapes worldwide remote

const JOBS_PER_SEARCH = parseInt(process.env.JOBS_PER_SEARCH || '20');
const HEADLESS = process.env.HEADLESS !== 'false';
const PARALLEL = parseInt(process.env.LINKEDIN_PARALLEL || '4');

async function launchBrowser() {
  return chromium.launch({
    headless: HEADLESS,
    args: [
      '--no-sandbox',
      '--disable-blink-features=AutomationControlled',
      '--disable-infobars',
    ],
  });
}

async function loginLinkedIn(page) {
  const cookies = loadCookies('linkedin');

  if (cookies) {
    console.log('[linkedin] Loading saved session cookies...');
    await page.context().addCookies(cookies);
    await page.goto('https://www.linkedin.com/feed/', { waitUntil: 'domcontentloaded' });
    await humanDelay();

    // Check if still logged in
    const isLoggedIn = await page.$('[data-test-id="nav-profile-avatar"]') ||
                       await page.$('.global-nav__me-photo') ||
                       await page.$('a[href*="/in/"]');
    if (isLoggedIn) {
      console.log('[linkedin] Session restored successfully');
      return true;
    }
    console.log('[linkedin] Saved session expired, logging in fresh...');
  }

  console.log('[linkedin] Logging in...');
  await page.goto('https://www.linkedin.com/login', { waitUntil: 'domcontentloaded' });
  await humanDelay();

  await page.fill('#username', process.env.LINKEDIN_EMAIL);
  await humanDelay();
  await page.fill('#password', process.env.LINKEDIN_PASSWORD);
  await humanDelay();
  await page.click('[data-litms-control-urn="login-submit"]');

  try {
    await page.waitForURL('**/feed/**', { timeout: 15000 });
  } catch {
    // May need to handle CAPTCHA or verification
    console.warn('[linkedin] Login redirect took long — may need manual verification');
    await waitForPageStable(page, { maxWait: 8000 });
  }

  const newCookies = await page.context().cookies();
  saveCookies('linkedin', newCookies);
  console.log('[linkedin] Logged in and session saved');
  return true;
}

async function scrapeJobListing(page, jobElement) {
  try {
    const title = await jobElement.$eval(
      '.job-card-list__title, .job-card-container__link, [data-tracking-control-name="public_jobs_jserp-result_search-card"]',
      el => el.innerText.trim()
    ).catch(() => 'Unknown');

    const company = await jobElement.$eval(
      '.job-card-container__company-name, .artdeco-entity-lockup__subtitle span',
      el => el.innerText.trim()
    ).catch(() => 'Unknown');

    const location = await jobElement.$eval(
      '.job-card-container__metadata-item, .artdeco-entity-lockup__caption',
      el => el.innerText.trim()
    ).catch(() => '');

    const url = await jobElement.$eval(
      'a.job-card-list__title, a.job-card-container__link',
      el => el.href
    ).catch(() => null);

    if (!url) return null;

    // Clean URL — remove tracking params
    const cleanUrl = url.split('?')[0];

    const salary = await jobElement.$eval(
      '.job-card-container__salary-info, .compensation',
      el => el.innerText.trim()
    ).catch(() => '');

    const applyTypeEl = await jobElement.$('.job-card-container__apply-method, .jobs-apply-button');
    const applyType = applyTypeEl
      ? (await applyTypeEl.innerText()).toLowerCase().includes('easy apply') ? 'easy_apply' : 'external'
      : 'unknown';

    const postedText = await jobElement.$eval(
      'time, .job-card-container__listed-status',
      el => el.getAttribute('datetime') || el.innerText.trim()
    ).catch(() => null);

    const { min: salaryMin, max: salaryMax } = parseSalaryLPA(salary);

    return {
      source: 'linkedin',
      title,
      company,
      location,
      url: cleanUrl,
      description: null, // fetched separately for top jobs
      salary_raw: salary || null,
      salary_min_lpa: salaryMin,
      salary_max_lpa: salaryMax,
      apply_type: applyType,
      posted_at: parsePostedAt(postedText) || postedText,
    };
  } catch (err) {
    console.error('[linkedin] Error parsing job card:', err.message);
    return null;
  }
}

async function fetchJobDescription(page, url) {
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
    await humanDelay();

    // Expand "Show more" if present
    const showMore = await page.$('button[aria-label="Click to see more description"],.jobs-description__footer-button');
    if (showMore) await showMore.click().catch(() => {});

    const description = await page.$eval(
      '.jobs-description-content__text, .jobs-description__content, #job-details',
      el => el.innerText.trim()
    ).catch(() => null);

    return description;
  } catch {
    return null;
  }
}

async function scrapeQuery(page, query, location) {
  const jobs = [];
  const locationParam = encodeURIComponent(location);
  const queryParam = encodeURIComponent(query);

  // Build search URL with filters: last 7 days (r604800), full-time
  const searchUrl = `https://www.linkedin.com/jobs/search/?keywords=${queryParam}&location=${locationParam}&f_TPR=r604800&f_JT=F&sortBy=DD`;

  console.log(`\n[linkedin] Scraping: "${query}" in ${location}`);

  // Retry navigation up to 3 times on timeout
  let navSuccess = false;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 40000 });
      navSuccess = true;
      break;
    } catch (err) {
      console.warn(`  [attempt ${attempt}/3] Navigation failed: ${err.message.split('\n')[0]}`);
      if (attempt < 3) {
        console.log('  Waiting 10s before retry...');
        await waitForPageStable(page, { maxWait: 10000 });
      }
    }
  }
  if (!navSuccess) {
    console.warn(`  Skipping "${query}" in ${location} after 3 failed attempts`);
    return 0;
  }
  await humanDelay();

  let scraped = 0;
  let attempts = 0;

  while (scraped < JOBS_PER_SEARCH && attempts < 5) {
    const jobCards = await page.$$('.jobs-search-results__list-item, .job-card-container');

    for (const card of jobCards) {
      if (scraped >= JOBS_PER_SEARCH) break;

      // Click card to load details in sidebar
      try {
        await card.click();
        await humanDelay();
      } catch { /* card may have disappeared */ }

      const job = await scrapeJobListing(page, card);
      if (job) {
        // Get full description from sidebar
        const sidebarDesc = await page.$eval(
          '.jobs-description-content__text, .jobs-description__content, #job-details',
          el => el.innerText.trim()
        ).catch(() => null);

        job.description = sidebarDesc;
        upsertJob(job);
        scraped++;
        console.log(`  [${scraped}] ${job.title} @ ${job.company} (${job.apply_type})`);
      }

      await humanDelay();
    }

    // Try to scroll / load more
    if (scraped < JOBS_PER_SEARCH) {
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await humanDelay();

      const nextBtn = await page.$('button[aria-label="Page 2"], .artdeco-pagination__button--next');
      if (nextBtn) {
        await nextBtn.click();
        await page.waitForLoadState('domcontentloaded');
        await humanDelay();
      }
      attempts++;
    }
  }

  console.log(`  → Saved ${scraped} jobs for "${query}" in ${location}`);
  return scraped;
}

async function scrapeRemoteQuery(page, query) {
  const remoteUrl = `https://www.linkedin.com/jobs/search/?keywords=${encodeURIComponent(query)}&f_WT=2&f_TPR=r604800&sortBy=DD`;
  console.log(`\n[linkedin] Scraping: "${query}" Remote`);

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await page.goto(remoteUrl, { waitUntil: 'domcontentloaded', timeout: 40000 });
      break;
    } catch {
      if (attempt === 3) { console.warn(`  Skipping remote "${query}" after 3 attempts`); return 0; }
      await waitForPageStable(page, { maxWait: 10000 });
    }
  }
  await humanDelay();

  const jobCards = await page.$$('.jobs-search-results__list-item, .job-card-container');
  let count = 0;
  for (const card of jobCards) {
    if (count >= JOBS_PER_SEARCH) break;
    try { await card.click(); await humanDelay(); } catch {}
    const job = await scrapeJobListing(page, card);
    if (job) {
      job.location = job.location ? `${job.location} (Remote)` : 'Remote';
      const sidebarDesc = await page.$eval(
        '.jobs-description-content__text, .jobs-description__content, #job-details',
        el => el.innerText.trim()
      ).catch(() => null);
      job.description = sidebarDesc;
      upsertJob(job);
      count++;
      console.log(`  [${count}] ${job.title} @ ${job.company} (Remote)`);
    }
    await humanDelay();
  }
  return count;
}

async function run() {
  const browser = await launchBrowser();
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    viewport: { width: 1366, height: 768 },
    locale: 'en-IN',
  });

  // Login on a dedicated page, then close it
  const loginPage = await context.newPage();
  try {
    await loginLinkedIn(loginPage);
  } finally {
    await loginPage.close();
  }

  // Build all tasks: { query, location } — location = null means remote
  const tasks = [];
  for (const query of SEARCH_QUERIES) {
    for (const location of LOCATIONS) {
      tasks.push({ query, location });
    }
    if (REMOTE_FILTER) {
      tasks.push({ query, location: null }); // null = remote search
    }
  }

  console.log(`\n[linkedin] ${tasks.length} search tasks — running ${PARALLEL} in parallel\n`);

  let total = 0;
  for (let i = 0; i < tasks.length; i += PARALLEL) {
    const batch = tasks.slice(i, i + PARALLEL);
    const batchNum = Math.floor(i / PARALLEL) + 1;
    const totalBatches = Math.ceil(tasks.length / PARALLEL);
    console.log(`\n[linkedin] Batch ${batchNum}/${totalBatches}`);

    const results = await Promise.all(
      batch.map(async ({ query, location }) => {
        const page = await context.newPage();
        try {
          if (location === null) {
            return await scrapeRemoteQuery(page, query);
          } else {
            return await scrapeQuery(page, query, location);
          }
        } catch (err) {
          console.error(`  [linkedin] Error (${query}): ${err.message}`);
          return 0;
        } finally {
          await page.close();
        }
      })
    );

    total += results.reduce((a, b) => a + b, 0);
  }

  const cookies = await context.cookies();
  saveCookies('linkedin', cookies);
  await browser.close();
  console.log(`\n[linkedin] Done — total jobs saved: ${total}`);
  return total;
}

if (require.main === module) {
  run().catch(err => {
    console.error('[linkedin] Fatal error:', err);
    process.exit(1);
  });
}

module.exports = { run, loginLinkedIn };
