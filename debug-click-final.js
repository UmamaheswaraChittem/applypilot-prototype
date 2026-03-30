require('dotenv').config();
const { chromium } = require('playwright');
const { loginLinkedIn } = require('./src/scrapers/linkedin');
const { loadCookies, saveCookies } = require('./src/scrapers/utils');
const path = require('path');
const DIR = path.join(__dirname, 'debug-screenshots');

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

  context.on('page', async (p) => {
    await p.waitForLoadState('domcontentloaded').catch(() => {});
    console.log('NEW TAB:', p.url());
  });

  await page.goto('https://www.linkedin.com/jobs/view/4393639520/', { waitUntil: 'networkidle', timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(4000);

  // Click Apply using coordinates
  const btn = await page.$('button[aria-label="Apply on company website"]');
  if (!btn) { console.log('No button'); await browser.close(); return; }

  const box = await btn.boundingBox();
  console.log('Clicking Apply at', box.x, box.y);
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await page.waitForTimeout(3000);

  // Screenshot immediately
  await page.screenshot({ path: path.join(DIR, 'after-apply-click.png') });
  console.log('Screenshot saved');

  // Check what's on the page now
  const after = await page.evaluate(() => {
    const r = {};
    r.url = window.location.href;
    // Check for modals/overlays
    const modals = [...document.querySelectorAll('[role="dialog"], [role="alertdialog"], [class*="modal"], [class*="overlay"]')];
    r.modals = modals.filter(m => m.offsetParent !== null || window.getComputedStyle(m).display !== 'none')
      .map(m => ({
        text: (m.innerText || '').substring(0, 300),
        links: [...m.querySelectorAll('a[href]')].map(a => a.href).filter(h => !h.includes('linkedin.com')).slice(0, 3),
        buttons: [...m.querySelectorAll('button')].map(b => b.innerText.trim().substring(0, 30)).slice(0, 5),
      }));
    // Check for fixed position overlays
    r.fixed = [...document.querySelectorAll('*')].filter(e => {
      const s = window.getComputedStyle(e);
      return s.position === 'fixed' && s.display !== 'none' && e.offsetHeight > 50 && e.offsetWidth > 50;
    }).map(e => ({
      text: (e.innerText || '').substring(0, 200).replace(/\n/g, ' '),
      class: (e.className || '').toString().substring(0, 50),
    })).slice(0, 3);
    // Check all visible buttons now
    r.buttons = [...document.querySelectorAll('button')].filter(e => e.offsetParent !== null && (e.innerText||'').trim())
      .slice(0, 10).map(e => e.innerText.trim().substring(0, 30));
    // Any new links
    r.externalLinks = [...document.querySelectorAll('a[href]')]
      .filter(a => !a.href.includes('linkedin.com') && a.href.startsWith('http'))
      .map(a => ({ text: (a.innerText||'').trim().substring(0,20), href: a.href.substring(0,80) }))
      .slice(0, 5);
    return r;
  });

  console.log('\nURL:', after.url);
  console.log('Modals:', JSON.stringify(after.modals, null, 2));
  console.log('Fixed overlays:', JSON.stringify(after.fixed?.map(f => f.text.substring(0, 100)), null, 2));
  console.log('Buttons:', after.buttons);
  console.log('External links:', JSON.stringify(after.externalLinks, null, 2));

  saveCookies('linkedin', await context.cookies());
  await browser.close();
  console.log('\nDone');
})();
