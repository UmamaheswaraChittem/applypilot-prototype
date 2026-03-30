/**
 * Debug: Walk through Easy Apply form steps and log ALL visible inputs at each step
 * Uses only Playwright selectors (pierce Shadow DOM)
 */
require('dotenv').config();
const { chromium } = require('playwright');
const { loginLinkedIn } = require('./src/scrapers/linkedin');
const { loadCookies, saveCookies } = require('./src/scrapers/utils');
const path = require('path');
const DIR = path.join(__dirname, 'debug-screenshots');

async function forceClick(el) {
  if (!el) return false;
  try {
    await el.scrollIntoViewIfNeeded().catch(() => {});
    await el.click({ timeout: 3000 }).catch(async () => {
      await el.click({ force: true, timeout: 3000 }).catch(async () => {
        await el.evaluate(e => e.click());
      });
    });
    return true;
  } catch { return false; }
}

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

  // Navigate to an Easy Apply job
  await page.goto('https://www.linkedin.com/jobs/view/4394090044/', { waitUntil: 'domcontentloaded', timeout: 15000 });
  await page.waitForTimeout(3000);

  // Click Easy Apply
  const eaBtn = await page.$('a:has-text("Easy Apply"), button:has-text("Easy Apply")');
  if (!eaBtn) { console.log('No Easy Apply button'); await browser.close(); return; }
  const box = await eaBtn.boundingBox();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);

  // Wait for modal
  await page.waitForSelector('button[aria-label*="Continue"], button[aria-label*="Next"], button[aria-label*="Submit"], button:has-text("Next")' , {
    timeout: 5000, state: 'visible'
  }).catch(() => null);
  await page.waitForTimeout(1000);

  // Walk through steps
  for (let step = 0; step < 8; step++) {
    console.log(`\n${'='.repeat(60)}`);
    console.log(`STEP ${step}`);
    console.log('='.repeat(60));
    await page.screenshot({ path: path.join(DIR, `form-step${step}.png`) });

    // Get progress bar text using Playwright
    const progressText = await page.$eval('progress, [role="progressbar"], [class*="progress"]', el => el.getAttribute('aria-valuenow') || el.getAttribute('value') || el.innerText || '').catch(() => 'none');
    console.log(`Progress: ${progressText}`);

    // List ALL visible inputs using Playwright selectors (pierces Shadow DOM)
    const inputs = await page.$$('input:visible');
    console.log(`\nVisible inputs: ${inputs.length}`);
    for (let i = 0; i < inputs.length; i++) {
      const inp = inputs[i];
      try {
        const type = await inp.getAttribute('type') || 'text';
        const id = await inp.getAttribute('id') || '';
        const name = await inp.getAttribute('name') || '';
        const ph = await inp.getAttribute('placeholder') || '';
        const aria = await inp.getAttribute('aria-label') || '';
        const val = await inp.inputValue().catch(() => '');
        const required = await inp.getAttribute('required') !== null;
        // Try to get label
        let labelText = '';
        try {
          if (id) {
            const lbl = await page.$(`label[for="${id.replace(/([^\w-])/g, '\\\\$1')}"]`).catch(() => null);
            if (lbl) labelText = await lbl.innerText().catch(() => '');
          }
          if (!labelText) {
            labelText = await inp.evaluate(el => {
              let p = el.parentElement;
              for (let j = 0; j < 5 && p; j++) {
                const lbl = p.querySelector('label, legend');
                if (lbl && lbl.innerText?.trim()) return lbl.innerText.trim();
                p = p.parentElement;
              }
              return '';
            }).catch(() => '');
          }
        } catch {}
        console.log(`  [${i}] type=${type} id="${id.substring(0,30)}" name="${name.substring(0,30)}" ph="${ph.substring(0,30)}" aria="${aria.substring(0,30)}" val="${val.substring(0,20)}" label="${labelText.substring(0,40)}" req=${required}`);
      } catch (e) {
        console.log(`  [${i}] Error: ${e.message.substring(0, 50)}`);
      }
    }

    // List visible selects
    const selects = await page.$$('select:visible');
    console.log(`\nVisible selects: ${selects.length}`);
    for (let i = 0; i < selects.length; i++) {
      try {
        const id = await selects[i].getAttribute('id') || '';
        const val = await selects[i].inputValue().catch(() => '');
        console.log(`  [${i}] id="${id.substring(0,30)}" val="${val}"`);
      } catch {}
    }

    // List visible textareas
    const textareas = await page.$$('textarea:visible');
    console.log(`\nVisible textareas: ${textareas.length}`);

    // List visible checkboxes
    const checkboxes = await page.$$('input[type="checkbox"]:visible');
    console.log(`Visible checkboxes: ${checkboxes.length}`);
    for (let i = 0; i < checkboxes.length; i++) {
      try {
        const checked = await checkboxes[i].isChecked();
        const aria = await checkboxes[i].getAttribute('aria-label') || '';
        console.log(`  [${i}] checked=${checked} aria="${aria.substring(0,40)}"`);
      } catch {}
    }

    // List visible radio buttons
    const radios = await page.$$('input[type="radio"]:visible');
    console.log(`Visible radios: ${radios.length}`);

    // List ALL visible buttons
    const buttons = await page.$$('button:visible');
    console.log(`\nVisible buttons: ${buttons.length}`);
    for (let i = 0; i < buttons.length; i++) {
      try {
        const text = (await buttons[i].innerText().catch(() => '')).trim().substring(0, 30);
        const aria = (await buttons[i].getAttribute('aria-label') || '').substring(0, 40);
        if (text || aria) console.log(`  [${i}] "${text}" aria="${aria}"`);
      } catch {}
    }

    // Check for errors
    const errors = await page.$$('[class*="error"]:visible, [role="alert"]:visible');
    if (errors.length > 0) {
      console.log(`\nErrors: ${errors.length}`);
      for (const err of errors) {
        const text = await err.innerText().catch(() => '');
        if (text.trim()) console.log(`  ERROR: "${text.trim().substring(0, 60)}"`);
      }
    }

    // Check for "application submitted" success
    const bodyText = await page.evaluate(() => (document.body.innerText || '').toLowerCase()).catch(() => '');
    if (bodyText.includes('application submitted') || bodyText.includes('application was sent')) {
      console.log('\n*** APPLICATION SUBMITTED ***');
      break;
    }

    // Find next/submit button
    const submitBtn = await page.$('button[aria-label="Submit application"], button:has-text("Submit application")').catch(() => null);
    if (submitBtn && await submitBtn.isVisible().catch(() => false)) {
      console.log('\n→ Found Submit button — clicking...');
      await forceClick(submitBtn);
      await page.waitForTimeout(3000);
      await page.screenshot({ path: path.join(DIR, `form-submitted.png`) });
      console.log('Submitted!');
      break;
    }

    const nextBtn = await page.$('button[aria-label="Continue to next step"], button:has-text("Next"), button[aria-label*="Next"], button[aria-label*="Continue"]').catch(() => null);
    if (nextBtn && await nextBtn.isVisible().catch(() => false)) {
      const btnText = await nextBtn.innerText().catch(() => '');
      const btnAria = await nextBtn.getAttribute('aria-label').catch(() => '');
      console.log(`\n→ Clicking: "${btnText.trim()}" aria="${btnAria}"`);
      await forceClick(nextBtn);
      await page.waitForTimeout(2000);
    } else {
      console.log('\n→ No next/submit button found — stopping');
      break;
    }
  }

  // Dismiss modal
  const dismissBtn = await page.$('button[aria-label="Dismiss"]').catch(() => null);
  if (dismissBtn) {
    await dismissBtn.click().catch(() => {});
    await page.waitForTimeout(500);
    const discardBtn = await page.$('button:has-text("Discard"), button:has-text("Yes")').catch(() => null);
    if (discardBtn && await discardBtn.isVisible().catch(() => false)) await discardBtn.click().catch(() => {});
  }

  saveCookies('linkedin', await context.cookies());
  await browser.close();
  console.log('\nDone');
})();
