/**
 * Test: Apply to 5 Easy Apply jobs using SDUI flow (direct navigation)
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

async function getLabelForInput(page, input) {
  try {
    const id = await input.getAttribute('id');
    if (id) {
      const label = await page.$(`label[for="${id.replace(/([^\w-])/g, '\\\\$1')}"]`).catch(() => null);
      if (label) {
        const text = await label.innerText().catch(() => '');
        if (text.trim()) return text.trim().toLowerCase();
      }
    }
  } catch {}
  try {
    const text = await input.evaluate(el => {
      let p = el.parentElement;
      for (let i = 0; i < 5 && p; i++) {
        const lbl = p.querySelector('label, legend, span[class*="label"], div[class*="label"]');
        if (lbl && lbl.innerText?.trim()) return lbl.innerText.trim();
        p = p.parentElement;
      }
      return '';
    }).catch(() => '');
    if (text) return text.toLowerCase();
  } catch {}
  return '';
}

async function handleFormPage(page) {
  async function getInputContext(input) {
    const id = (await input.getAttribute('id') || '').toLowerCase();
    const name = (await input.getAttribute('name') || '').toLowerCase();
    const ph = (await input.getAttribute('placeholder') || '').toLowerCase();
    const aria = (await input.getAttribute('aria-label') || '').toLowerCase();
    const lbl = await getLabelForInput(page, input);
    return `${id} ${name} ${ph} ${aria} ${lbl}`;
  }

  // ── Find and fill ALL visible inputs ──
  for (const input of await page.$$('input:visible')) {
    try {
      const type = (await input.getAttribute('type') || 'text').toLowerCase();
      if (['hidden', 'file', 'radio', 'checkbox', 'submit', 'button'].includes(type)) continue;
      const v = await input.inputValue().catch(() => '');
      if (v?.trim()) continue;

      const ctx = await getInputContext(input);
      if (/phone|mobile|contact.*number/i.test(ctx)) { await input.fill(PROFILE.phone); continue; }
      if (/city|location/i.test(ctx)) {
        await input.fill(PROFILE.city);
        await page.waitForTimeout(800);
        const sug = await page.$('[role="option"], [role="listbox"] li').catch(() => null);
        if (sug) { await forceClick(sug); }
        else { await page.waitForTimeout(500); const s2 = await page.$('[role="option"], [role="listbox"] li').catch(() => null); if (s2) await forceClick(s2); }
        continue;
      }
      if (/salary|ctc|compensation|expected|lpa|package/i.test(ctx)) {
        // If field asks for INR (not LPA), multiply by 100000
        const ctcVal = /\binr\b|in\s*inr|per\s*annum|annual/i.test(ctx) ? PROFILE.expectedCtc * 100000 : PROFILE.expectedCtc;
        await input.fill(String(ctcVal)); continue;
      }
      if (/rate.*hour|hourly.*rate|per\s*hour/i.test(ctx)) { await input.fill('2500'); continue; }
      if (/portfolio|website|url|github|link/i.test(ctx) && !/linkedin/i.test(ctx)) { await input.fill('https://github.com/umamaheswar'); continue; }
      if (/notice|joining|availability/i.test(ctx)) { await input.fill(String(PROFILE.noticePeriod)); continue; }
      if (/experience|years/i.test(ctx)) { await input.fill('3'); continue; }
      if (/first.*name/i.test(ctx)) { await input.fill(process.env.FIRST_NAME || 'Pravallika'); continue; }
      if (/last.*name/i.test(ctx)) { await input.fill(process.env.LAST_NAME || 'Gutha'); continue; }
      if (/email/i.test(ctx)) { await input.fill(process.env.LINKEDIN_EMAIL || ''); continue; }
      if (type === 'number') { await input.fill('5'); continue; }
      // Fallback: fill required text inputs
      const isReq = await input.getAttribute('required') !== null || await input.getAttribute('aria-required') === 'true';
      if (isReq && type === 'text') { await input.fill('8'); }
    } catch {}
  }
  // Resume
  if (PROFILE.resumePath && fs.existsSync(PROFILE.resumePath)) {
    for (const input of await page.$$('input[type="file"]')) {
      try {
        const accept = (await input.getAttribute('accept') || '').toLowerCase();
        if (!accept || accept.includes('pdf') || accept.includes('doc') || accept.includes('*'))
          await input.setInputFiles(PROFILE.resumePath);
      } catch {}
    }
  }
  // Radio buttons
  for (const group of await page.$$('fieldset, [role="radiogroup"]')) {
    try {
      const legend = await group.$('legend, label');
      const lt = legend ? (await legend.innerText().catch(() => '')).toLowerCase() : '';
      const radios = await group.$$('input[type="radio"]');
      if (!radios.length) continue;
      let sel = false; for (const r of radios) { if (await r.isChecked()) { sel = true; break; } }
      if (sel) continue;
      let target = radios[0];
      for (const r of radios) {
        const rid = await r.getAttribute('id') || '';
        const al = await page.$(`label[for="${rid.replace(/([^\w-])/g, '\\\\$1')}"]`).catch(() => null);
        const at = al ? (await al.innerText().catch(() => '')).toLowerCase() : '';
        const t = (await r.getAttribute('aria-label') || '').toLowerCase() + ' ' + at;
        if (/sponsor|visa|authoriz|work permit/i.test(lt)) { if (/\bno\b/.test(t)) { target = r; break; } }
        else { if (/\byes\b/.test(t)) { target = r; break; } }
      }
      await target.check().catch(() => forceClick(target));
    } catch {}
  }
  // Standalone radio buttons (not inside fieldset/radiogroup)
  // Group radios by name attribute, select "Yes" by default
  const allRadios = await page.$$('input[type="radio"]:visible');
  const radiosByName = {};
  for (const r of allRadios) {
    try {
      if (await r.isChecked()) continue;
      const name = await r.getAttribute('name') || await r.getAttribute('id') || 'unknown';
      if (!radiosByName[name]) radiosByName[name] = [];
      radiosByName[name].push(r);
    } catch {}
  }
  for (const [name, radios] of Object.entries(radiosByName)) {
    try {
      // Check if any in this group is already checked
      let anyChecked = false;
      for (const r of radios) { if (await r.isChecked().catch(() => false)) { anyChecked = true; break; } }
      if (anyChecked) continue;
      // Get question context from nearby labels
      let questionCtx = '';
      try {
        const firstRadio = radios[0];
        questionCtx = await firstRadio.evaluate(el => {
          let p = el.parentElement;
          for (let i = 0; i < 8 && p; i++) {
            const legend = p.querySelector('legend, h3, h4, label, span[class*="label"]');
            if (legend && legend.innerText?.trim().length > 5) return legend.innerText.trim();
            p = p.parentElement;
          }
          return '';
        }).catch(() => '');
      } catch {}
      // Default: select "Yes" unless it's a visa/sponsorship question
      let target = radios[0];
      for (const r of radios) {
        const lbl = await getLabelForInput(page, r);
        const val = (await r.getAttribute('value') || '').toLowerCase();
        if (/sponsor|visa|authoriz|work permit/i.test(questionCtx)) {
          if (/\bno\b/i.test(lbl) || val === 'no') { target = r; break; }
        } else {
          if (/\byes\b/i.test(lbl) || val === 'yes') { target = r; break; }
        }
      }
      await target.check().catch(() => forceClick(target));
    } catch {}
  }

  // Dropdowns
  for (const sel of await page.$$('select:visible')) {
    try {
      const v = await sel.inputValue();
      // Check if current selection is a placeholder ("Select an option", "", etc.)
      const selectedText = await sel.$eval('option:checked', o => o.innerText?.trim() || '').catch(() => '');
      const isPlaceholder = !v || v === '' || /select|choose|pick/i.test(selectedText);
      if (!isPlaceholder) continue;
      const opts = await sel.$$('option');
      // Pick the best option based on context
      const ctx = await getInputContext(sel).catch(() => '');
      if (/experience|years/i.test(ctx)) {
        // Try to find "8" or closest to 8 years
        for (const opt of opts) {
          const txt = await opt.innerText().catch(() => '');
          if (/\b8\b/.test(txt)) { await sel.selectOption(await opt.getAttribute('value')); break; }
        }
        // If none matched, just pick last option (usually highest)
        const currentVal = await sel.inputValue();
        if (!currentVal || /select|choose/i.test(await sel.$eval('option:checked', o => o.innerText || '').catch(() => ''))) {
          if (opts.length > 2) await sel.selectOption(await opts[opts.length - 1].getAttribute('value'));
          else if (opts.length > 1) await sel.selectOption(await opts[1].getAttribute('value'));
        }
      } else if (opts.length > 1) {
        await sel.selectOption(await opts[1].getAttribute('value'));
      }
    } catch {}
  }
  // Textarea
  for (const ta of await page.$$('textarea:visible')) {
    try {
      const v = await ta.inputValue(); if (v?.trim()) continue;
      await ta.fill('I am a Node.js developer with 3 years of experience in building scalable web applications using Node.js, Express.js, React.js, MongoDB, and SQL. I am passionate about clean code and eager to contribute to your team.');
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

  // Search for Easy Apply jobs with multiple queries for more results
  console.log('Searching for Easy Apply jobs...\n');
  const searches = [
    'https://www.linkedin.com/jobs/search/?keywords=react%20developer&f_AL=true&sortBy=DD&geoId=102713980',
    'https://www.linkedin.com/jobs/search/?keywords=python%20developer&f_AL=true&sortBy=DD&geoId=102713980',
    'https://www.linkedin.com/jobs/search/?keywords=API%20developer&f_AL=true&sortBy=DD&geoId=102713980',
    'https://www.linkedin.com/jobs/search/?keywords=senior%20developer&f_AL=true&sortBy=DD&geoId=102713980',
    'https://www.linkedin.com/jobs/search/?keywords=cloud%20engineer&f_AL=true&sortBy=DD&geoId=102713980',
    'https://www.linkedin.com/jobs/search/?keywords=microservices%20developer&f_AL=true&sortBy=DD&geoId=102713980',
  ];
  const allJobIds = new Set();
  for (const searchUrl of searches) {
    await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(2000);
    const ids = await page.evaluate(() => {
      const ids = new Set();
      document.querySelectorAll('a[href*="/jobs/view/"]').forEach(a => {
        const m = a.href.match(/\/jobs\/view\/(\d+)/);
        if (m) ids.add(m[1]);
      });
      return [...ids];
    });
    ids.forEach(id => allJobIds.add(id));
    console.log(`  Search: ${ids.length} jobs found`);
    if (allJobIds.size >= 25) break;
  }
  const jobIds = [...allJobIds].slice(0, 30);
  console.log(`\nTotal unique job IDs: ${jobIds.length}\n`);

  let applied = 0;
  const TARGET = 5;

  for (let i = 0; i < jobIds.length && applied < TARGET; i++) {
    const jobId = jobIds[i];
    const jobUrl = `https://www.linkedin.com/jobs/view/${jobId}/`;
    console.log(`[${i + 1}] Job ${jobId}`);

    try {
      // Navigate to job page
      await page.goto(jobUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
      await page.waitForTimeout(2000);

      // Get job title
      const title = await page.$eval('h1', el => el.innerText.trim().substring(0, 50)).catch(() => 'Unknown');
      console.log(`  Title: ${title}`);

      // Check if already applied — look for "Applied X ago" badge or "Application submitted"
      const alreadyApplied = await page.evaluate(() => {
        // Check for "Applied X ago" anywhere visible
        const els = document.querySelectorAll('span, div, p, li');
        for (const el of els) {
          const t = (el.innerText || '').trim().toLowerCase();
          if (/^applied\s+\d+\s+(second|minute|hour|day|week|month)/i.test(t)) return true;
          if (t === 'applied' && el.offsetParent !== null) return true;
        }
        // Check for "Application submitted"
        const body = (document.body.innerText || '').toLowerCase();
        if (body.includes('application submitted')) return true;
        return false;
      }).catch(() => false);
      if (alreadyApplied) {
        console.log('  Already applied — skip\n');
        continue;
      }

      // Find the Easy Apply button
      const eaBtn = await page.$('a:has-text("Easy Apply"), button:has-text("Easy Apply")');
      if (!eaBtn) {
        console.log('  Not Easy Apply — skip\n');
        continue;
      }

      // Scroll into view FIRST, then get boundingBox
      await eaBtn.scrollIntoViewIfNeeded().catch(() => {});
      await page.waitForTimeout(500);
      const box = await eaBtn.boundingBox();
      if (!box) { console.log('  Button not visible — skip\n'); continue; }
      // Safety check: if button is off-screen, scroll page to it
      if (box.y > 700 || box.y < 0) {
        await page.evaluate((y) => window.scrollTo(0, y - 300), box.y);
        await page.waitForTimeout(500);
        const box2 = await eaBtn.boundingBox();
        if (box2) Object.assign(box, box2);
      }
      console.log(`  Clicking Easy Apply at (${Math.round(box.x + box.width/2)}, ${Math.round(box.y + box.height/2)})...`);
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);

      // Wait for the modal — use Playwright waitForSelector with the Next/Submit/Continue button
      // The modal always has a Next, Continue, Submit, or Review button
      const modalBtn = await page.waitForSelector([
        'button[aria-label="Continue to next step"]',
        'button[aria-label="Submit application"]',
        'button[aria-label="Review your application"]',
        'button[aria-label*="Next"]',
        'button[aria-label*="Continue"]',
        'button:has-text("Next")',
        'button:has-text("Submit application")',
      ].join(', '), { timeout: 5000, state: 'visible' }).catch(() => null);

      if (!modalBtn && !page.url().includes('/apply/')) {
        // Retry: scroll to button again and click
        console.log('  Modal not detected — retrying click...');
        const eaBtn2 = await page.$('a:has-text("Easy Apply"), button:has-text("Easy Apply")');
        if (eaBtn2) {
          await eaBtn2.scrollIntoViewIfNeeded().catch(() => {});
          await page.waitForTimeout(500);
          const box2 = await eaBtn2.boundingBox();
          if (box2) {
            await page.mouse.click(box2.x + box2.width / 2, box2.y + box2.height / 2);
            const modalBtn2 = await page.waitForSelector([
              'button[aria-label="Continue to next step"]',
              'button[aria-label="Submit application"]',
              'button[aria-label="Review your application"]',
              'button[aria-label*="Next"]',
              'button[aria-label*="Continue"]',
              'button:has-text("Next")',
              'button:has-text("Submit application")',
            ].join(', '), { timeout: 5000, state: 'visible' }).catch(() => null);
            if (!modalBtn2) {
              console.log('  Modal still not open — skip\n');
              await page.screenshot({ path: path.join(__dirname, 'debug-screenshots', `nope-${jobId}.png`) });
              continue;
            }
          } else {
            console.log('  Button not visible on retry — skip\n');
            continue;
          }
        } else {
          console.log('  No Easy Apply button on retry — skip\n');
          continue;
        }
      }

      console.log('  Modal opened!');
      await page.screenshot({ path: path.join(__dirname, 'debug-screenshots', `modal-${jobId}.png`) });

      // Walk form steps
      let submitted = false;
      let stuckCount = 0;
      for (let step = 0; step < 10; step++) {
        await page.waitForTimeout(600);
        await handleFormPage(page);

        // Check success
        const bodyText = await page.evaluate(() => (document.body.innerText || '').toLowerCase()).catch(() => '');
        if (bodyText.includes('application submitted') || bodyText.includes('application was sent') || bodyText.includes('application has been submitted')) {
          console.log(`  ✓ APPLIED: ${title}`);
          applied++;
          submitted = true;
          await page.screenshot({ path: path.join(__dirname, 'debug-screenshots', `applied-${jobId}.png`) });
          break;
        }

        // Submit button
        const submitBtn = await page.$('button[aria-label="Submit application"], button:has-text("Submit application")').catch(() => null);
        if (submitBtn && await submitBtn.isVisible().catch(() => false)) {
          console.log(`  Submitting at step ${step}...`);
          await forceClick(submitBtn);
          await page.waitForTimeout(3000);
          const postBody = await page.evaluate(() => (document.body.innerText || '').toLowerCase()).catch(() => '');
          const successEl = await page.$('h2:has-text("application"), [class*="post-apply"]').catch(() => null);
          if (postBody.includes('application submitted') || postBody.includes('application was sent') || successEl) {
            console.log(`  ✓ APPLIED (confirmed): ${title}`);
          } else {
            console.log(`  ✓ APPLIED (submit clicked): ${title}`);
          }
          applied++;
          submitted = true;
          await page.screenshot({ path: path.join(__dirname, 'debug-screenshots', `applied-${jobId}.png`) });
          break;
        }

        // Next/Continue/Review button
        const nextBtnSel = [
          'button[aria-label="Continue to next step"]',
          'button[aria-label="Review your application"]',
          'button[aria-label*="Next"]',
          'button[aria-label*="Continue"]',
          'button[aria-label*="Review"]',
          'button:has-text("Next")',
          'button:has-text("Continue")',
          'button:has-text("Review")',
        ].join(', ');
        const nextBtn = await page.$(nextBtnSel).catch(() => null);

        if (nextBtn && await nextBtn.isVisible().catch(() => false)) {
          const btnLabel = await nextBtn.getAttribute('aria-label').catch(() => '') || await nextBtn.innerText().catch(() => '');
          console.log(`  Step ${step}: ${btnLabel.trim().substring(0, 30)}`);
          await forceClick(nextBtn);
          await page.waitForTimeout(1500);

          // Check for validation errors AFTER clicking Next
          const errors = await page.$$('[class*="error"]:visible, [role="alert"]:visible');
          let hasRealError = false;
          for (const err of errors) {
            const errText = await err.innerText().catch(() => '');
            if (errText.trim() && /please|required|enter|select|valid/i.test(errText)) {
              hasRealError = true;
              console.log(`  ⚠ Validation error: "${errText.trim().substring(0, 50)}"`);
            }
          }

          if (hasRealError) {
            stuckCount++;
            // Smart fix: if error says "larger than X", find the field with small value and increase it
            for (const err of errors) {
              const errText = await err.innerText().catch(() => '');
              const match = errText.match(/larger than (\d+)/i);
              if (match) {
                const minVal = parseInt(match[1]);
                // Find nearby input with value <= minVal and increase it
                const nearbyInputs = await page.$$('input:visible');
                for (const inp of nearbyInputs) {
                  try {
                    const val = await inp.inputValue().catch(() => '');
                    if (val && parseInt(val) <= minVal) {
                      const ctx = await getInputContext(inp);
                      if (/ctc|salary|compensation|expected/i.test(ctx)) {
                        await inp.fill(String(45 * 100000)); // 45 LPA in INR
                      } else {
                        await inp.fill(String(minVal + 1000));
                      }
                    }
                  } catch {}
                }
              }
            }
            if (stuckCount >= 3) {
              console.log(`  Stuck — validation errors after ${stuckCount} attempts`);
              await page.screenshot({ path: path.join(__dirname, 'debug-screenshots', `stuck-${jobId}-s${step}.png`) });
              break;
            }
            console.log(`  Retrying form fill (attempt ${stuckCount})...`);
            await handleFormPage(page);
            continue;
          }
          stuckCount = 0; // Reset on success
          continue;
        }

        // No button found
        console.log(`  No next/submit at step ${step}`);
        await page.screenshot({ path: path.join(__dirname, 'debug-screenshots', `stuck-${jobId}-step${step}.png`) });
        break;
      }

      if (!submitted) {
        console.log(`  ✗ Could not complete`);
        // Cleanup — dismiss modal
        const dismissBtn = await page.$('button[aria-label="Dismiss"], button[aria-label="Cancel"], button[aria-label="Close"]').catch(() => null);
        if (dismissBtn && await dismissBtn.isVisible().catch(() => false)) {
          await forceClick(dismissBtn);
          await page.waitForTimeout(500);
          const discardBtn = await page.$('button:has-text("Discard"), button:has-text("Yes, discard"), button[data-test-dialog-primary-btn]').catch(() => null);
          if (discardBtn && await discardBtn.isVisible().catch(() => false)) {
            await forceClick(discardBtn);
            await page.waitForTimeout(500);
          }
        }
      }

      console.log();
    } catch (err) {
      console.log(`  Error: ${err.message.substring(0, 80)}\n`);
    }
  }

  saveCookies('linkedin', await context.cookies());
  await browser.close();

  console.log('='.repeat(50));
  console.log(`RESULTS: ${applied} / ${TARGET} Easy Apply jobs applied`);
  console.log('='.repeat(50));
})();
