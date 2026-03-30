/**
 * Test script: Apply to 5 LinkedIn Easy Apply jobs
 * Opens each job, identifies Easy Apply vs External, and only applies to Easy Apply ones.
 */
require('dotenv').config();
const { chromium } = require('playwright');
const { loginLinkedIn } = require('./src/scrapers/linkedin');
const { loadCookies, saveCookies } = require('./src/scrapers/utils');
const path = require('path');
const fs = require('fs');

const PROFILE = {
  phone: process.env.PHONE || '+919866762869',
  expectedCtc: parseInt(process.env.EXPECTED_CTC_LPA || '45'),
  noticePeriod: parseInt(process.env.NOTICE_DAYS || '30'),
  city: process.env.CITY || 'Hyderabad',
  resumePath: process.env.RESUME_PATH || '',
  firstName: process.env.FIRST_NAME || 'Umamaheswara Rao',
  lastName: process.env.LAST_NAME || 'CH',
};

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

async function handleFormPage(page) {
  // Phone
  for (const sel of ['input[id*="phoneNumber"]', 'input[name*="phone"]', 'input[placeholder*="Phone"]']) {
    try {
      const el = await page.$(sel);
      if (el) { const v = await el.inputValue(); if (!v || !v.trim()) await el.fill(PROFILE.phone); }
    } catch {}
  }
  // City
  for (const sel of ['input[id*="city"]', 'input[name*="city"]', 'input[placeholder*="City"]']) {
    try {
      const el = await page.$(sel);
      if (el) {
        const v = await el.inputValue();
        if (!v || !v.trim()) {
          await el.fill(PROFILE.city);
          await page.waitForTimeout(400);
          const sug = await page.$('[role="option"], [role="listbox"] li');
          if (sug) await forceClick(sug);
        }
      }
    } catch {}
  }
  // Resume
  if (PROFILE.resumePath && fs.existsSync(PROFILE.resumePath)) {
    const fileInputs = await page.$$('input[type="file"]');
    for (const input of fileInputs) {
      try {
        const accept = (await input.getAttribute('accept') || '').toLowerCase();
        if (!accept || accept.includes('pdf') || accept.includes('doc') || accept.includes('*')) {
          await input.setInputFiles(PROFILE.resumePath);
        }
      } catch {}
    }
  }
  // Numeric inputs
  const numericInputs = await page.$$('input[type="text"], input[type="number"]');
  for (const input of numericInputs) {
    try {
      if (!await input.isVisible().catch(() => false)) continue;
      const id = (await input.getAttribute('id') || '').toLowerCase();
      const name = (await input.getAttribute('name') || '').toLowerCase();
      const placeholder = (await input.getAttribute('placeholder') || '').toLowerCase();
      const ariaLabel = (await input.getAttribute('aria-label') || '').toLowerCase();
      const labelEl = await page.$(`label[for="${await input.getAttribute('id')}"]`).catch(() => null);
      const labelText = labelEl ? (await labelEl.innerText().catch(() => '')) : '';
      const combined = `${id} ${name} ${placeholder} ${ariaLabel} ${labelText}`.toLowerCase();
      const val = await input.inputValue();
      if (val && val.trim()) continue;
      if (/salary|ctc|compensation|expected|lpa/i.test(combined)) { await input.fill(String(PROFILE.expectedCtc)); continue; }
      if (/notice|joining|availability/i.test(combined)) { await input.fill(String(PROFILE.noticePeriod)); continue; }
      if (/experience|years/i.test(combined)) { await input.fill('8'); continue; }
    } catch {}
  }
  // Radio buttons
  const radioGroups = await page.$$('fieldset, [role="radiogroup"]');
  for (const group of radioGroups) {
    try {
      const legend = await group.$('legend, label');
      const legendText = legend ? (await legend.innerText().catch(() => '')).toLowerCase() : '';
      const radios = await group.$$('input[type="radio"]');
      if (radios.length === 0) continue;
      let anySelected = false;
      for (const r of radios) { if (await r.isChecked()) { anySelected = true; break; } }
      if (anySelected) continue;
      let targetRadio = radios[0];
      for (const radio of radios) {
        const radioId = await radio.getAttribute('id') || '';
        const assocLabel = await page.$(`label[for="${radioId}"]`);
        const assocText = assocLabel ? (await assocLabel.innerText().catch(() => '')).toLowerCase() : '';
        const text = (await radio.getAttribute('aria-label') || '').toLowerCase() + ' ' + assocText;
        if (/sponsor|visa|authoriz|work permit/i.test(legendText)) {
          if (/\bno\b/.test(text)) { targetRadio = radio; break; }
        } else {
          if (/\byes\b/.test(text)) { targetRadio = radio; break; }
        }
      }
      await targetRadio.check().catch(() => forceClick(targetRadio));
    } catch {}
  }
  // Dropdowns
  const selects = await page.$$('select');
  for (const sel of selects) {
    try {
      if (!await sel.isVisible().catch(() => false)) continue;
      const val = await sel.inputValue();
      if (val && val !== '') continue;
      const options = await sel.$$('option');
      if (options.length > 1) {
        const secondOption = await options[1].getAttribute('value');
        if (secondOption) await sel.selectOption(secondOption);
      }
    } catch {}
  }
  // Textarea
  const textareas = await page.$$('textarea');
  for (const ta of textareas) {
    try {
      if (!await ta.isVisible().catch(() => false)) continue;
      const val = await ta.inputValue();
      if (val && val.trim()) continue;
      await ta.fill(
        `I am a Senior Node.js & Conversational AI specialist with 8 years of experience. ` +
        `Expertise in Cognigy.AI, Kore.AI XO11, LLM/GenAI, and IVR development.`
      );
    } catch {}
  }
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

  // Force English
  const lang = await page.evaluate(() => document.documentElement.lang).catch(() => 'en');
  if (lang !== 'en') {
    console.log(`Language is "${lang}", switching to English...`);
    await page.goto('https://www.linkedin.com/mypreferences/d/settings/language', { waitUntil: 'networkidle', timeout: 15000 });
    await page.waitForTimeout(1500);
    await page.evaluate(() => {
      const sel = document.querySelector('select');
      if (sel) { sel.value = 'en_US'; sel.dispatchEvent(new Event('change', { bubbles: true })); }
    });
    await page.waitForTimeout(1000);
    const saveBtn = await page.$('button[type="submit"]').catch(() => null)
      || await page.$('button:has-text("Save")').catch(() => null)
      || await page.$('button:has-text("حفظ")').catch(() => null);
    if (saveBtn) { await saveBtn.click().catch(() => {}); await page.waitForTimeout(3000); }
    console.log('Language set to English');
  }

  // Search for Easy Apply jobs
  const searchUrl = 'https://www.linkedin.com/jobs/search/?keywords=Node.js%20developer&f_AL=true&f_WT=2&sortBy=DD&geoId=102713980';
  console.log('\nSearching for Easy Apply jobs...');
  await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(3000);

  // Collect job links from search results
  const jobLinks = await page.evaluate(() => {
    const links = [];
    const cards = document.querySelectorAll('a[href*="/jobs/view/"]');
    for (const a of cards) {
      const href = a.href.split('?')[0];
      if (href && !links.includes(href)) links.push(href);
    }
    return links.slice(0, 15); // Get 15 candidates to find 5 Easy Apply
  });
  console.log(`Found ${jobLinks.length} job links\n`);

  let applied = 0;
  let tried = 0;
  const MAX_APPLY = 5;

  for (const jobUrl of jobLinks) {
    if (applied >= MAX_APPLY) break;
    tried++;
    console.log(`\n[${tried}] ${jobUrl}`);

    try {
      await page.goto(jobUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
      await page.waitForTimeout(2500);

      // Scroll to load apply area
      await page.evaluate(() => window.scrollBy(0, 300)).catch(() => {});
      await page.waitForTimeout(500);

      // Find the apply button
      const EASY_APPLY_RE = /easy\s*apply/i;
      let easyApplyBtn = null;

      const allButtons = await page.$$('button, a[role="button"], a[href]');
      for (const btn of allButtons) {
        try {
          if (!await btn.isVisible().catch(() => false)) continue;
          const txt = (await btn.innerText().catch(() => '')).trim();
          if (!txt || txt.length > 30 || txt.includes('\n')) continue;
          const ariaLabel = await btn.getAttribute('aria-label') || '';

          if (EASY_APPLY_RE.test(txt) || EASY_APPLY_RE.test(ariaLabel)) {
            easyApplyBtn = btn;
            console.log(`  Found Easy Apply: "${txt}" aria="${ariaLabel}"`);
            break;
          }
        } catch {}
      }

      if (!easyApplyBtn) {
        console.log('  Not Easy Apply — skipping');
        continue;
      }

      // Get job title
      const title = await page.$eval('h1', el => el.innerText.trim().substring(0, 60)).catch(() => 'Unknown');
      console.log(`  Job: ${title}`);

      // Click Easy Apply
      await forceClick(easyApplyBtn);
      await page.waitForTimeout(1000);

      // Check for SDUI flow (URL changed to /apply/)
      if (page.url().includes('/apply/')) {
        console.log('  SDUI flow detected');
        for (let step = 0; step < 8; step++) {
          await page.waitForTimeout(500);
          await handleFormPage(page);
          const success = await page.$('[class*="post-apply"], h2:has-text("Application submitted")').catch(() => null);
          if (success) { console.log(`  ✓ APPLIED (SDUI): ${title}`); applied++; break; }
          const submitBtn = await page.$('button[aria-label="Submit application"], button:has-text("Submit application")').catch(() => null);
          if (submitBtn) { await forceClick(submitBtn); await page.waitForTimeout(1000); console.log(`  ✓ APPLIED (SDUI submit): ${title}`); applied++; break; }
          const nextBtn = await page.$('button[aria-label="Continue to next step"], button[aria-label="Review your application"], button[aria-label="Review"], button[aria-label*="Next"], button[aria-label*="Continue"]').catch(() => null);
          if (nextBtn) { await forceClick(nextBtn); continue; }
          console.log(`  ✗ Stuck at SDUI step ${step}`);
          break;
        }
        // Navigate back
        await page.goto('about:blank').catch(() => {});
        continue;
      }

      // Check for modal
      const modal = await page.waitForSelector(
        '[role="dialog"], [aria-label*="Easy Apply"]',
        { timeout: 5000 }
      ).catch(() => null);

      if (!modal) {
        // Check one more time for SDUI
        if (page.url().includes('/apply/')) {
          console.log('  Late SDUI flow detected');
          continue;
        }
        console.log('  ✗ Modal did not open');
        // Screenshot for debugging
        await page.screenshot({ path: path.join(__dirname, 'debug-screenshots', `modal-fail-${tried}.png`) });
        continue;
      }

      console.log('  Modal opened! Walking form...');

      // Walk modal steps
      for (let step = 0; step < 8; step++) {
        await page.waitForTimeout(500);
        await handleFormPage(page);

        // Check for submit
        const submitBtn = await page.$([
          'button[aria-label="Submit application"]',
          'button[aria-label*="Submit"]',
          'button:has-text("Submit application")',
        ].join(', ')).catch(() => null);

        if (submitBtn && await submitBtn.isVisible().catch(() => false)) {
          console.log(`  Submitting at step ${step}...`);
          await forceClick(submitBtn);
          await page.waitForTimeout(1500);

          // Check success
          const bodyText = await page.evaluate(() => (document.body.innerText || '').toLowerCase()).catch(() => '');
          if (bodyText.includes('application submitted') || bodyText.includes('application was sent')) {
            console.log(`  ✓ APPLIED: ${title}`);
            applied++;
          } else {
            const stillDialog = await page.$('[role="dialog"]').catch(() => null);
            if (!stillDialog) {
              console.log(`  ✓ APPLIED (modal closed): ${title}`);
              applied++;
            } else {
              console.log(`  ⚠ Submit may have failed (dialog still open)`);
              await page.screenshot({ path: path.join(__dirname, 'debug-screenshots', `submit-fail-${tried}.png`) });
            }
          }
          break;
        }

        // Check for next/continue
        const nextBtn = await page.$([
          'button[aria-label="Continue to next step"]',
          'button[aria-label="Review your application"]',
          'button[aria-label="Review"]',
          'button[aria-label*="Next"]',
          'button[aria-label*="Continue"]',
        ].join(', ')).catch(() => null);

        if (nextBtn && await nextBtn.isVisible().catch(() => false)) {
          console.log(`  Step ${step}: clicking Next...`);
          await forceClick(nextBtn);
          continue;
        }

        console.log(`  ✗ No submit or next button at step ${step}`);
        // Log what buttons ARE visible in the dialog
        const dialogBtns = await page.evaluate(() => {
          const dialog = document.querySelector('[role="dialog"]');
          if (!dialog) return [];
          return [...dialog.querySelectorAll('button')].filter(b => b.offsetParent !== null)
            .map(b => ({ text: b.innerText.trim().substring(0, 30), aria: (b.getAttribute('aria-label') || '').substring(0, 40) }));
        }).catch(() => []);
        console.log(`  Dialog buttons: ${JSON.stringify(dialogBtns)}`);
        await page.screenshot({ path: path.join(__dirname, 'debug-screenshots', `stuck-step-${tried}.png`) });
        break;
      }

      // Cleanup: close modal if still open
      const dismissBtn = await page.$('button[aria-label="Dismiss"], button[aria-label="Cancel"], button[aria-label="Close"]').catch(() => null);
      if (dismissBtn && await dismissBtn.isVisible().catch(() => false)) {
        await forceClick(dismissBtn);
        await page.waitForTimeout(300);
        const discardBtn = await page.$('button:has-text("Discard"), button:has-text("Yes, discard"), button[data-test-dialog-primary-btn]').catch(() => null);
        if (discardBtn && await discardBtn.isVisible().catch(() => false)) {
          await forceClick(discardBtn);
          await page.waitForTimeout(300);
        }
      }

    } catch (err) {
      console.log(`  Error: ${err.message.substring(0, 80)}`);
    }
  }

  saveCookies('linkedin', await context.cookies());
  await browser.close();

  console.log(`\n${'='.repeat(50)}`);
  console.log(`RESULTS: ${applied} / ${tried} jobs applied`);
  console.log(`${'='.repeat(50)}`);
})();
