require('dotenv').config();
const { chromium } = require('playwright');
const { loginLinkedIn } = require('./src/scrapers/linkedin');
const { loadCookies, saveCookies } = require('./src/scrapers/utils');
const path = require('path');

(async () => {
  const browser = await chromium.launch({ headless: false, args: ['--no-sandbox'] });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    viewport: { width: 1366, height: 768 },
    locale: 'en-US',
    extraHTTPHeaders: { 'Accept-Language': 'en-US,en;q=0.9' },
  });
  const cookies = loadCookies('linkedin');
  if (cookies) await context.addCookies(cookies);
  const page = await context.newPage();
  await loginLinkedIn(page);

  const url = 'https://www.linkedin.com/jobs/view/4393639520/';
  console.log('Opening:', url);
  await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(4000);

  const info = await page.evaluate(() => ({
    lang: document.documentElement.lang,
    title: document.title,
    buttons: [...document.querySelectorAll('button,a')].filter(e => {
      const t = (e.innerText || '').toLowerCase();
      return (t.includes('apply') || t.includes('easy') || t.includes('save') || t.includes('interested')) && e.offsetParent !== null;
    }).map(e => ({
      tag: e.tagName,
      text: (e.innerText || '').trim().substring(0, 40),
      aria: (e.getAttribute('aria-label') || '').substring(0, 60),
      cls: (e.className || '').toString().substring(0, 50),
    })),
  }));

  console.log('Lang:', info.lang);
  console.log('Title:', info.title);
  console.log('Apply/action buttons:');
  for (const b of info.buttons) {
    console.log(`  <${b.tag}> "${b.text}" aria="${b.aria}" class="${b.cls}"`);
  }

  await page.screenshot({ path: path.join(__dirname, 'debug-screenshots', 'li-english-job.png') });

  // Test clicking apply
  if (info.buttons.length > 0) {
    const applyBtn = info.buttons.find(b => b.text.toLowerCase().includes('apply'));
    if (applyBtn) {
      console.log('\nClicking apply button...');
      const btn = await page.$(`button:has-text("${applyBtn.text.substring(0, 15)}")`);
      if (btn) {
        context.on('page', async (p) => {
          await p.waitForLoadState('domcontentloaded').catch(() => {});
          console.log('  New tab:', p.url().substring(0, 80));
        });
        await btn.click().catch(() => {});
        await page.waitForTimeout(5000);
        console.log('  Current URL:', page.url().substring(0, 80));
      }
    }
  }

  saveCookies('linkedin', await context.cookies());
  await browser.close();
  console.log('\nDone');
})();
