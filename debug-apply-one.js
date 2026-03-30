/**
 * Test: Apply to ONE LinkedIn job using the updated code, with full logging.
 */
require('dotenv').config();
const { chromium } = require('playwright');
const { loginLinkedIn } = require('./src/scrapers/linkedin');
const { saveCookies, loadCookies } = require('./src/scrapers/utils');

(async () => {
  console.log('Launching browser...');
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

  const cookies = loadCookies('linkedin');
  if (cookies) await context.addCookies(cookies);

  const page = await context.newPage();
  await loginLinkedIn(page);
  saveCookies('linkedin', await context.cookies());

  // DigiCroz job — confirmed has "تطبيق" apply button
  const jobUrl = 'https://www.linkedin.com/jobs/view/4393639520/';
  console.log(`\nOpening: ${jobUrl}`);
  await page.goto(jobUrl, { waitUntil: 'networkidle', timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(3000);

  // Apply text patterns
  const EASY_APPLY_RE = /easy\s*apply|تقديم\s*سريع|التقدم\s*السريع/i;
  const APPLY_TEXT_RE = /^(easy\s*apply|apply(\s+now)?|تقديم\s*سريع|التقدم\s*السريع|تقديم|تقدم|التقديم|التقدم|تطبيق|قدّم|تقدّم)/i;
  const EXTERNAL_APPLY_RE = /company\s*(web)?site|external|خارج|موقع\s*الشركة/i;

  console.log('\nScanning buttons...');
  const allButtons = await page.$$('button, a[role="button"], a[href]');
  console.log(`Total elements: ${allButtons.length}`);

  let foundEasyApply = null, foundExternalApply = null;

  for (const btn of allButtons) {
    try {
      if (!await btn.isVisible().catch(() => false)) continue;
      const txt = (await btn.innerText().catch(() => '')).trim();
      const ariaLabel = await btn.getAttribute('aria-label') || '';
      if (!txt && !ariaLabel) continue;

      const isApplyText = APPLY_TEXT_RE.test(txt);
      const isApplyAria = APPLY_TEXT_RE.test(ariaLabel);
      const isEasyApply = EASY_APPLY_RE.test(txt) || EASY_APPLY_RE.test(ariaLabel);
      const isExternal = EXTERNAL_APPLY_RE.test(ariaLabel);

      if (isApplyText || isApplyAria || isEasyApply) {
        console.log(`  ★ MATCH: "${txt.substring(0, 30)}" aria="${ariaLabel.substring(0, 50)}" easy=${isEasyApply} external=${isExternal}`);
        if (isEasyApply) foundEasyApply = btn;
        else if (isExternal) foundExternalApply = btn;
        else foundEasyApply = btn;
      }
    } catch {}
  }

  console.log(`\nResults: easyApply=${!!foundEasyApply} externalApply=${!!foundExternalApply}`);

  if (foundExternalApply && !foundEasyApply) {
    console.log('\nClicking external apply button...');
    const [popup] = await Promise.all([
      page.context().waitForEvent('page', { timeout: 8000 }).catch(() => null),
      foundExternalApply.click({ timeout: 3000 }).catch(() => foundExternalApply.evaluate(e => e.click())),
    ]);

    if (popup && !popup.isClosed()) {
      await popup.waitForLoadState('domcontentloaded').catch(() => {});
      console.log(`  → Popup URL: ${popup.url()}`);
      await popup.close().catch(() => {});
    } else {
      await page.waitForTimeout(2000);
      console.log(`  → Current URL: ${page.url()}`);
    }
  } else if (foundEasyApply) {
    console.log('\nClicking easy apply button...');
    await foundEasyApply.click().catch(() => {});
    await page.waitForTimeout(2000);
    console.log(`  → URL: ${page.url()}`);
  } else {
    console.log('\nNo apply button found!');
  }

  await page.waitForTimeout(3000);
  await browser.close();
  console.log('\n✓ Done');
})();
