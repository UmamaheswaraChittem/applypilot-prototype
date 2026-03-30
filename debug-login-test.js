/**
 * Debug: Log in to LinkedIn + Naukri using the SAME code as the main app,
 * then open one job page and screenshot what the logged-in user sees.
 */
require('dotenv').config();
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const { loginLinkedIn } = require('./src/scrapers/linkedin');
const { loginNaukri } = require('./src/scrapers/naukri');
const { saveCookies, loadCookies } = require('./src/scrapers/utils');
const { getJobsToApply } = require('./src/db/database');

const DIR = path.join(__dirname, 'debug-screenshots');
if (!fs.existsSync(DIR)) fs.mkdirSync(DIR);

async function debugLinkedInLoggedIn() {
  console.log('\n══════ LINKEDIN (logged in) ══════\n');

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

  // Load existing cookies
  const cookies = loadCookies('linkedin');
  if (cookies) {
    await context.addCookies(cookies);
    console.log(`Loaded ${cookies.length} cookies`);
  }

  const page = await context.newPage();

  // Login using same function as main app
  console.log('Logging in...');
  await loginLinkedIn(page);
  saveCookies('linkedin', await context.cookies());
  console.log('Login complete');

  // Check language
  await page.waitForTimeout(2000);
  const lang = await page.evaluate(() => ({
    htmlLang: document.documentElement.lang,
    dir: document.documentElement.dir,
    url: window.location.href,
  })).catch(() => ({}));
  console.log(`Language: ${lang.htmlLang}, dir: ${lang.dir}, URL: ${lang.url}`);
  await page.screenshot({ path: path.join(DIR, 'li-1-after-login.png') });

  // Try to change language to English
  console.log('\nChanging language to English...');
  await page.goto('https://www.linkedin.com/mypreferences/d/categories/language', { waitUntil: 'networkidle', timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(2000);
  await page.screenshot({ path: path.join(DIR, 'li-2-language-settings.png') });

  // Check current language on settings page
  const langPageInfo = await page.evaluate(() => ({
    text: document.body.innerText.substring(0, 500),
    url: window.location.href,
  })).catch(() => ({}));
  console.log(`Language page URL: ${langPageInfo.url}`);
  console.log(`Language page text: ${(langPageInfo.text || '').replace(/\n/g, ' ').substring(0, 200)}`);

  // Open a job page
  const testUrl = 'https://www.linkedin.com/jobs/view/4393639520/'; // DigiCroz React/Node.js
  console.log(`\nOpening job: ${testUrl}`);
  await page.goto(testUrl, { waitUntil: 'networkidle', timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(5000); // extra wait

  await page.screenshot({ path: path.join(DIR, 'li-3-job-page.png') });
  console.log('Screenshot: li-3-job-page.png');

  // Full page analysis
  const analysis = await page.evaluate(() => {
    const r = {};
    r.url = window.location.href;
    r.title = document.title;
    r.htmlLang = document.documentElement.lang;
    r.bodyLen = (document.body.innerText || '').length;
    r.first300 = (document.body.innerText || '').substring(0, 300).replace(/\n/g, ' ');

    // ALL buttons
    r.buttons = [...document.querySelectorAll('button, a[role="button"], a.artdeco-button')]
      .filter(e => e.offsetParent !== null && (e.innerText || '').trim())
      .slice(0, 20)
      .map(e => ({
        tag: e.tagName, text: (e.innerText || '').trim().substring(0, 50),
        class: (e.className || '').toString().substring(0, 60),
        ariaLabel: (e.getAttribute('aria-label') || '').substring(0, 50),
        id: e.id || '',
      }));

    // Check for known containers
    r.containers = {};
    const sels = [
      '.jobs-s-apply', '.jobs-apply-button', '.jobs-unified-top-card',
      '.job-details-jobs-unified-top-card', '.jobs-details',
      '.scaffold-layout__detail', '.artdeco-card', '.job-view-layout',
      '.jobs-search__job-details', '.jobs-details-top-card',
      '[class*="jobs-apply"]', '[class*="job-detail"]',
    ];
    for (const s of sels) {
      const el = document.querySelector(s);
      r.containers[s] = el ? (el.innerText || '').trim().substring(0, 100) : null;
    }

    // Full class list of top-level divs (to find LinkedIn's current structure)
    r.topDivClasses = [...document.querySelectorAll('body > div, body > div > div, main, [role="main"]')]
      .slice(0, 10)
      .map(e => (e.className || '').toString().substring(0, 80));

    return r;
  }).catch(e => ({ error: e.message }));

  console.log(`\nPage: ${analysis.title}`);
  console.log(`URL: ${analysis.url}`);
  console.log(`Lang: ${analysis.htmlLang}, Body: ${analysis.bodyLen} chars`);
  console.log(`First 300 chars: ${analysis.first300}`);

  console.log('\nContainers:');
  for (const [k, v] of Object.entries(analysis.containers || {})) {
    console.log(`  ${v !== null ? '✓' : '✗'} ${k}${v ? `: "${v.substring(0, 60)}"` : ''}`);
  }

  console.log('\nTop div classes:');
  for (const cls of (analysis.topDivClasses || [])) {
    console.log(`  ${cls}`);
  }

  console.log(`\nAll buttons (${(analysis.buttons || []).length}):`);
  for (const b of (analysis.buttons || [])) {
    console.log(`  <${b.tag} id="${b.id}" class="${b.class.substring(0, 40)}" aria="${b.ariaLabel}">"${b.text}"`);
  }

  // Scroll and screenshot
  await page.evaluate(() => window.scrollBy(0, 500));
  await page.waitForTimeout(2000);
  await page.screenshot({ path: path.join(DIR, 'li-4-job-scrolled.png') });

  await browser.close();
  console.log('\n✓ LinkedIn debug done\n');
}

async function debugNaukriLoggedIn() {
  console.log('\n══════ NAUKRI (logged in) ══════\n');

  const browser = await chromium.launch({
    headless: false,
    args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'],
  });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    viewport: { width: 1366, height: 768 },
    locale: 'en-IN',
  });

  const cookies = loadCookies('naukri');
  if (cookies) {
    await context.addCookies(cookies);
    console.log(`Loaded ${cookies.length} cookies`);
  }

  const page = await context.newPage();

  console.log('Logging in...');
  await loginNaukri(page);
  saveCookies('naukri', await context.cookies());
  console.log('Login complete');
  await page.screenshot({ path: path.join(DIR, 'nk-1-after-login.png') });

  // Get a real naukri job URL from DB
  const jobs = getJobsToApply({ source: 'naukri', minScore: 0.50, limit: 5 });
  if (jobs.length === 0) {
    console.log('No Naukri jobs in DB');
    await browser.close();
    return;
  }

  const job = jobs[0];
  console.log(`\nOpening: ${job.title} @ ${job.company}`);
  console.log(`URL: ${job.url}`);
  await page.goto(job.url, { waitUntil: 'networkidle', timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(3000);

  await page.screenshot({ path: path.join(DIR, 'nk-2-job-page.png') });
  console.log('Screenshot: nk-2-job-page.png');

  const analysis = await page.evaluate(() => {
    const r = {};
    r.url = window.location.href;
    r.title = document.title;
    r.h1 = (document.querySelector('h1') || {}).innerText || '';
    r.bodyLen = (document.body.innerText || '').length;
    r.first300 = (document.body.innerText || '').substring(0, 300).replace(/\n/g, ' ');

    // ALL buttons
    r.buttons = [...document.querySelectorAll('button, a[href], div[role="button"]')]
      .filter(e => e.offsetParent !== null && (e.innerText || '').trim())
      .slice(0, 20)
      .map(e => ({
        tag: e.tagName, text: (e.innerText || '').trim().substring(0, 50),
        class: (e.className || '').toString().substring(0, 60),
        id: e.id || '',
        href: e.href ? e.href.substring(0, 60) : '',
      }));

    // Apply-specific
    r.applyBtns = r.buttons.filter(b =>
      b.text.toLowerCase().includes('apply') ||
      b.text.toLowerCase().includes('interested') ||
      b.class.toLowerCase().includes('apply') ||
      b.id.toLowerCase().includes('apply')
    );

    return r;
  }).catch(e => ({ error: e.message }));

  console.log(`\nPage: ${analysis.title}`);
  console.log(`URL: ${analysis.url}`);
  console.log(`H1: ${analysis.h1}`);
  console.log(`Body: ${analysis.bodyLen} chars`);
  console.log(`First 300: ${analysis.first300}`);

  console.log(`\nApply buttons (${(analysis.applyBtns || []).length}):`);
  for (const b of (analysis.applyBtns || [])) {
    console.log(`  <${b.tag} id="${b.id}" class="${b.class}">"${b.text}"`);
  }

  console.log(`\nAll buttons (${(analysis.buttons || []).length}):`);
  for (const b of (analysis.buttons || [])) {
    console.log(`  <${b.tag} id="${b.id}" class="${b.class.substring(0, 40)}">"${b.text}"`);
  }

  // Scroll
  await page.evaluate(() => window.scrollBy(0, 400));
  await page.waitForTimeout(2000);
  await page.screenshot({ path: path.join(DIR, 'nk-3-job-scrolled.png') });

  await browser.close();
  console.log('\n✓ Naukri debug done\n');
}

(async () => {
  try { await debugLinkedInLoggedIn(); } catch (e) { console.error('LinkedIn error:', e.message); }
  try { await debugNaukriLoggedIn(); } catch (e) { console.error('Naukri error:', e.message); }
  console.log('\nAll screenshots in debug-screenshots/');
})();
