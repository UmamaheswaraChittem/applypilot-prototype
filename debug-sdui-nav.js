require('dotenv').config();
const { chromium } = require('playwright');
const { loginLinkedIn } = require('./src/scrapers/linkedin');
const { loadCookies, saveCookies } = require('./src/scrapers/utils');
const path = require('path');
const DIR = path.join(__dirname, 'debug-screenshots');

(async () => {
  const browser = await chromium.launch({ headless: false, args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'] });
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

  // First navigate to a job page
  const jobUrl = 'https://www.linkedin.com/jobs/view/4391669064/';
  console.log('1. Navigating to job page...');
  await page.goto(jobUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
  await page.waitForTimeout(3000);
  console.log('   URL:', page.url().substring(0, 80));

  // Get the Easy Apply href
  const eaHref = await page.evaluate(() => {
    const links = [...document.querySelectorAll('a[href*="openSDUIApplyFlow"], a[href*="/apply/"]')];
    return links.map(a => ({ href: a.href, text: (a.innerText || '').trim().substring(0, 20), tag: a.tagName }));
  });
  console.log('   Easy Apply links:', JSON.stringify(eaHref));

  // Method A: Try goto to SDUI URL
  if (eaHref.length > 0) {
    const sdURL = eaHref[0].href;
    console.log('\n2. Method A: page.goto(SDUI URL)...');
    await page.goto(sdURL, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(3000);
    console.log('   URL after goto:', page.url().substring(0, 80));
    await page.screenshot({ path: path.join(DIR, 'sdui-goto.png') });
  }

  // Method B: Go back to job page, then use page.evaluate to click the link
  console.log('\n3. Method B: Navigate back then click via JS...');
  await page.goto(jobUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
  await page.waitForTimeout(3000);

  // Use dispatchEvent to simulate a real click
  const clicked = await page.evaluate(() => {
    const links = [...document.querySelectorAll('a')];
    for (const a of links) {
      if (/easy\s*apply/i.test(a.innerText) || /easy\s*apply/i.test(a.getAttribute('aria-label') || '')) {
        // Method 1: Direct click
        a.click();
        return { method: 'click', href: a.href };
      }
    }
    return null;
  });
  console.log('   JS click result:', JSON.stringify(clicked));
  await page.waitForTimeout(3000);
  console.log('   URL after JS click:', page.url().substring(0, 80));
  await page.screenshot({ path: path.join(DIR, 'sdui-jsclick.png') });

  // Method C: Go back, use Playwright dispatchEvent with trusted click
  console.log('\n4. Method C: Playwright .click() with position...');
  await page.goto(jobUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
  await page.waitForTimeout(3000);

  const eaBtn = await page.$('a:has-text("Easy Apply")');
  if (eaBtn) {
    const box = await eaBtn.boundingBox();
    if (box) {
      // Scroll into view
      await eaBtn.scrollIntoViewIfNeeded();
      await page.waitForTimeout(500);
      // Click with position
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
      await page.waitForTimeout(3000);
      console.log('   URL after mouse click:', page.url().substring(0, 80));
      await page.screenshot({ path: path.join(DIR, 'sdui-mouse.png') });

      // Check if there's an overlay or modal now
      const overlays = await page.evaluate(() => {
        return [...document.querySelectorAll('[role="dialog"], [class*="modal"], [class*="overlay"]')]
          .filter(el => el.offsetParent !== null || window.getComputedStyle(el).display !== 'none')
          .map(el => ({
            role: el.getAttribute('role') || '',
            cls: (el.className || '').toString().substring(0, 60),
            text: (el.innerText || '').substring(0, 200).replace(/\n/g, ' | '),
            hasForm: !!el.querySelector('form, input, select, textarea'),
          }));
      });
      console.log('   Overlays:', JSON.stringify(overlays, null, 2));
    }
  }

  // Method D: Use window.open
  console.log('\n5. Method D: window.open to SDUI URL...');
  if (eaHref.length > 0) {
    const [newPage] = await Promise.all([
      context.waitForEvent('page', { timeout: 5000 }).catch(() => null),
      page.evaluate(url => window.open(url, '_blank'), eaHref[0].href),
    ]);
    if (newPage) {
      await newPage.waitForLoadState('domcontentloaded').catch(() => {});
      await newPage.waitForTimeout(3000);
      console.log('   New tab URL:', newPage.url().substring(0, 80));
      await newPage.screenshot({ path: path.join(DIR, 'sdui-newtab.png') });
      await newPage.close();
    } else {
      console.log('   No new tab opened');
    }
  }

  saveCookies('linkedin', await context.cookies());
  await browser.close();
  console.log('\nDone');
})();
