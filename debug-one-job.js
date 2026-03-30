/**
 * Debug script — opens ONE LinkedIn job and ONE Naukri job, takes screenshots,
 * and logs exactly what's on the page. Run with: node debug-one-job.js
 */
require('dotenv').config();
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const SCREENSHOTS_DIR = path.join(__dirname, 'debug-screenshots');
if (!fs.existsSync(SCREENSHOTS_DIR)) fs.mkdirSync(SCREENSHOTS_DIR);

function loadCookies(name) {
  try {
    const f = path.join(__dirname, 'data', `${name}_cookies.json`);
    return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch { return []; }
}

async function debugLinkedIn() {
  console.log('\n══════════════════════════════════════');
  console.log('  DEBUGGING LINKEDIN');
  console.log('══════════════════════════════════════\n');

  const browser = await chromium.launch({
    headless: false,
    args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'],
  });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    viewport: { width: 1366, height: 768 },
    locale: 'en-US',
    extraHTTPHeaders: { 'Accept-Language': 'en-US,en;q=0.9' },
  });

  // Load saved cookies
  const cookies = loadCookies('linkedin');
  if (cookies.length) {
    await context.addCookies(cookies);
    console.log(`Loaded ${cookies.length} LinkedIn cookies`);
  }

  const page = await context.newPage();

  // Step 1: Check if session is valid
  console.log('\n1. Checking LinkedIn session...');
  await page.goto('https://www.linkedin.com/feed/', { waitUntil: 'networkidle', timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(3000);
  const feedUrl = page.url();
  console.log(`   URL: ${feedUrl}`);
  const isLoggedIn = feedUrl.includes('/feed') || feedUrl.includes('/mynetwork');
  console.log(`   Logged in: ${isLoggedIn}`);
  await page.screenshot({ path: path.join(SCREENSHOTS_DIR, '1-linkedin-feed.png'), fullPage: false });
  console.log(`   Screenshot: debug-screenshots/1-linkedin-feed.png`);

  if (!isLoggedIn) {
    console.log('\n   ⚠ NOT LOGGED IN — you need to log in manually or fix cookies');
    await browser.close();
    return;
  }

  // Step 2: Check language
  console.log('\n2. Checking LinkedIn language...');
  const interfaceLang = await page.evaluate(() => {
    const html = document.documentElement;
    return {
      htmlLang: html.lang,
      dir: html.dir,
      // Check nav items
      navItems: [...document.querySelectorAll('nav li span, nav a span')].slice(0, 5).map(e => e.innerText.trim()),
    };
  }).catch(() => ({ htmlLang: '?', dir: '?', navItems: [] }));
  console.log(`   HTML lang: "${interfaceLang.htmlLang}", dir: "${interfaceLang.dir}"`);
  console.log(`   Nav items: ${interfaceLang.navItems.join(', ')}`);

  if (interfaceLang.htmlLang !== 'en' && !interfaceLang.htmlLang.startsWith('en')) {
    console.log('\n   ⚠ LinkedIn is NOT in English! Attempting to change...');
    // Go to language settings
    await page.goto('https://www.linkedin.com/mypreferences/d/categories/language', { waitUntil: 'networkidle', timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(2000);
    await page.screenshot({ path: path.join(SCREENSHOTS_DIR, '2-linkedin-language-settings.png'), fullPage: false });
    console.log(`   Screenshot: debug-screenshots/2-linkedin-language-settings.png`);
    console.log(`   → PLEASE change LinkedIn language to English manually at:`);
    console.log(`     https://www.linkedin.com/mypreferences/d/categories/language`);
  }

  // Step 3: Open a real job page
  // Use a popular job that likely exists
  const testJobUrl = 'https://www.linkedin.com/jobs/view/4391223216/'; // Deel job from your list
  console.log(`\n3. Opening job: ${testJobUrl}`);
  await page.goto(testJobUrl, { waitUntil: 'networkidle', timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(4000);

  const jobPageUrl = page.url();
  console.log(`   Final URL: ${jobPageUrl}`);
  await page.screenshot({ path: path.join(SCREENSHOTS_DIR, '3-linkedin-job-page.png'), fullPage: false });
  console.log(`   Screenshot: debug-screenshots/3-linkedin-job-page.png`);

  // Step 4: Analyze what's on the page
  console.log('\n4. Analyzing page elements...');
  const analysis = await page.evaluate(() => {
    const result = {};
    result.title = document.title;
    result.htmlLang = document.documentElement.lang;
    result.h1 = (document.querySelector('h1') || {}).innerText || 'NO H1';
    result.h2s = [...document.querySelectorAll('h2')].slice(0, 3).map(e => e.innerText.trim().substring(0, 60));

    // Look for ANY apply-related elements
    result.applyElements = [];
    const all = document.querySelectorAll('button, a, div[role="button"], span[role="button"]');
    for (const el of all) {
      if (el.offsetParent === null) continue;
      const txt = (el.innerText || '').trim();
      const cls = (el.className || '').toString();
      const aria = el.getAttribute('aria-label') || '';
      // Check if this could be an apply button (any language)
      if (cls.includes('apply') || cls.includes('Apply') ||
          txt.toLowerCase().includes('apply') || aria.toLowerCase().includes('apply') ||
          txt.includes('تقديم') || txt.includes('تقدم') || txt.includes('تطبيق') ||
          aria.includes('تقديم') || aria.includes('تقدم') || aria.includes('تطبيق')) {
        result.applyElements.push({
          tag: el.tagName, text: txt.substring(0, 50),
          class: cls.substring(0, 80), ariaLabel: aria.substring(0, 50),
          href: el.href || '',
        });
      }
    }

    // All visible buttons
    result.allButtons = [...document.querySelectorAll('button')]
      .filter(e => e.offsetParent !== null && (e.innerText || '').trim().length > 0)
      .slice(0, 15)
      .map(e => ({
        text: (e.innerText || '').trim().substring(0, 40),
        class: (e.className || '').toString().substring(0, 60),
        ariaLabel: (e.getAttribute('aria-label') || '').substring(0, 40),
      }));

    // Check for specific LinkedIn containers
    result.containers = {
      'jobs-s-apply': !!document.querySelector('.jobs-s-apply'),
      'jobs-apply-button': !!document.querySelector('.jobs-apply-button'),
      'jobs-unified-top-card': !!document.querySelector('.jobs-unified-top-card'),
      'job-details-jobs-unified-top-card': !!document.querySelector('.job-details-jobs-unified-top-card'),
      'jobs-details': !!document.querySelector('.jobs-details'),
      'scaffold-layout__detail': !!document.querySelector('.scaffold-layout__detail'),
      'artdeco-card': !!document.querySelector('.artdeco-card'),
    };

    return result;
  }).catch(e => ({ error: e.message }));

  console.log(`   Page title: ${analysis.title}`);
  console.log(`   HTML lang: ${analysis.htmlLang}`);
  console.log(`   H1: ${analysis.h1}`);
  console.log(`   H2s: ${(analysis.h2s || []).join(' | ')}`);
  console.log(`\n   LinkedIn containers found:`);
  for (const [k, v] of Object.entries(analysis.containers || {})) {
    console.log(`     ${v ? '✓' : '✗'} ${k}`);
  }
  console.log(`\n   Apply-related elements (${(analysis.applyElements || []).length}):`);
  for (const el of (analysis.applyElements || [])) {
    console.log(`     <${el.tag}> text="${el.text}" class="${el.class}" aria="${el.ariaLabel}" href="${el.href.substring(0, 50)}"`);
  }
  console.log(`\n   All visible buttons (${(analysis.allButtons || []).length}):`);
  for (const btn of (analysis.allButtons || [])) {
    console.log(`     "${btn.text}" class="${btn.class}" aria="${btn.ariaLabel}"`);
  }

  // Step 5: Scroll down and check again
  console.log('\n5. Scrolling down and re-checking...');
  await page.evaluate(() => window.scrollBy(0, 500));
  await page.waitForTimeout(2000);
  await page.screenshot({ path: path.join(SCREENSHOTS_DIR, '4-linkedin-job-scrolled.png'), fullPage: false });
  console.log(`   Screenshot: debug-screenshots/4-linkedin-job-scrolled.png`);

  await browser.close();
  console.log('\n✓ LinkedIn debug complete\n');
}

async function debugNaukri() {
  console.log('\n══════════════════════════════════════');
  console.log('  DEBUGGING NAUKRI');
  console.log('══════════════════════════════════════\n');

  const browser = await chromium.launch({
    headless: false,
    args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'],
  });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    viewport: { width: 1366, height: 768 },
    locale: 'en-IN',
  });

  // Load saved cookies
  const cookies = loadCookies('naukri');
  if (cookies.length) {
    await context.addCookies(cookies);
    console.log(`Loaded ${cookies.length} Naukri cookies`);
  }

  const page = await context.newPage();

  // Step 1: Check session
  console.log('\n1. Checking Naukri session...');
  await page.goto('https://www.naukri.com/mnjuser/homepage', { waitUntil: 'networkidle', timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(3000);
  const nUrl = page.url();
  console.log(`   URL: ${nUrl}`);
  const nLoggedIn = !nUrl.includes('/nlogin') && !nUrl.includes('/login');
  console.log(`   Logged in: ${nLoggedIn}`);
  await page.screenshot({ path: path.join(SCREENSHOTS_DIR, '5-naukri-homepage.png'), fullPage: false });

  // Step 2: Check what job URLs look like in DB
  console.log('\n2. Checking job URLs in database...');
  const { getJobsToApply } = require('./src/db/database');
  const nJobs = getJobsToApply('naukri', 0.50, 5);
  console.log(`   Found ${nJobs.length} Naukri jobs to apply:`);
  for (const j of nJobs) {
    console.log(`   - [${(j.score*100).toFixed(0)}%] ${j.title} @ ${j.company}`);
    console.log(`     URL: ${j.url}`);
  }

  if (nJobs.length === 0) {
    console.log('   No Naukri jobs found in database');
    await browser.close();
    return;
  }

  // Step 3: Open first Naukri job
  const testJob = nJobs[0];
  console.log(`\n3. Opening: ${testJob.title}`);
  console.log(`   URL: ${testJob.url}`);
  await page.goto(testJob.url, { waitUntil: 'networkidle', timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(3000);

  const nFinalUrl = page.url();
  console.log(`   Final URL: ${nFinalUrl}`);
  await page.screenshot({ path: path.join(SCREENSHOTS_DIR, '6-naukri-job-page.png'), fullPage: false });
  console.log(`   Screenshot: debug-screenshots/6-naukri-job-page.png`);

  // Step 4: Analyze
  console.log('\n4. Analyzing Naukri page...');
  const nAnalysis = await page.evaluate(() => {
    const result = {};
    result.title = document.title;
    result.h1 = (document.querySelector('h1') || {}).innerText || 'NO H1';
    result.url = window.location.href;

    // ALL visible buttons and links
    result.allButtons = [...document.querySelectorAll('button, a[href], div[role="button"]')]
      .filter(e => e.offsetParent !== null && (e.innerText || '').trim().length > 0)
      .slice(0, 20)
      .map(e => ({
        tag: e.tagName,
        text: (e.innerText || '').trim().substring(0, 50),
        class: (e.className || '').toString().substring(0, 60),
        id: e.id || '',
        href: e.href ? e.href.substring(0, 60) : '',
      }));

    // Specifically look for apply-related
    result.applyRelated = result.allButtons.filter(b =>
      b.text.toLowerCase().includes('apply') ||
      b.text.toLowerCase().includes('interested') ||
      b.class.includes('apply') || b.class.includes('Apply') ||
      b.id.includes('apply') || b.id.includes('Apply')
    );

    // Check body for key text
    const body = (document.body.innerText || '').toLowerCase();
    result.hasApplyText = body.includes('apply');
    result.hasInterestedText = body.includes('interested');
    result.bodyLength = body.length;
    result.first200chars = body.substring(0, 200);

    return result;
  }).catch(e => ({ error: e.message }));

  console.log(`   Page title: ${nAnalysis.title}`);
  console.log(`   H1: ${nAnalysis.h1}`);
  console.log(`   Body: ${nAnalysis.bodyLength} chars | hasApply: ${nAnalysis.hasApplyText} | hasInterested: ${nAnalysis.hasInterestedText}`);
  console.log(`   First 200 chars: ${(nAnalysis.first200chars || '').replace(/\n/g, ' ').substring(0, 200)}`);

  console.log(`\n   Apply-related elements (${(nAnalysis.applyRelated || []).length}):`);
  for (const el of (nAnalysis.applyRelated || [])) {
    console.log(`     <${el.tag} id="${el.id}" class="${el.class}">"${el.text}" href="${el.href}"`);
  }

  console.log(`\n   All visible buttons/links (${(nAnalysis.allButtons || []).length}):`);
  for (const btn of (nAnalysis.allButtons || [])) {
    console.log(`     <${btn.tag} id="${btn.id}" class="${btn.class.substring(0, 40)}">"${btn.text}"`);
  }

  // Step 5: Scroll and check
  console.log('\n5. Scrolling down...');
  await page.evaluate(() => window.scrollBy(0, 500));
  await page.waitForTimeout(2000);
  await page.screenshot({ path: path.join(SCREENSHOTS_DIR, '7-naukri-job-scrolled.png'), fullPage: false });

  // Check after scroll
  const afterScroll = await page.evaluate(() => {
    return [...document.querySelectorAll('button, a[href], div[role="button"]')]
      .filter(e => {
        if (e.offsetParent === null) return false;
        const t = (e.innerText || '').toLowerCase();
        const c = (e.className || '').toString().toLowerCase();
        return t.includes('apply') || t.includes('interested') || c.includes('apply');
      })
      .map(e => ({
        tag: e.tagName, text: (e.innerText || '').trim().substring(0, 50),
        class: (e.className || '').toString().substring(0, 60), id: e.id || '',
      }));
  }).catch(() => []);
  console.log(`   After scroll, apply elements: ${afterScroll.length}`);
  for (const el of afterScroll) {
    console.log(`     <${el.tag} id="${el.id}" class="${el.class}">"${el.text}"`);
  }

  await browser.close();
  console.log('\n✓ Naukri debug complete\n');
}

(async () => {
  try {
    await debugLinkedIn();
  } catch (err) {
    console.error('LinkedIn debug failed:', err.message);
  }

  try {
    await debugNaukri();
  } catch (err) {
    console.error('Naukri debug failed:', err.message);
  }

  console.log('\n═══════════════════════════════════');
  console.log('Check screenshots in: debug-screenshots/');
  console.log('Share the full output above so I can see exactly what\'s on each page.');
  console.log('═══════════════════════════════════\n');
})();
