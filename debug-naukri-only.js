require('dotenv').config();
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const { loginNaukri } = require('./src/scrapers/naukri');
const { saveCookies, loadCookies } = require('./src/scrapers/utils');
const { getJobsToApply } = require('./src/db/database');

const DIR = path.join(__dirname, 'debug-screenshots');
if (!fs.existsSync(DIR)) fs.mkdirSync(DIR);

(async () => {
  console.log('══════ NAUKRI DEBUG ══════\n');
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
  if (cookies) await context.addCookies(cookies);

  const loginPage = await context.newPage();
  await loginNaukri(loginPage);
  saveCookies('naukri', await context.cookies());
  await loginPage.close();

  const jobs = getJobsToApply({ source: 'naukri', minScore: 0.50, limit: 3 });
  console.log(`\nFound ${jobs.length} Naukri jobs:`);
  for (const j of jobs) {
    console.log(`  [${(j.score*100).toFixed(0)}%] ${j.title} @ ${j.company} → ${j.url.substring(0, 70)}`);
  }

  if (jobs.length === 0) { await browser.close(); return; }

  const page = await context.newPage();
  const job = jobs[0];
  console.log(`\nOpening: ${job.url}`);
  await page.goto(job.url, { waitUntil: 'networkidle', timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(3000);
  await page.screenshot({ path: path.join(DIR, 'nk-logged-in.png') });

  const a = await page.evaluate(() => {
    const r = {};
    r.url = window.location.href;
    r.title = document.title;
    r.h1 = (document.querySelector('h1') || {}).innerText || '';
    r.bodyLen = (document.body.innerText || '').length;
    r.first200 = (document.body.innerText || '').substring(0, 200).replace(/\n/g, ' ');
    r.buttons = [...document.querySelectorAll('button, a[href], div[role="button"]')]
      .filter(e => e.offsetParent !== null && (e.innerText || '').trim())
      .slice(0, 25)
      .map(e => ({
        tag: e.tagName, text: (e.innerText || '').trim().substring(0, 50),
        class: (e.className || '').toString().substring(0, 50),
        id: e.id || '', href: e.href ? e.href.substring(0, 50) : '',
      }));
    r.applyBtns = r.buttons.filter(b =>
      b.text.toLowerCase().includes('apply') || b.text.toLowerCase().includes('interested') ||
      b.class.toLowerCase().includes('apply') || b.id.toLowerCase().includes('apply'));
    return r;
  }).catch(e => ({ error: e.message }));

  console.log(`\nPage: ${a.title}`);
  console.log(`URL: ${a.url}`);
  console.log(`H1: ${a.h1}`);
  console.log(`Body: ${a.bodyLen} chars`);
  console.log(`First 200: ${a.first200}`);
  console.log(`\nApply buttons (${(a.applyBtns||[]).length}):`);
  for (const b of (a.applyBtns||[])) console.log(`  <${b.tag} id="${b.id}" class="${b.class}">"${b.text}" href="${b.href}"`);
  console.log(`\nAll buttons (${(a.buttons||[]).length}):`);
  for (const b of (a.buttons||[])) console.log(`  <${b.tag} id="${b.id}" class="${b.class.substring(0,30)}">"${b.text}"`);

  // Scroll and re-check
  await page.evaluate(() => window.scrollBy(0, 400));
  await page.waitForTimeout(2000);
  await page.screenshot({ path: path.join(DIR, 'nk-logged-in-scrolled.png') });

  await browser.close();
  console.log('\n✓ Done');
})();
