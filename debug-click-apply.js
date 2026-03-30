require('dotenv').config();
const { chromium } = require('playwright');
const { loginLinkedIn } = require('./src/scrapers/linkedin');
const { loadCookies, saveCookies } = require('./src/scrapers/utils');

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

  // Listen for new tabs
  context.on('page', async (p) => {
    await p.waitForLoadState('domcontentloaded').catch(() => {});
    console.log('NEW TAB:', p.url());
  });

  await page.goto('https://www.linkedin.com/jobs/view/4393639520/', { waitUntil: 'networkidle', timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(4000);

  // Find the Apply button
  const applyBtn = await page.$('button[aria-label="Apply on company website"]');
  if (!applyBtn) {
    console.log('No apply button found');
    await browser.close();
    return;
  }

  console.log('Found Apply button. Trying different click methods:\n');

  // Method 1: Playwright click
  console.log('1. page.click() with coordinates...');
  const box = await applyBtn.boundingBox();
  if (box) {
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await page.waitForTimeout(3000);
    console.log('   URL:', page.url().substring(0, 80));
  }

  // Method 2: Keyboard click (focus + Enter)
  console.log('2. Focus + Enter...');
  await applyBtn.focus();
  await page.keyboard.press('Enter');
  await page.waitForTimeout(3000);
  console.log('   URL:', page.url().substring(0, 80));

  // Method 3: Middle-click to force new tab
  console.log('3. Middle-click...');
  if (box) {
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { button: 'middle' });
    await page.waitForTimeout(3000);
  }

  // Method 4: Extract URL from page JS after clicking
  console.log('4. Intercepting window.open...');
  await page.evaluate(() => {
    const origOpen = window.open;
    window.__capturedUrl = null;
    window.open = function(url) {
      window.__capturedUrl = url;
      return origOpen.apply(this, arguments);
    };
  });
  await applyBtn.click();
  await page.waitForTimeout(2000);
  const captured = await page.evaluate(() => window.__capturedUrl);
  console.log('   Captured URL:', captured);

  // Method 5: Check for navigation requests
  console.log('5. Checking page for external URL...');
  const extUrl = await page.evaluate(() => {
    // Sometimes LinkedIn shows the URL in a data attribute or as a redirect
    const links = [...document.querySelectorAll('a[href]')];
    for (const a of links) {
      const txt = (a.innerText || '').toLowerCase();
      if ((txt.includes('apply') || txt.includes('company')) && !a.href.includes('linkedin.com')) {
        return a.href;
      }
    }
    // Check for any redirect URL in the page source
    const html = document.body.innerHTML;
    const m = html.match(/externalApplyUrl['":\s]+["']?(https?:\/\/[^"'\s<]+)/);
    if (m) return m[1];
    const m2 = html.match(/companyApplyUrl['":\s]+["']?(https?:\/\/[^"'\s<]+)/);
    if (m2) return m2[1];
    return null;
  });
  console.log('   External URL from page:', extUrl);

  // Method 6: Network intercept
  console.log('6. Network intercept...');
  let interceptedUrl = null;
  page.on('request', req => {
    const u = req.url();
    if (u.includes('externalApply') || u.includes('apply') && !u.includes('linkedin.com')) {
      interceptedUrl = u;
    }
  });
  await applyBtn.click({ force: true });
  await page.waitForTimeout(3000);
  console.log('   Intercepted:', interceptedUrl);

  saveCookies('linkedin', await context.cookies());
  await browser.close();
  console.log('\nDone');
})();
