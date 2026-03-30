/**
 * Stress Test: Apply to as many Easy Apply AND External Apply jobs as possible
 * Tracks all outcomes with detailed logging
 * Target: 100% success rate on all platforms
 */
require('dotenv').config();
const { loginLinkedIn } = require('./src/scrapers/linkedin');
const { loadCookies, saveCookies } = require('./src/scrapers/utils');
const { launchStealthBrowser, humanDelay, humanClick, smartGoto, waitForPageStable, waitForCondition, smartWaitForElement } = require('./src/stealth');
const captchaSolver = require('./src/captcha-solver');
const { loadProfile, generateCoverLetter } = require('./src/profile');
const { fillAllFields, fillWorkdayWidgets, fixValidationErrors: universalFixErrors } = require('./src/form-filler');
const { applyExternal, detectATS } = require('./src/apply/external');
const path = require('path');
const fs = require('fs');
const DIR = path.join(__dirname, 'debug-screenshots');

const PROFILE = loadProfile();
// Backward compat aliases
PROFILE.expectedCtc = PROFILE.expectedCtcLPA;
PROFILE.noticePeriod = PROFILE.noticeDays;
PROFILE.resumePath = PROFILE.resumePath;

// ─── Results tracking ───
const results = {
  applied: [],
  already_applied: [],
  not_easy_apply: [],
  modal_failed: [],
  stuck_validation: [],
  too_many_steps: [],
  error: [],
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
      for (let i = 0; i < 6 && p; i++) {
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

async function getInputContext(page, input) {
  const id = (await input.getAttribute('id') || '').toLowerCase();
  const name = (await input.getAttribute('name') || '').toLowerCase();
  const ph = (await input.getAttribute('placeholder') || '').toLowerCase();
  const aria = (await input.getAttribute('aria-label') || '').toLowerCase();
  const lbl = await getLabelForInput(page, input);
  return `${id} ${name} ${ph} ${aria} ${lbl}`;
}

async function handleFormPage(page) {
  // ── Fill ALL visible inputs ──
  for (const input of await page.$$('input:visible')) {
    try {
      const type = (await input.getAttribute('type') || 'text').toLowerCase();
      if (['hidden', 'file', 'radio', 'checkbox', 'submit', 'button', 'search'].includes(type)) continue;
      const v = await input.inputValue().catch(() => '');
      if (v?.trim()) continue;

      const ctx = await getInputContext(page, input);

      // Phone
      if (/phone|mobile|contact.*number/i.test(ctx)) { await input.fill(PROFILE.phone); continue; }
      // Company name / employer
      if (/company.*name|employer|organization|current.*company|recent.*employer/i.test(ctx)) { await input.fill('EdgeVerve Systems'); continue; }
      // LinkedIn Profile URL
      if (/linkedin\s*profile|linkedin\s*url|profile\s*url.*linkedin/i.test(ctx)) { await input.fill('https://www.linkedin.com/in/pravallika-gutha'); continue; }
      // City / Location
      if (/city|location/i.test(ctx)) {
        await input.fill(PROFILE.city);
        await page.waitForTimeout(800);
        const sug = await page.$('[role="option"], [role="listbox"] li').catch(() => null);
        if (sug) { await forceClick(sug); }
        else { await page.waitForTimeout(500); const s2 = await page.$('[role="option"], [role="listbox"] li').catch(() => null); if (s2) await forceClick(s2); }
        continue;
      }
      // Salary/CTC — detect INR vs LPA
      if (/salary|ctc|compensation|expected|lpa|package|current/i.test(ctx) && !/experience/i.test(ctx)) {
        const ctcVal = /\binr\b|in\s*inr|per\s*annum|annual|rupee/i.test(ctx) ? PROFILE.expectedCtc * 100000 : PROFILE.expectedCtc;
        await input.fill(String(ctcVal)); continue;
      }
      // Hourly rate
      if (/rate.*hour|hourly.*rate|per\s*hour/i.test(ctx)) { await input.fill('2500'); continue; }
      // Experience years — MUST be before portfolio/URL to avoid "experience with Dynamic Websites" matching URL
      if (/experience|years/i.test(ctx) && (type === 'number' || /\bnumber\b|how\s*many/i.test(ctx))) { await input.fill('3'); continue; }
      // Portfolio/URL (but not if it's asking about experience with something)
      if (/portfolio|website|url|github|link/i.test(ctx) && !/linkedin|experience|years/i.test(ctx)) { await input.fill('https://github.com/pravallika-gutha'); continue; }
      // Notice period
      if (/notice|joining|availability/i.test(ctx)) { await input.fill(String(PROFILE.noticePeriod)); continue; }
      // Experience years (broader match)
      if (/experience|years/i.test(ctx)) { await input.fill('3'); continue; }
      // Name fields
      if (/first.*name/i.test(ctx)) { await input.fill(PROFILE.firstName); continue; }
      if (/last.*name|surname/i.test(ctx)) { await input.fill(PROFILE.lastName); continue; }
      // Email
      if (/email/i.test(ctx) && PROFILE.email) { await input.fill(PROFILE.email); continue; }
      // LinkedIn URL
      if (/linkedin.*url|linkedin.*profile/i.test(ctx)) { await input.fill('https://www.linkedin.com/in/pravallika-gutha'); continue; }
      // Percentage / CGPA
      if (/percentage|cgpa|gpa|grade/i.test(ctx)) { await input.fill('75'); continue; }
      // Age
      if (/\bage\b/i.test(ctx)) { await input.fill('30'); continue; }
      // Pincode / Zip
      if (/pincode|zip|postal/i.test(ctx)) { await input.fill('500081'); continue; }
      // Fallback for number type
      if (type === 'number') { await input.fill('5'); continue; }
      // Fallback for required text
      const isReq = await input.getAttribute('required') !== null || await input.getAttribute('aria-required') === 'true';
      if (isReq) { await input.fill('3'); }
    } catch {}
  }

  // ── Resume upload ──
  if (PROFILE.resumePath && fs.existsSync(PROFILE.resumePath)) {
    for (const input of await page.$$('input[type="file"]')) {
      try {
        const accept = (await input.getAttribute('accept') || '').toLowerCase();
        if (!accept || accept.includes('pdf') || accept.includes('doc') || accept.includes('*'))
          await input.setInputFiles(PROFILE.resumePath);
      } catch {}
    }
  }

  // ── Radio buttons (fieldset groups) ──
  for (const group of await page.$$('fieldset, [role="radiogroup"]')) {
    try {
      const legend = await group.$('legend, label');
      const lt = legend ? (await legend.innerText().catch(() => '')).toLowerCase() : '';
      const radios = await group.$$('input[type="radio"]');
      if (!radios.length) continue;
      let sel = false;
      for (const r of radios) { if (await r.isChecked()) { sel = true; break; } }
      if (sel) continue;
      let target = radios[0];
      for (const r of radios) {
        const rid = await r.getAttribute('id') || '';
        const al = await page.$(`label[for="${rid.replace(/([^\w-])/g, '\\\\$1')}"]`).catch(() => null);
        const at = al ? (await al.innerText().catch(() => '')).toLowerCase() : '';
        const t = (await r.getAttribute('aria-label') || '').toLowerCase() + ' ' + at;
        if (/sponsor|visa|authoriz|work permit|disability|veteran|handicap|gender|race|ethnicity|accommodat/i.test(lt)) { if (/\bno\b/.test(t)) { target = r; break; } }
        else { if (/\byes\b/.test(t)) { target = r; break; } }
      }
      await target.check().catch(() => forceClick(target));
    } catch {}
  }

  // ── Standalone radio buttons (not inside fieldset) ──
  const allRadios = await page.$$('input[type="radio"]:visible');
  const radiosByName = {};
  for (const r of allRadios) {
    try {
      const name = await r.getAttribute('name') || await r.getAttribute('id') || 'unknown';
      if (!radiosByName[name]) radiosByName[name] = [];
      radiosByName[name].push(r);
    } catch {}
  }
  for (const [, radios] of Object.entries(radiosByName)) {
    try {
      let anyChecked = false;
      for (const r of radios) { if (await r.isChecked().catch(() => false)) { anyChecked = true; break; } }
      if (anyChecked) continue;
      let questionCtx = '';
      try {
        questionCtx = await radios[0].evaluate(el => {
          let p = el.parentElement;
          for (let i = 0; i < 8 && p; i++) {
            const legend = p.querySelector('legend, h3, h4, label, span[class*="label"]');
            if (legend && legend.innerText?.trim().length > 5) return legend.innerText.trim();
            p = p.parentElement;
          }
          return '';
        }).catch(() => '');
      } catch {}
      let target = radios[0];
      for (const r of radios) {
        const lbl = await getLabelForInput(page, r);
        const val = (await r.getAttribute('value') || '').toLowerCase();
        if (/sponsor|visa|authoriz|work permit|disability|veteran|handicap|gender|race|ethnicity|accommodat/i.test(questionCtx)) {
          if (/\bno\b/i.test(lbl) || val === 'no') { target = r; break; }
        } else {
          if (/\byes\b/i.test(lbl) || val === 'yes') { target = r; break; }
        }
      }
      await target.check().catch(() => forceClick(target));
    } catch {}
  }

  // ── Dropdowns ──
  for (const sel of await page.$$('select:visible')) {
    try {
      const v = await sel.inputValue();
      const selectedText = await sel.$eval('option:checked', o => o.innerText?.trim() || '').catch(() => '');
      const isPlaceholder = !v || v === '' || /select|choose|pick|--/i.test(selectedText);
      if (!isPlaceholder) continue;
      const opts = await sel.$$('option');
      const ctx = await getInputContext(page, sel).catch(() => '');
      if (/experience|years/i.test(ctx)) {
        let found = false;
        // Try exact match for "3" first
        for (const opt of opts) {
          const txt = await opt.innerText().catch(() => '');
          if (/\b3\b/.test(txt)) { await sel.selectOption(await opt.getAttribute('value')); found = true; break; }
        }
        // Try range that includes 3 (e.g., "2-4 years", "1-3 years", "3-5 years")
        if (!found) {
          for (const opt of opts) {
            const txt = await opt.innerText().catch(() => '');
            const rangeMatch = txt.match(/(\d+)\s*[-–]\s*(\d+)/);
            if (rangeMatch && parseInt(rangeMatch[1]) <= 3 && parseInt(rangeMatch[2]) >= 3) {
              await sel.selectOption(await opt.getAttribute('value')); found = true; break;
            }
          }
        }
        // Fallback: pick 2nd option (first non-placeholder)
        if (!found && opts.length > 1) {
          await sel.selectOption(await opts[1].getAttribute('value'));
        }
      } else if (opts.length > 1) {
        await sel.selectOption(await opts[1].getAttribute('value'));
      }
    } catch {}
  }

  // ── Required checkbox groups (e.g., "select all citizenships", "CI/CD tools", "databases") ──
  // Find groups of visible checkboxes that share a question/fieldset context
  const checkboxes = await page.$$('input[type="checkbox"]:visible');
  const processedGroups = new Set();
  for (const cb of checkboxes) {
    try {
      if (await cb.isChecked()) continue;
      // Get group context
      const groupCtx = await cb.evaluate(el => {
        let p = el.parentElement;
        for (let i = 0; i < 10 && p; i++) {
          const legend = p.querySelector('legend, h3, h4, [class*="label"], span');
          if (legend && legend.innerText?.trim().length > 10) return legend.innerText.trim();
          p = p.parentElement;
        }
        return '';
      }).catch(() => '');
      if (processedGroups.has(groupCtx)) continue;
      processedGroups.add(groupCtx);

      // Check if any checkbox in this group is already checked
      const groupName = await cb.getAttribute('name') || '';
      let anyCheckedInGroup = false;
      if (groupName) {
        const siblings = await page.$$(`input[name="${groupName.replace(/"/g, '\\"')}"]:visible`);
        for (const s of siblings) { if (await s.isChecked().catch(() => false)) { anyCheckedInGroup = true; break; } }
      }
      if (anyCheckedInGroup) continue;

      // Citizenship question — look for "India" checkbox
      if (/citizen|nationality|country/i.test(groupCtx)) {
        const allCbs = groupName ? await page.$$(`input[name="${groupName.replace(/"/g, '\\"')}"]:visible`) : [cb];
        let found = false;
        for (const c of allCbs) {
          const lbl = await getLabelForInput(page, c);
          if (/\bindia\b/i.test(lbl)) { await c.check().catch(() => forceClick(c)); found = true; break; }
        }
        if (!found) await cb.check().catch(() => forceClick(cb)); // Fallback: check first
        continue;
      }

      // Generic required checkbox group — check "Others" if available, otherwise first
      const allCbs = groupName ? await page.$$(`input[name="${groupName.replace(/"/g, '\\"')}"]:visible`) : [cb];
      let checkedOne = false;
      for (const c of allCbs) {
        const lbl = await getLabelForInput(page, c);
        if (/\bothers?\b|none|not\s*applicable/i.test(lbl)) {
          await c.check().catch(() => forceClick(c));
          checkedOne = true;
          break;
        }
      }
      if (!checkedOne) {
        // Check the first one as fallback
        await cb.check().catch(() => forceClick(cb));
      }
    } catch {}
  }

  // ── Textarea ──
  for (const ta of await page.$$('textarea:visible')) {
    try {
      const v = await ta.inputValue(); if (v?.trim()) continue;
      await ta.fill('I am a Node.js developer with 3 years of experience in building scalable web applications using Node.js, Express.js, React.js, MongoDB, and SQL. I am passionate about clean code and eager to contribute to your team.');
    } catch {}
  }
}

// ── Smart validation error fixer ──
async function fixValidationErrors(page) {
  const errors = await page.$$('[class*="error"]:visible, [role="alert"]:visible');
  let fixed = false;
  for (const err of errors) {
    try {
      const errText = await err.innerText().catch(() => '');
      if (!errText.trim()) continue;

      // "Enter a whole/decimal number larger than X"
      const largerMatch = errText.match(/larger than ([\d.]+)/i);
      if (largerMatch) {
        const minVal = parseFloat(largerMatch[1]);
        const nearbyInputs = await page.$$('input:visible');
        for (const inp of nearbyInputs) {
          const val = await inp.inputValue().catch(() => '');
          if (val && parseFloat(val) <= minVal) {
            const ctx = await getInputContext(page, inp);
            if (/ctc|salary|compensation|expected|current/i.test(ctx)) {
              await inp.fill(String(PROFILE.expectedCtc * 100000));
            } else if (/rate|hour/i.test(ctx)) {
              await inp.fill(String(Math.ceil(minVal * 1.5)));
            } else {
              await inp.fill(String(Math.ceil(minVal * 2)));
            }
            fixed = true;
          }
        }
      }

      // "Please make a selection" or "Select checkbox to proceed"
      if (/make a selection|select.*checkbox|select.*proceed/i.test(errText)) {
        // Try fixing dropdowns
        for (const sel of await page.$$('select:visible')) {
          const v = await sel.inputValue().catch(() => '');
          const selText = await sel.$eval('option:checked', o => o.innerText || '').catch(() => '');
          if (!v || /select|choose/i.test(selText)) {
            const opts = await sel.$$('option');
            if (opts.length > 1) {
              await sel.selectOption(await opts[1].getAttribute('value'));
              fixed = true;
            }
          }
        }
        // Try fixing unchecked checkbox groups
        const cbs = await page.$$('input[type="checkbox"]:visible');
        for (const cb of cbs) {
          if (await cb.isChecked().catch(() => false)) continue;
          const lbl = await getLabelForInput(page, cb);
          if (/\bothers?\b|none/i.test(lbl)) {
            await cb.check().catch(() => forceClick(cb));
            fixed = true;
            break;
          }
        }
        // If still not fixed, check the first unchecked checkbox
        if (!fixed) {
          for (const cb of cbs) {
            if (await cb.isChecked().catch(() => false)) continue;
            await cb.check().catch(() => forceClick(cb));
            fixed = true;
            break;
          }
        }
      }

      // "Enter a whole number between X and Y"
      const betweenMatch = errText.match(/between\s+([\d.]+)\s+and\s+([\d.]+)/i);
      if (betweenMatch) {
        const minVal = parseFloat(betweenMatch[1]);
        const maxVal = parseFloat(betweenMatch[2]);
        const midVal = Math.floor((minVal + maxVal) / 2) || 3;
        const nearbyInputs = await page.$$('input:visible');
        for (const inp of nearbyInputs) {
          const val = await inp.inputValue().catch(() => '');
          const numVal = parseFloat(val);
          if (val && (isNaN(numVal) || numVal < minVal || numVal > maxVal)) {
            await inp.fill(String(midVal));
            fixed = true;
          }
        }
      }

      // "Please enter a valid answer"
      if (/valid answer/i.test(errText)) {
        await handleFormPage(page);
        fixed = true;
      }
    } catch {}
  }
  return fixed;
}

(async () => {
  const { browser, context, page: _page } = await launchStealthBrowser({ headless: false });
  const cookies = loadCookies('linkedin');
  if (cookies) await context.addCookies(cookies);
  const page = _page;
  await loginLinkedIn(page);

  // ── Collect jobs from many different searches ──
  console.log('Collecting Easy Apply jobs from multiple searches...\n');
  const searches = [
    'react%20developer', 'python%20developer', 'senior%20software%20engineer',
    'API%20developer', 'cloud%20engineer', 'typescript%20developer',
    'chatbot%20developer', 'microservices', 'devops%20engineer',
    'data%20engineer', 'machine%20learning', 'frontend%20developer',
    'Node.js%20developer', 'backend%20engineer', 'fullstack%20developer',
    'java%20developer', 'golang%20developer', 'AWS%20engineer',
  ];
  const allJobIds = new Set();
  for (const kw of searches) {
    try {
      await page.goto(`https://www.linkedin.com/jobs/search/?keywords=${kw}&f_AL=true&sortBy=DD&geoId=102713980`, {
        waitUntil: 'domcontentloaded', timeout: 20000,
      });
      await page.waitForTimeout(1500);
      const ids = await page.evaluate(() => {
        const ids = new Set();
        document.querySelectorAll('a[href*="/jobs/view/"]').forEach(a => {
          const m = a.href.match(/\/jobs\/view\/(\d+)/);
          if (m) ids.add(m[1]);
        });
        return [...ids];
      });
      ids.forEach(id => allJobIds.add(id));
    } catch {}
    if (allJobIds.size >= 50) break;
  }
  const jobIds = [...allJobIds];
  console.log(`Collected ${jobIds.length} unique job IDs\n`);

  const TARGET = 50; // Try to apply to 50 jobs
  let applied = 0;
  let dailyLimitHit = false;

  const JOB_TIMEOUT_MS = 90000; // 90s max per job — kill hung jobs

  for (let i = 0; i < jobIds.length && applied < TARGET && !dailyLimitHit; i++) {
    const jobId = jobIds[i];
    const jobUrl = `https://www.linkedin.com/jobs/view/${jobId}/`;
    console.log(`\n[${i + 1}/${jobIds.length}] Job ${jobId}`);

    try {
      await page.goto(jobUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
      await humanDelay(1500, 2500);

      // Get job title
      const title = await page.$eval('h1', el => el.innerText.trim().substring(0, 60)).catch(() => 'Unknown');
      console.log(`  Title: ${title}`);

      // Check already applied
      const alreadyApplied = await page.evaluate(() => {
        const els = document.querySelectorAll('span, div, p, li');
        for (const el of els) {
          const t = (el.innerText || '').trim().toLowerCase();
          if (/^applied\s+\d+\s+(second|minute|hour|day|week|month)/i.test(t)) return true;
          if (t === 'applied' && el.offsetParent !== null) return true;
        }
        return (document.body.innerText || '').toLowerCase().includes('application submitted');
      }).catch(() => false);
      if (alreadyApplied) {
        console.log(`  → Already applied`);
        results.already_applied.push({ jobId, title });
        continue;
      }

      // Find Easy Apply button
      const eaBtn = await page.$('a:has-text("Easy Apply"), button:has-text("Easy Apply")');
      if (!eaBtn) {
        console.log(`  → Not Easy Apply`);
        results.not_easy_apply.push({ jobId, title });
        continue;
      }

      // Scroll into view + get position
      await eaBtn.scrollIntoViewIfNeeded().catch(() => {});
      await page.waitForTimeout(500);
      let box = await eaBtn.boundingBox();
      if (!box) { console.log('  → Button not visible'); results.modal_failed.push({ jobId, title, reason: 'no_bbox' }); continue; }
      if (box.y > 700 || box.y < 0) {
        await page.evaluate((y) => window.scrollTo(0, y - 300), box.y);
        await page.waitForTimeout(500);
        box = await eaBtn.boundingBox();
        if (!box) { results.modal_failed.push({ jobId, title, reason: 'no_bbox_after_scroll' }); continue; }
      }

      // Click Easy Apply — try multiple strategies
      const modalSel = [
        'button[aria-label="Continue to next step"]',
        'button[aria-label="Submit application"]',
        'button[aria-label="Review your application"]',
        'button[aria-label*="Next"]',
        'button[aria-label*="Continue"]',
        'button:has-text("Next")',
        'button:has-text("Submit application")',
      ].join(', ');
      let modalBtn = null;

      // Strategy 1: Mouse click at coordinates
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
      modalBtn = await page.waitForSelector(modalSel, { timeout: 5000, state: 'visible' }).catch(() => null);

      // Strategy 2: Playwright .click() (handles event delegation)
      if (!modalBtn) {
        console.log('  → Retry with Playwright click...');
        const eaBtn2 = await page.$('a:has-text("Easy Apply"), button:has-text("Easy Apply")');
        if (eaBtn2) {
          await eaBtn2.click({ timeout: 3000 }).catch(() => {});
          modalBtn = await page.waitForSelector(modalSel, { timeout: 5000, state: 'visible' }).catch(() => null);
        }
      }

      // Strategy 3: JavaScript click + dispatchEvent
      if (!modalBtn) {
        console.log('  → Retry with JS click...');
        await page.evaluate(() => {
          const btn = document.querySelector('a[class*="apply"], button[class*="apply"]') ||
            [...document.querySelectorAll('a, button')].find(el => /easy\s*apply/i.test(el.innerText));
          if (btn) {
            btn.click();
            btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
          }
        });
        modalBtn = await page.waitForSelector(modalSel, { timeout: 6000, state: 'visible' }).catch(() => null);
      }

      // Strategy 4: Navigate to SDUI URL directly
      if (!modalBtn) {
        console.log('  → Retry with direct SDUI navigation...');
        const sdURL = `https://www.linkedin.com/jobs/view/${jobId}/apply/?openSDUIApplyFlow=true`;
        await page.goto(sdURL, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
        await page.waitForTimeout(3000);
        modalBtn = await page.$(modalSel).catch(() => null);
        if (!modalBtn) {
          // Check if page has form elements (SDUI loaded but buttons not matching)
          const hasForm = await page.$('input:visible, select:visible, textarea:visible').catch(() => null);
          if (hasForm) modalBtn = true; // Proceed anyway
        }
      }

      if (!modalBtn) {
        console.log('  → Modal failed (all strategies)');
        await page.screenshot({ path: path.join(DIR, `nope-${jobId}.png`) });
        results.modal_failed.push({ jobId, title, reason: 'modal_not_open' });
        continue;
      }

      console.log('  → Modal opened');

      // ── Walk form steps ──
      let submitted = false;
      let stuckCount = 0;
      let sameButtonCount = 0;
      let lastBtnLabel = '';
      let step = 0;
      for (; step < 12; step++) {
        await page.waitForTimeout(600);
        await handleFormPage(page);

        // Handle "Save this application?" dialog
        const discardDialog = await page.$('button:has-text("Discard")').catch(() => null);
        if (discardDialog && await discardDialog.isVisible().catch(() => false)) {
          await discardDialog.click().catch(() => {});
          await page.waitForTimeout(1000);
        }

        // Check if modal is still open — if not, job may have redirected to external site
        const modalStillOpen = await page.$('[role="dialog"]:visible, .artdeco-modal:visible, [class*="jobs-easy-apply"]:visible').catch(() => null);
        if (!modalStillOpen && step > 0) {
          // Modal closed — check if we got redirected or if it was an external apply
          const currentUrl = page.url();
          if (currentUrl.includes('/jobs/view/')) {
            // Still on LinkedIn job page but modal gone — likely external redirect that opened in new tab or the form was submitted
            const postBody = await page.evaluate(() => (document.body.innerText || '').toLowerCase()).catch(() => '');
            if (postBody.includes('application submitted') || postBody.includes('application was sent') || postBody.includes('application has been submitted')) {
              console.log(`  ✓ APPLIED (modal closed, confirmed): ${title}`);
              applied++;
              submitted = true;
              results.applied.push({ jobId, title, steps: step });
            } else {
              // Check if a new tab opened with external ATS
              const pages = context.pages();
              const externalPage = pages.find(p => p !== page && !p.url().includes('linkedin.com'));
              if (externalPage) {
                console.log(`  → External ATS detected: ${externalPage.url().substring(0, 60)}`);
                try {
                  const extResult = await Promise.race([
                    applyExternal(externalPage, { url: externalPage.url(), title }),
                    new Promise(r => setTimeout(() => r('timeout'), 60000)),
                  ]);
                  if (extResult === 'applied') {
                    console.log(`  ✓ APPLIED (external ATS): ${title}`);
                    applied++;
                    submitted = true;
                    results.applied.push({ jobId, title, steps: step, type: 'external' });
                  } else {
                    console.log(`  ⚠ External apply result: ${extResult}`);
                    results.not_easy_apply.push({ jobId, title, reason: `external_${extResult}` });
                  }
                  await externalPage.close().catch(() => {});
                } catch (extErr) {
                  console.log(`  ⚠ External apply error: ${extErr.message.substring(0, 50)}`);
                  results.not_easy_apply.push({ jobId, title, reason: 'external_error' });
                  await externalPage.close().catch(() => {});
                }
              } else {
                // Check if LinkedIn "Apply" button opens external URL
                const applyLink = await page.$('a[class*="apply"]:visible, a:has-text("Apply on company website"):visible, a:has-text("Apply"):visible').catch(() => null);
                if (applyLink) {
                  const href = await applyLink.getAttribute('href').catch(() => '');
                  if (href && !href.includes('linkedin.com')) {
                    console.log(`  → Found external apply link: ${href.substring(0, 60)}`);
                    const extPage = await context.newPage();
                    try {
                      await extPage.goto(href, { waitUntil: 'domcontentloaded', timeout: 15000 });
                      const extResult = await Promise.race([
                        applyExternal(extPage, { url: href, title }),
                        new Promise(r => setTimeout(() => r('timeout'), 60000)),
                      ]);
                      if (extResult === 'applied') {
                        console.log(`  ✓ APPLIED (external link): ${title}`);
                        applied++;
                        submitted = true;
                        results.applied.push({ jobId, title, steps: step, type: 'external' });
                      } else {
                        console.log(`  ⚠ External result: ${extResult}`);
                        results.not_easy_apply.push({ jobId, title, reason: `external_${extResult}` });
                      }
                    } catch (e) {
                      results.not_easy_apply.push({ jobId, title, reason: 'external_error' });
                    }
                    await extPage.close().catch(() => {});
                  } else {
                    results.not_easy_apply.push({ jobId, title, reason: 'modal_closed_no_external' });
                  }
                } else {
                  results.not_easy_apply.push({ jobId, title, reason: 'modal_closed_no_external' });
                }
              }
            }
            break;
          }
        }

        // Check for daily limit
        const bodyText = await page.evaluate(() => (document.body.innerText || '').toLowerCase()).catch(() => '');
        if (bodyText.includes('easy apply limit') || bodyText.includes('limit easy apply') || bodyText.includes('continue applying tomorrow')) {
          console.log('\n⚠ LinkedIn daily Easy Apply limit reached! Stopping all jobs.');
          dailyLimitHit = true;
          submitted = false;
          step = 999; // Force exit
          break;
        }

        // Check success
        if (bodyText.includes('application submitted') || bodyText.includes('application was sent') || bodyText.includes('application has been submitted')) {
          console.log(`  ✓ APPLIED: ${title}`);
          applied++;
          submitted = true;
          results.applied.push({ jobId, title, steps: step });
          await page.screenshot({ path: path.join(DIR, `applied-${jobId}.png`) });
          break;
        }

        // Submit button
        const submitBtn = await page.$('button[aria-label="Submit application"], button:has-text("Submit application")').catch(() => null);
        if (submitBtn && await submitBtn.isVisible().catch(() => false)) {
          console.log(`  → Submitting at step ${step}...`);
          await forceClick(submitBtn);
          await page.waitForTimeout(3000);
          const postBody = await page.evaluate(() => (document.body.innerText || '').toLowerCase()).catch(() => '');
          if (postBody.includes('application submitted') || postBody.includes('application was sent')) {
            console.log(`  ✓ APPLIED (confirmed): ${title}`);
          } else {
            console.log(`  ✓ APPLIED (submit clicked): ${title}`);
          }
          applied++;
          submitted = true;
          results.applied.push({ jobId, title, steps: step });
          await page.screenshot({ path: path.join(DIR, `applied-${jobId}.png`) });
          break;
        }

        // Next/Continue/Review button
        const nextBtn = await page.$([
          'button[aria-label="Continue to next step"]',
          'button[aria-label="Review your application"]',
          'button[aria-label*="Next"]',
          'button[aria-label*="Continue"]',
          'button[aria-label*="Review"]',
          'button:has-text("Next")',
          'button:has-text("Continue")',
          'button:has-text("Review")',
        ].join(', ')).catch(() => null);

        if (nextBtn && await nextBtn.isVisible().catch(() => false)) {
          const btnLabel = (await nextBtn.getAttribute('aria-label').catch(() => '') || await nextBtn.innerText().catch(() => '')).trim();
          console.log(`  Step ${step}: ${btnLabel.substring(0, 30)}`);

          // Detect stuck loop — same button appearing too many times
          if (btnLabel === lastBtnLabel) {
            sameButtonCount++;
            if (sameButtonCount >= 2) {
              // Try scrolling the modal to reveal hidden fields and re-fill
              console.log(`  ⚠ Same button "${btnLabel.substring(0, 20)}" x${sameButtonCount} — retrying form fill...`);
              // Scroll modal content to bottom to reveal hidden fields
              await page.evaluate(() => {
                const modal = document.querySelector('[role="dialog"], .artdeco-modal, [class*="modal"]');
                if (modal) modal.scrollTop = modal.scrollHeight;
              }).catch(() => {});
              await page.waitForTimeout(500);
              await handleFormPage(page);
              await fixValidationErrors(page);
            }
            if (sameButtonCount >= 5) {
              console.log(`  ✗ Stuck — same button "${btnLabel.substring(0, 20)}" for ${sameButtonCount} steps`);
              await page.screenshot({ path: path.join(DIR, `stuck-${jobId}.png`) });
              results.stuck_validation.push({ jobId, title, errors: ['same_button_loop'], step });
              break;
            }
          } else {
            sameButtonCount = 0;
            lastBtnLabel = btnLabel;
          }

          await forceClick(nextBtn);
          await page.waitForTimeout(1500);

          // Check for validation errors
          const errors = await page.$$('[class*="error"]:visible, [role="alert"]:visible');
          let hasRealError = false;
          let errorTexts = [];
          for (const err of errors) {
            const errText = await err.innerText().catch(() => '');
            if (errText.trim() && /please|required|enter|select|valid|larger|must|decimal/i.test(errText)) {
              hasRealError = true;
              errorTexts.push(errText.trim().substring(0, 60));
            }
          }

          if (hasRealError) {
            stuckCount++;
            console.log(`  ⚠ Errors: ${errorTexts.join(' | ')}`);
            const fixed = await fixValidationErrors(page);
            if (fixed) console.log(`  → Applied smart fix`);

            if (stuckCount >= 3) {
              console.log(`  ✗ Stuck after ${stuckCount} attempts`);
              await page.screenshot({ path: path.join(DIR, `stuck-${jobId}.png`) });
              results.stuck_validation.push({ jobId, title, errors: errorTexts, step });
              break;
            }
            await handleFormPage(page);
            continue;
          }
          stuckCount = 0;
          continue;
        }

        // No button found
        console.log(`  ✗ No next/submit at step ${step}`);
        await page.screenshot({ path: path.join(DIR, `nobutton-${jobId}.png`) });
        results.stuck_validation.push({ jobId, title, errors: ['no_button'], step });
        break;
      }

      if (!submitted && step >= 12) {
        console.log(`  ✗ Too many steps`);
        results.too_many_steps.push({ jobId, title });
      }

      if (!submitted) {
        // Dismiss modal
        const dismissBtn = await page.$('button[aria-label="Dismiss"], button[aria-label="Close"]').catch(() => null);
        if (dismissBtn && await dismissBtn.isVisible().catch(() => false)) {
          await dismissBtn.click().catch(() => {});
          await page.waitForTimeout(500);
          const discardBtn = await page.$('button:has-text("Discard"), button:has-text("Yes")').catch(() => null);
          if (discardBtn && await discardBtn.isVisible().catch(() => false)) await discardBtn.click().catch(() => {});
        }
      }

    } catch (err) {
      console.log(`  ✗ Error: ${err.message.substring(0, 80)}`);
      results.error.push({ jobId, error: err.message.substring(0, 100) });
      // Dismiss any open modal on error
      const dismissBtn = await page.$('button[aria-label="Dismiss"], button[aria-label="Close"]').catch(() => null);
      if (dismissBtn && await dismissBtn.isVisible().catch(() => false)) {
        await dismissBtn.click().catch(() => {});
        await page.waitForTimeout(500);
        const discardBtn = await page.$('button:has-text("Discard")').catch(() => null);
        if (discardBtn && await discardBtn.isVisible().catch(() => false)) await discardBtn.click().catch(() => {});
      }
    }
  }

  saveCookies('linkedin', await context.cookies());
  await browser.close();

  // ── Print detailed report ──
  console.log('\n' + '='.repeat(70));
  console.log('STRESS TEST RESULTS');
  console.log('='.repeat(70));
  console.log(`\n✓ Applied:          ${results.applied.length}`);
  console.log(`  Already applied:   ${results.already_applied.length}`);
  console.log(`  Not Easy Apply:    ${results.not_easy_apply.length}`);
  console.log(`✗ Modal failed:      ${results.modal_failed.length}`);
  console.log(`✗ Stuck/validation:  ${results.stuck_validation.length}`);
  console.log(`✗ Too many steps:    ${results.too_many_steps.length}`);
  console.log(`✗ Errors:            ${results.error.length}`);

  const attempted = results.applied.length + results.stuck_validation.length + results.too_many_steps.length + results.modal_failed.length;
  const successRate = attempted > 0 ? ((results.applied.length / attempted) * 100).toFixed(1) : 'N/A';
  console.log(`\nSuccess rate: ${results.applied.length}/${attempted} = ${successRate}%`);

  if (results.stuck_validation.length > 0) {
    console.log('\n--- STUCK/VALIDATION FAILURES ---');
    for (const r of results.stuck_validation) {
      console.log(`  Job ${r.jobId}: ${r.title} | Step ${r.step} | ${r.errors.join(', ')}`);
    }
  }
  if (results.modal_failed.length > 0) {
    console.log('\n--- MODAL FAILURES ---');
    for (const r of results.modal_failed) {
      console.log(`  Job ${r.jobId}: ${r.title} | ${r.reason}`);
    }
  }
  if (results.error.length > 0) {
    console.log('\n--- ERRORS ---');
    for (const r of results.error) {
      console.log(`  Job ${r.jobId}: ${r.error}`);
    }
  }
  if (results.applied.length > 0) {
    console.log('\n--- APPLIED ---');
    for (const r of results.applied) {
      console.log(`  Job ${r.jobId}: ${r.title} (${r.steps} steps)`);
    }
  }
  console.log('\n' + '='.repeat(70));
})();
