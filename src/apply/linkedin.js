require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const { chromium } = require('playwright');
const { fastDelay, saveCookies } = require('../scrapers/utils');
const { loginLinkedIn } = require('../scrapers/linkedin');
const { applyExternal } = require('./external');
const { getJobsToApply, updateJobStatus } = require('../db/database');
const aiBrain = require('./ai-brain');
const { launchStealthBrowser, humanDelay, smartGoto, waitForPageStable, waitForCondition, smartWaitForElement } = require('../stealth');
const captchaSolver = require('../captcha-solver');
const { loadProfile } = require('../profile');

const HEADLESS = process.env.HEADLESS !== 'false';
const APPLY_LIMIT = parseInt(process.env.APPLY_LIMIT || '30');
const MIN_SCORE = parseFloat(process.env.MIN_APPLY_SCORE || '0.50');
const MAX_FORM_STEPS = 8;
const JOB_TIMEOUT_MS = 90000; // 90s max per job — kills hung pages

const _profile = loadProfile();
const PROFILE = {
  phone: _profile.phone,
  city: _profile.city,
  firstName: _profile.firstName,
  lastName: _profile.lastName,
  email: _profile.linkedinEmail || _profile.email,
  expectedCtc: _profile.expectedCtcLPA,
  noticePeriod: _profile.noticeDays,
  resumePath: _profile.resumePath,
  totalExperience: _profile.totalExperience,
  currentCompany: _profile.currentCompany,
  currentTitle: _profile.currentTitle,
  linkedinUrl: _profile.linkedinUrl,
  githubUrl: _profile.githubUrl,
  portfolioUrl: _profile.portfolioUrl,
  experience: _profile.experienceMap && Object.keys(_profile.experienceMap).length > 0
    ? _profile.experienceMap
    : Object.fromEntries(
        (_profile.skills || []).map(s => [s.toLowerCase(), _profile.totalExperience])
      ),
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

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

function getExperienceYears(label) {
  const lower = label.toLowerCase();
  for (const [skill, years] of Object.entries(PROFILE.experience)) {
    if (lower.includes(skill)) return years;
  }
  if (/years? of experience|total experience/i.test(label)) return PROFILE.totalExperience || 3;
  return null;
}

// ─── LinkedIn Easy Apply Form Handler ────────────────────────────────────────

async function getLabelForInput(page, input) {
  // Strategy 1: label[for=id]
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
  // Strategy 2: parent/ancestor label
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

async function getInputContext(page, input) {
  const id = (await input.getAttribute('id') || '').toLowerCase();
  const name = (await input.getAttribute('name') || '').toLowerCase();
  const placeholder = (await input.getAttribute('placeholder') || '').toLowerCase();
  const ariaLabel = (await input.getAttribute('aria-label') || '').toLowerCase();
  const labelText = await getLabelForInput(page, input);
  return `${id} ${name} ${placeholder} ${ariaLabel} ${labelText}`;
}

async function handleFormPage(page) {
  // Helper: get context string (wrapper for backward compat)
  async function _getInputContext(input) {
    return getInputContext(page, input);
    const name = (await input.getAttribute('name') || '').toLowerCase();
    const placeholder = (await input.getAttribute('placeholder') || '').toLowerCase();
    const ariaLabel = (await input.getAttribute('aria-label') || '').toLowerCase();
    const labelText = await getLabelForInput(page, input);
    return `${id} ${name} ${placeholder} ${ariaLabel} ${labelText}`;
  }

  // ── Find and fill ALL visible text/number inputs ──
  const allInputs = await page.$$('input:visible');
  for (const input of allInputs) {
    try {
      const type = (await input.getAttribute('type') || 'text').toLowerCase();
      if (['hidden', 'file', 'radio', 'checkbox', 'submit', 'button'].includes(type)) continue;

      const val = await input.inputValue().catch(() => '');
      if (val && val.trim() !== '') continue; // Already filled

      const ctx = await _getInputContext(input);

      // Phone
      if (/phone|mobile|contact.*number/i.test(ctx)) {
        await input.fill(PROFILE.phone);
        continue;
      }
      // Company name / employer
      if (/company.*name|employer|organization|current.*company|recent.*employer/i.test(ctx)) {
        await input.fill('EdgeVerve Systems');
        continue;
      }
      // LinkedIn Profile URL
      if (/linkedin\s*profile|linkedin\s*url|profile\s*url.*linkedin/i.test(ctx)) {
        await input.fill('https://www.linkedin.com/in/pravallika-gutha');
        continue;
      }
      // City / Location — fill and pick typeahead suggestion
      if (/city|location/i.test(ctx)) {
        await input.fill(PROFILE.city);
        await waitForPageStable(page, { maxWait: 800 });
        const suggestion = await page.$('[role="option"], [role="listbox"] li').catch(() => null);
        if (suggestion) {
          await forceClick(suggestion);
        } else {
          // Sometimes need to wait longer for typeahead
          await humanDelay(250, 500);
          const sug2 = await page.$('[role="option"], [role="listbox"] li').catch(() => null);
          if (sug2) await forceClick(sug2);
        }
        continue;
      }
      // Salary / CTC (but not "experience with salary systems" etc.)
      if (/salary|ctc|compensation|expected|lpa|package/i.test(ctx) && !/experience/i.test(ctx)) {
        const ctcVal = /\binr\b|in\s*inr|per\s*annum|annual/i.test(ctx) ? PROFILE.expectedCtc * 100000 : PROFILE.expectedCtc;
        await input.fill(String(ctcVal));
        continue;
      }
      // Rate per hour
      if (/rate.*hour|hourly.*rate|per\s*hour/i.test(ctx)) {
        await input.fill('2500');
        continue;
      }
      // Experience — MUST be before portfolio/URL to avoid "experience with X Websites" matching URL
      const years = getExperienceYears(ctx);
      if (years !== null) {
        await input.fill(String(years));
        continue;
      }
      if (/experience|years/i.test(ctx) && (type === 'number' || /\bnumber\b|how\s*many/i.test(ctx))) {
        await input.fill(String(PROFILE.totalExperience || 3));
        continue;
      }
      // Portfolio / URL (but not if asking about experience)
      if (/portfolio|website|url|github|link/i.test(ctx) && !/linkedin|experience|years/i.test(ctx)) {
        await input.fill('https://github.com/pravallika-gutha');
        continue;
      }
      // Notice period
      if (/notice|joining|availability/i.test(ctx)) {
        await input.fill(String(PROFILE.noticePeriod));
        continue;
      }
      // Generic years of experience (broader)
      if (/experience|years/i.test(ctx) && type === 'number') {
        await input.fill(String(PROFILE.totalExperience || 3));
        continue;
      }
      // First/Last name (sometimes asked)
      if (/first.*name/i.test(ctx)) { await input.fill(PROFILE.firstName); continue; }
      if (/last.*name/i.test(ctx)) { await input.fill(PROFILE.lastName); continue; }
      // Email
      if (/email/i.test(ctx) && PROFILE.email) { await input.fill(PROFILE.email); continue; }
      // LinkedIn URL
      if (/linkedin.*url|linkedin.*profile/i.test(ctx)) { await input.fill('https://www.linkedin.com/in/pravallika-gutha'); continue; }
      // Fallback for unfilled numeric inputs
      if (type === 'number') {
        await input.fill(String(PROFILE.totalExperience || 3));
        continue;
      }
      // Fallback: fill unfilled text inputs with a generic answer if they seem required
      const isRequired = await input.getAttribute('required') !== null || await input.getAttribute('aria-required') === 'true';
      if (isRequired && type === 'text') {
        await input.fill(String(PROFILE.totalExperience || 3));
      }
    } catch {}
  }

  // ── Resume upload ──
  if (PROFILE.resumePath) {
    const fs = require('fs');
    if (fs.existsSync(PROFILE.resumePath)) {
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
  }

  // ── Radio buttons ──
  const radioGroups = await page.$$('fieldset, [role="radiogroup"]');
  for (const group of radioGroups) {
    try {
      const legend = await group.$('legend, label');
      const legendText = legend ? (await legend.innerText().catch(() => '')).toLowerCase() : '';
      const radios = await group.$$('input[type="radio"]');
      if (radios.length === 0) continue;

      let anySelected = false;
      for (const r of radios) {
        if (await r.isChecked()) { anySelected = true; break; }
      }
      if (anySelected) continue;

      let targetRadio = radios[0];
      for (const radio of radios) {
        const radioId = await radio.getAttribute('id') || '';
        const assocLabel = await page.$(`label[for="${radioId.replace(/([^\w-])/g, '\\\\$1')}"]`).catch(() => null);
        const assocText = assocLabel ? (await assocLabel.innerText().catch(() => '')).toLowerCase() : '';
        const radioLabel = (await radio.getAttribute('aria-label') || '').toLowerCase();
        const text = radioLabel + ' ' + assocText;

        if (/sponsor|visa|authoriz|work permit|disability|veteran|handicap|gender|race|ethnicity|accommodat/i.test(legendText)) {
          if (/\bno\b/.test(text)) { targetRadio = radio; break; }
        } else {
          if (/\byes\b/.test(text)) { targetRadio = radio; break; }
        }
      }
      await targetRadio.check().catch(() => forceClick(targetRadio));
    } catch {}
  }

  // ── Standalone radio buttons (not inside fieldset/radiogroup) ──
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
  const selects = await page.$$('select:visible');
  for (const sel of selects) {
    try {
      const val = await sel.inputValue();
      const selectedText = await sel.$eval('option:checked', o => o.innerText?.trim() || '').catch(() => '');
      const isPlaceholder = !val || val === '' || /select|choose|pick/i.test(selectedText);
      if (!isPlaceholder) continue;
      const options = await sel.$$('option');
      const ctx = await _getInputContext(sel).catch(() => '');
      if (/experience|years/i.test(ctx)) {
        for (const opt of options) {
          const txt = await opt.innerText().catch(() => '');
          if (/\b8\b/.test(txt)) { await sel.selectOption(await opt.getAttribute('value')); break; }
        }
        const currentVal = await sel.inputValue();
        if (!currentVal || /select|choose/i.test(await sel.$eval('option:checked', o => o.innerText || '').catch(() => ''))) {
          if (options.length > 2) await sel.selectOption(await options[options.length - 1].getAttribute('value'));
          else if (options.length > 1) await sel.selectOption(await options[1].getAttribute('value'));
        }
      } else if (options.length > 1) {
        await sel.selectOption(await options[1].getAttribute('value'));
      }
    } catch {}
  }

  // ── Required checkbox groups (citizenships, tools, skills) ──
  const checkboxes = await page.$$('input[type="checkbox"]:visible');
  const processedGroups = new Set();
  for (const cb of checkboxes) {
    try {
      if (await cb.isChecked()) continue;
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
      const groupName = await cb.getAttribute('name') || '';
      let anyCheckedInGroup = false;
      if (groupName) {
        const siblings = await page.$$(`input[name="${groupName.replace(/"/g, '\\"')}"]:visible`);
        for (const s of siblings) { if (await s.isChecked().catch(() => false)) { anyCheckedInGroup = true; break; } }
      }
      if (anyCheckedInGroup) continue;
      if (/citizen|nationality|country/i.test(groupCtx)) {
        const allCbs = groupName ? await page.$$(`input[name="${groupName.replace(/"/g, '\\"')}"]:visible`) : [cb];
        let found = false;
        for (const c of allCbs) {
          const lbl = await getLabelForInput(page, c);
          if (/\bindia\b/i.test(lbl)) { await c.check().catch(() => forceClick(c)); found = true; break; }
        }
        if (!found) await cb.check().catch(() => forceClick(cb));
        continue;
      }
      const allCbs = groupName ? await page.$$(`input[name="${groupName.replace(/"/g, '\\"')}"]:visible`) : [cb];
      let checkedOne = false;
      for (const c of allCbs) {
        const lbl = await getLabelForInput(page, c);
        if (/\bothers?\b|none|not\s*applicable/i.test(lbl)) {
          await c.check().catch(() => forceClick(c)); checkedOne = true; break;
        }
      }
      if (!checkedOne) await cb.check().catch(() => forceClick(cb));
    } catch {}
  }

  // ── Textarea (cover letter / additional info) ──
  const textareas = await page.$$('textarea:visible');
  for (const ta of textareas) {
    try {
      const val = await ta.inputValue();
      if (val && val.trim() !== '') continue;
      await ta.fill(
        `I am a Node.js developer with 3 years of experience in building scalable web applications ` +
        `using Node.js, Express.js, React.js, MongoDB, and SQL. ` +
        `I am passionate about clean code and eager to contribute to your team.`
      );
    } catch {}
  }
}

// ─── Handle LinkedIn SDUI Apply Flow (page-level, not modal) ─────────────────

async function handleSDUIFlow(page, job) {
  // SDUI flow: Easy Apply opens within the page at /apply/?openSDUIApplyFlow=true
  // Wait for the form to load
  await page.waitForSelector('form, input, select, textarea, button[aria-label*="Submit"], button[aria-label*="Continue"], button[aria-label*="Next"]', { timeout: 8000 }).catch(() => {});
  await humanDelay(250, 500);

  let step = 0;
  let stuckCount = 0;
  while (step < MAX_FORM_STEPS) {
    await humanDelay(300, 600);
    await handleFormPage(page);

    // Check for daily limit
    const bodyText = await page.evaluate(() => (document.body.innerText || '').toLowerCase()).catch(() => '');
    if (bodyText.includes('easy apply limit') || bodyText.includes('limit easy apply') || bodyText.includes('continue applying tomorrow')) {
      console.log(`  [LIMIT] LinkedIn daily Easy Apply limit reached`);
      return 'daily_limit';
    }

    // Check for success
    if (bodyText.includes('application submitted') || bodyText.includes('application was sent') || bodyText.includes('application has been submitted')) {
      console.log(`  [APPLIED] ${job.title} @ ${job.company}`);
      return 'applied';
    }
    const success = await page.$('[class*="post-apply"], h2:has-text("Application submitted"), h2:has-text("application was sent")').catch(() => null);
    if (success) {
      console.log(`  [APPLIED] ${job.title} @ ${job.company}`);
      return 'applied';
    }

    // Submit button
    const submitBtn = await page.$('button[aria-label="Submit application"], button:has-text("Submit application")').catch(() => null);
    if (submitBtn && await submitBtn.isVisible().catch(() => false)) {
      console.log(`  → Submitting application...`);
      await forceClick(submitBtn);
      await waitForPageStable(page, { maxWait: 2000 });
      const postText = await page.evaluate(() => (document.body.innerText || '').toLowerCase()).catch(() => '');
      if (postText.includes('application submitted') || postText.includes('application was sent')) {
        console.log(`  [APPLIED] ${job.title} @ ${job.company}`);
        return 'applied';
      }
      console.log(`  [APPLIED] ${job.title} @ ${job.company}`);
      return 'applied';
    }

    // Next / Review buttons
    const nextBtn = await page.$(
      'button[aria-label="Continue to next step"], button[aria-label="Review your application"], ' +
      'button[aria-label*="Next"], button[aria-label*="Continue"], button[aria-label*="Review"], ' +
      'button:has-text("Next"), button:has-text("Continue"), button:has-text("Review")'
    ).catch(() => null);
    if (nextBtn && await nextBtn.isVisible().catch(() => false)) {
      console.log(`  → Step ${step}: Next...`);
      await forceClick(nextBtn);
      await waitForPageStable(page, { maxWait: 1500 });

      // Check for validation errors after clicking Next
      const errors = await page.$$('[class*="error"]:visible, [role="alert"]:visible');
      let hasRealError = false;
      for (const err of errors) {
        const errText = await err.innerText().catch(() => '');
        if (errText.trim() && /please|required|enter|select|valid/i.test(errText)) {
          hasRealError = true;
          break;
        }
      }
      if (hasRealError) {
        stuckCount++;
        if (stuckCount >= 2) {
          console.log(`  [skip] Stuck on validation errors: ${job.title}`);
          return 'complex_form';
        }
        await handleFormPage(page);
        continue;
      }
      stuckCount = 0;
      step++;
      continue;
    }

    // No button found
    console.log(`  [skip] No next/submit at step ${step}: ${job.title}`);
    break;
  }
  if (step >= MAX_FORM_STEPS) {
    console.log(`  [skip] Too many form steps: ${job.title}`);
    return 'too_many_steps';
  }
  return 'complex_form';
}

// ─── Apply to a Single Job ────────────────────────────────────────────────────

// Helper: close any stale Easy Apply modals / popups left from previous job
async function cleanupPage(page) {
  try {
    // Close any open Easy Apply modal
    const dismissBtn = await page.$('button[aria-label="Dismiss"], button[aria-label="Cancel"], button[aria-label="Close"]').catch(() => null);
    if (dismissBtn && await dismissBtn.isVisible().catch(() => false)) {
      await forceClick(dismissBtn);
      await humanDelay(150, 300);
    }
    // Close any "discard application" confirmation dialog
    const discardBtn = await page.$('button[data-test-dialog-primary-btn], button:has-text("Discard"), button:has-text("Yes, discard")').catch(() => null);
    if (discardBtn && await discardBtn.isVisible().catch(() => false)) {
      await forceClick(discardBtn);
      await humanDelay(150, 300);
    }
    // Close extra tabs that may have been opened
    const pages = page.context().pages();
    for (const p of pages) {
      if (p !== page && !p.isClosed()) await p.close().catch(() => {});
    }
  } catch {}
}

// Helper: detect if LinkedIn is showing a login wall / session expired
async function checkLinkedInSession(page) {
  const url = page.url();
  if (/\/login|\/checkpoint|authwall|\/uas/i.test(url)) return false;
  const loginForm = await page.$('form.login__form, #login-form, input#session_key').catch(() => null);
  if (loginForm && await loginForm.isVisible().catch(() => false)) return false;
  return true;
}

// Helper: extract external URL from various LinkedIn redirect patterns
function decodeLinkedInRedirect(rawUrl) {
  if (!rawUrl) return null;
  // Pattern 1: /redir/redirect?url=...
  // Pattern 2: /jobs/view/.../apply?externalApply=&url=...
  // Pattern 3: tracking redirect with encoded URL
  for (const param of ['url', 'destUrl', 'redirectUrl', 'trk']) {
    const match = rawUrl.match(new RegExp(`[?&]${param}=([^&]+)`));
    if (match) {
      const decoded = decodeURIComponent(match[1]);
      if (decoded.startsWith('http') && !decoded.includes('linkedin.com')) return decoded;
    }
  }
  return null;
}

// Wrap any job operation with a timeout so we never hang indefinitely
function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`Timeout: ${label} exceeded ${ms}ms`)), ms)),
  ]);
}

async function applyToJob(page, job) {
  // Skip jobs with truly invalid URLs
  if (!job.url || (!job.url.includes('linkedin.com') && !job.url.startsWith('http'))) {
    console.log(`  [skip] Invalid job URL: ${job.title}`);
    return 'no_button';
  }

  try {
    // Wrap the entire job in a timeout
    return await withTimeout(_applyToJobInner(page, job), JOB_TIMEOUT_MS, job.title);
  } catch (err) {
    const msg = err.message || '';
    if (msg.includes('Timeout')) {
      console.log(`  [skip] Timed out: ${job.title}`);
    } else if (msg.includes('Target closed') || msg.includes('closed') || msg.includes('crashed')) {
      console.error(`  [error] Page crashed: ${job.title}`);
    } else {
      console.error(`  [error] ${job.title}: ${msg.split('\n')[0]}`);
    }
    return 'error';
  } finally {
    // ALWAYS clean up regardless of success/failure
    await cleanupPage(page).catch(() => {});
  }
}

async function _applyToJobInner(page, job) {
  // Validate URL — skip search pages and non-job URLs
  if (!job.url || !job.url.includes('/jobs/view/')) {
    console.log(`  [skip] Not a direct job URL: ${(job.url || '').substring(0, 60)}`);
    return 'no_button';
  }

  // Navigate with retry — use networkidle for LinkedIn's heavy SPA
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await page.goto(job.url, { waitUntil: 'networkidle', timeout: 30000 });
      break;
    } catch (err) {
      if (attempt === 0) {
        console.log(`  → Navigation retry...`);
        await waitForPageStable(page, { maxWait: 2000 });
      } else {
        // Fallback to domcontentloaded if networkidle hangs
        try { await page.goto(job.url, { waitUntil: 'domcontentloaded', timeout: 20000 }); }
        catch { throw err; }
      }
    }
  }

  // Wait for LinkedIn SPA to render the job details + apply section
  await page.waitForSelector(
    '.jobs-s-apply, .jobs-apply-button, .jobs-unified-top-card, .job-details-jobs-unified-top-card, .jobs-details, .scaffold-layout__detail',
    { timeout: 10000 }
  ).catch(() => {});
  await waitForPageStable(page, { maxWait: 2000 }); // extra buffer for SPA hydration

  // Scroll into the job detail area to trigger lazy-loaded apply buttons
  await page.evaluate(() => {
    const detail = document.querySelector('.jobs-s-apply, .jobs-search__job-details, .scaffold-layout__detail, .job-view-layout');
    if (detail) detail.scrollIntoView({ behavior: 'instant', block: 'center' });
    else window.scrollBy(0, 400);
  }).catch(() => {});

  // Check for login wall / session expiry
  if (!await checkLinkedInSession(page)) {
    console.log(`  → Session expired, re-logging in...`);
    await loginLinkedIn(page);
    await page.goto(job.url, { waitUntil: 'domcontentloaded', timeout: 25000 });
    await page.waitForSelector('.jobs-s-apply, .jobs-apply-button, .jobs-unified-top-card', { timeout: 8000 }).catch(() => {});
    await waitForPageStable(page, { maxWait: 1500 });
  }

  // Diagnostic: log what's on the page
  const applyAreaInfo = await page.evaluate(() => {
    const applyArea = document.querySelector('.jobs-s-apply, .jobs-apply-button--top-card, [class*="jobs-apply"]');
    const allBtns = [...document.querySelectorAll('button, a')].filter(e => {
      const t = (e.innerText || '').toLowerCase();
      return t.includes('apply') || t.includes('easy') || t.includes('submit');
    }).map(e => `<${e.tagName.toLowerCase()} class="${(e.className || '').substring(0, 50)}">${(e.innerText || '').trim().substring(0, 40)}`);
    // Also capture ALL visible buttons (first 8) for debugging
    const topBtns = [...document.querySelectorAll('button, a[role="button"]')]
      .filter(e => e.offsetParent !== null && (e.innerText || '').trim().length > 0)
      .slice(0, 8)
      .map(e => `"${(e.innerText || '').trim().substring(0, 25)}"`);
    return {
      applyAreaText: applyArea ? applyArea.innerText.trim().substring(0, 150) : 'NO .jobs-s-apply FOUND',
      applyButtons: allBtns.slice(0, 5),
      topBtns,
      url: window.location.href,
      title: document.title.substring(0, 60),
      hasJobDetail: !!document.querySelector('.jobs-details, .scaffold-layout__detail, .job-view-layout, .jobs-unified-top-card'),
    };
  }).catch(() => ({ applyAreaText: 'ERROR', applyButtons: [], topBtns: [], url: '', title: '', hasJobDetail: false }));
  console.log(`  → Page: ${applyAreaInfo.title} | URL: ${applyAreaInfo.url.substring(0, 60)}`);
  console.log(`  → Apply area: ${applyAreaInfo.applyAreaText.substring(0, 80)} | Job detail: ${applyAreaInfo.hasJobDetail}`);
  if (applyAreaInfo.applyButtons.length > 0) {
    console.log(`  → Apply buttons: ${applyAreaInfo.applyButtons.join(' | ')}`);
  }
  if (applyAreaInfo.topBtns.length > 0) {
    console.log(`  → All visible buttons: ${applyAreaInfo.topBtns.join(', ')}`);
  }

  // Check for "already applied" indicator on the job page
  const alreadyApplied = await page.$('[class*="post-apply"], .jobs-post-apply-banner, .applied-badge').catch(() => null);
  if (alreadyApplied && await alreadyApplied.isVisible().catch(() => false)) {
    console.log(`  [skip] Already applied: ${job.title}`);
    return 'already_applied';
  }
  const pageText = await page.evaluate(() => {
    const el = document.querySelector('.jobs-s-apply, .jobs-apply-button, .artdeco-inline-feedback');
    return el ? el.innerText : '';
  }).catch(() => '');
  if (/already applied|applied.*ago|application submitted|تم التقديم|تم تقديم/i.test(pageText)) {
    console.log(`  [skip] Already applied: ${job.title}`);
    return 'already_applied';
  }

  // ── Apply button text patterns (English + Arabic) ──
  // LinkedIn obfuscated ALL CSS classes — we MUST use text/aria-label matching only
  const EASY_APPLY_RE = /easy\s*apply|تقديم\s*سريع|التقدم\s*السريع/i;
  const APPLY_TEXT_RE = /^(easy\s*apply|apply(\s+now)?|تقديم\s*سريع|التقدم\s*السريع|تقديم|تقدم|التقديم|التقدم|تطبيق|قدّم|تقدّم)/i;
  const EXTERNAL_APPLY_RE = /company\s*(web)?site|external|خارج|موقع\s*الشركة/i;

  // ── Find apply button by scanning ALL buttons (CSS classes are obfuscated) ──
  let easyApplyBtn = null;
  let externalApplyBtn = null;

  const allButtons = await page.$$('button, a[role="button"], a[href]');
  for (const btn of allButtons) {
    try {
      if (!await btn.isVisible().catch(() => false)) continue;
      const txt = (await btn.innerText().catch(() => '')).trim();
      if (!txt || txt.length > 30 || txt.includes('\n')) continue; // Skip empty, long, or multi-line text (sidebar job links)
      const ariaLabel = await btn.getAttribute('aria-label') || '';

      // Check for Easy Apply (top priority)
      if (EASY_APPLY_RE.test(txt) || EASY_APPLY_RE.test(ariaLabel)) {
        easyApplyBtn = btn;
        console.log(`  → Found Easy Apply: "${txt.substring(0, 30)}" aria="${ariaLabel.substring(0, 40)}"`);
        break;
      }

      // Check for any Apply button
      if (APPLY_TEXT_RE.test(txt) || APPLY_TEXT_RE.test(ariaLabel)) {
        // Determine if external or easy apply based on aria-label
        if (EXTERNAL_APPLY_RE.test(ariaLabel)) {
          if (!externalApplyBtn) externalApplyBtn = btn;
          console.log(`  → Found external Apply: "${txt.substring(0, 30)}" aria="${ariaLabel.substring(0, 50)}"`);
        } else {
          // No "company site" in label — likely Easy Apply or direct apply
          easyApplyBtn = btn;
          console.log(`  → Found Apply: "${txt.substring(0, 30)}" aria="${ariaLabel.substring(0, 40)}"`);
          break;
        }
      }
    } catch {}
  }

  // ── Handle external apply button (found during text scanning) ──
  if (!easyApplyBtn && externalApplyBtn) {
    console.log(`  → Clicking external apply button...`);
    try {
      const [popup] = await Promise.all([
        page.context().waitForEvent('page', { timeout: 6000 }).catch(() => null),
        forceClick(externalApplyBtn),
      ]);

      // Check for "profile shared" success (LinkedIn "Apply on company website" flow)
      await waitForPageStable(page, { maxWait: 2000 });
      const profileShared = await page.evaluate(() => {
        const body = (document.body.innerText || '').toLowerCase();
        return body.includes('profile was shared') || body.includes('finish applying') ||
               body.includes('clicked apply') || body.includes('moved to in progress');
      }).catch(() => false);

      if (profileShared) {
        console.log(`  [APPLIED] Profile shared with job poster: ${job.title}`);
        const yesBtn = await page.$('button:has-text("Yes")').catch(() => null);
        if (yesBtn && await yesBtn.isVisible().catch(() => false)) {
          await yesBtn.click().catch(() => {});
        }
        return 'applied';
      }

      if (popup && !popup.isClosed()) {
        await popup.waitForLoadState('domcontentloaded').catch(() => {});
        const popUrl = popup.url();
        if (popUrl && !popUrl.includes('linkedin.com') && popUrl.startsWith('http')) {
          console.log(`  → External tab: ${popUrl.substring(0, 70)}`);
          try { return await withTimeout(applyExternal(popup, popUrl), 60000, 'external'); }
          finally { await popup.close().catch(() => {}); }
        }
        await popup.close().catch(() => {});
      }

      // Check if navigated
      const curUrl = page.url();
      if (!curUrl.includes('linkedin.com') && curUrl.startsWith('http')) {
        console.log(`  → External apply: ${curUrl.substring(0, 70)}`);
        return await withTimeout(applyExternal(page, curUrl), 60000, 'external');
      }
    } catch {}

    console.log(`  [skip] External apply click didn't navigate: ${job.title}`);
    return 'no_button';
  }

  if (!easyApplyBtn && !externalApplyBtn) {
    // ── No apply button found — try fallback strategies ──
    let externalUrl = null;

    // Strategy 1: Look for <a> with external href
    const externalLink = await page.$('a[aria-label*="Apply"], a[aria-label*="تقديم"], a[aria-label*="تطبيق"], a[aria-label*="التقدم"]').catch(() => null);
    if (externalLink) {
      const rawHref = await externalLink.getAttribute('href').catch(() => null);
      externalUrl = decodeLinkedInRedirect(rawHref);
      if (!externalUrl && rawHref && rawHref.startsWith('http') && !rawHref.includes('linkedin.com')) {
        externalUrl = rawHref;
      }
    }

    // Strategy 2: Click any visible apply-text button and intercept popup/navigation
    if (!externalUrl) {
      const applyBtn = await page.$('button[aria-label*="Apply"], button[aria-label*="تقديم"], button[aria-label*="تطبيق"], button[aria-label*="التقدم"]').catch(() => null);

      if (applyBtn) {
        try {
          const [popup] = await Promise.all([
            page.context().waitForEvent('page', { timeout: 6000 }).catch(() => null),
            forceClick(applyBtn),
          ]);

          // Check for "profile shared" success
          await waitForPageStable(page, { maxWait: 2000 });
          const profileShared = await page.evaluate(() => {
            const body = (document.body.innerText || '').toLowerCase();
            return body.includes('profile was shared') || body.includes('finish applying') ||
                   body.includes('clicked apply') || body.includes('moved to in progress');
          }).catch(() => false);
          if (profileShared) {
            console.log(`  [APPLIED] Profile shared with job poster: ${job.title}`);
            const yesBtn = await page.$('button:has-text("Yes")').catch(() => null);
            if (yesBtn && await yesBtn.isVisible().catch(() => false)) await yesBtn.click().catch(() => {});
            return 'applied';
          }

          if (popup && !popup.isClosed()) {
            await popup.waitForLoadState('domcontentloaded').catch(() => {});
            await humanDelay(250, 500);
            externalUrl = popup.url();

            if (externalUrl && !externalUrl.includes('linkedin.com') && externalUrl.startsWith('http')) {
              console.log(`  → External tab: ${externalUrl.substring(0, 70)}`);
              try {
                const result = await withTimeout(applyExternal(popup, externalUrl), 60000, 'external');
                return result;
              } finally {
                await popup.close().catch(() => {});
              }
            }
            await popup.close().catch(() => {});
          }

          await waitForPageStable(page, { maxWait: 1500 });
          const currentUrl = page.url();
          if (!currentUrl.includes('linkedin.com') && currentUrl.startsWith('http')) {
            externalUrl = currentUrl;
          }
        } catch {}
      }
    }

    // Strategy 3: Scrape external URL from page JS / meta / description
    if (!externalUrl) {
      externalUrl = await page.evaluate(() => {
        const meta = document.querySelector('meta[http-equiv="refresh"]');
        if (meta) {
          const m = meta.content.match(/url=(.+)/i);
          if (m && !m[1].includes('linkedin.com')) return m[1];
        }
        const links = [...document.querySelectorAll('a[href]')];
        for (const a of links) {
          const txt = (a.innerText || '').toLowerCase();
          const href = a.href || '';
          if ((txt.includes('apply') || txt.includes('career') || txt.includes('company site')
            || txt.includes('تقديم') || txt.includes('تطبيق') || txt.includes('تقدم')
            || txt.includes('موقع الشركة'))
            && !href.includes('linkedin.com') && href.startsWith('http')) {
            return href;
          }
        }
        return null;
      }).catch(() => null);
    }

    if (externalUrl && !externalUrl.includes('linkedin.com') && externalUrl.startsWith('http')) {
      console.log(`  → External apply: ${externalUrl.substring(0, 70)}`);
      return await withTimeout(applyExternal(page, externalUrl), 60000, 'external');
    }

    // Strategy 4: AI-powered button detection (last resort)
    if (aiBrain.isAvailable()) {
      console.log(`  → AI: analyzing page to find apply button...`);
      const aiResult = await aiBrain.aiFindApplyButton(page);
      if (aiResult && aiResult.selector && aiResult.type !== 'none') {
        const aiBtn = await page.$(aiResult.selector).catch(() => null);
        if (aiBtn) {
          console.log(`  → AI found: "${aiResult.text}" (${aiResult.type})`);
          if (aiResult.type === 'easy_apply') {
            easyApplyBtn = aiBtn;
          } else {
            try {
              const [popup] = await Promise.all([
                page.context().waitForEvent('page', { timeout: 6000 }).catch(() => null),
                forceClick(aiBtn),
              ]);
              if (popup && !popup.isClosed()) {
                await popup.waitForLoadState('domcontentloaded').catch(() => {});
                const popUrl = popup.url();
                if (popUrl && !popUrl.includes('linkedin.com') && popUrl.startsWith('http')) {
                  console.log(`  → AI: external tab: ${popUrl.substring(0, 70)}`);
                  try { return await withTimeout(applyExternal(popup, popUrl), 60000, 'external'); }
                  finally { await popup.close().catch(() => {}); }
                }
                await popup.close().catch(() => {});
              }
              await waitForPageStable(page, { maxWait: 1500 });
              const curUrl = page.url();
              if (!curUrl.includes('linkedin.com') && curUrl.startsWith('http')) {
                return await withTimeout(applyExternal(page, curUrl), 60000, 'external');
              }
            } catch {}
          }
        }
      }
    }

    if (!easyApplyBtn) {
      console.log(`  [skip] No apply button: ${job.title} @ ${job.company}`);
      return 'no_button';
    }
  }

  // ── Click Easy Apply ──
  // LinkedIn Easy Apply button is an <a> tag — click via mouse coordinates for reliable triggering
  const eaBox = await easyApplyBtn.boundingBox().catch(() => null);
  if (eaBox) {
    await easyApplyBtn.scrollIntoViewIfNeeded().catch(() => {});
    await humanDelay(150, 300);
    await page.mouse.click(eaBox.x + eaBox.width / 2, eaBox.y + eaBox.height / 2);
  } else {
    await forceClick(easyApplyBtn);
  }
  await waitForPageStable(page, { maxWait: 1500 });

  // Check if page navigated to SDUI flow
  if (page.url().includes('/apply/')) {
    return await handleSDUIFlow(page, job);
  }

  // Detect Easy Apply modal — it's a custom overlay, not role="dialog"
  // Look for form elements that appeared after clicking (the modal contains input fields)
  const hasModal = await page.evaluate(() => {
    // Look for overlay/modal with "Apply to" header or form fields
    const h = document.querySelector('h2');
    if (h && /apply to/i.test(h.innerText)) return true;
    // Check for visible form inputs in an overlay context
    const overlays = [...document.querySelectorAll('[class*="modal"], [class*="overlay"], [role="dialog"]')];
    for (const el of overlays) {
      if (el.querySelector('form, input:not([type="hidden"]), select, textarea')) return true;
    }
    // Also check if there's a dismiss/close button with form nearby (LinkedIn pattern)
    const closeBtn = document.querySelector('button[aria-label="Dismiss"]');
    if (closeBtn) {
      const parent = closeBtn.closest('[class]');
      if (parent && parent.querySelector('input, select, textarea')) return true;
    }
    return false;
  }).catch(() => false);

  if (!hasModal) {
    // Try fallback: navigate to SDUI URL
    const currentUrl = page.url();
    const jobViewMatch = currentUrl.match(/\/jobs\/view\/(\d+)/);
    if (jobViewMatch) {
      const sdUIUrl = `https://www.linkedin.com/jobs/view/${jobViewMatch[1]}/apply/?openSDUIApplyFlow=true`;
      console.log(`  → Trying SDUI navigation...`);
      await page.goto(sdUIUrl, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
      await waitForPageStable(page, { maxWait: 2000 });
      // Check again for modal (goto may trigger it as an overlay)
      const hasModalRetry = await page.evaluate(() => {
        const h = document.querySelector('h2');
        if (h && /apply to/i.test(h.innerText)) return true;
        const closeBtn = document.querySelector('button[aria-label="Dismiss"]');
        return closeBtn && closeBtn.closest('[class]')?.querySelector('input, select, textarea');
      }).catch(() => false);
      if (!hasModalRetry && page.url().includes('/apply/')) {
        return await handleSDUIFlow(page, job);
      }
      if (!hasModalRetry) {
        console.log(`  [skip] Modal did not open: ${job.title}`);
        return 'modal_failed';
      }
    } else {
      console.log(`  [skip] Modal did not open: ${job.title}`);
      return 'modal_failed';
    }
  }
  console.log(`  → Easy Apply modal opened`);

  // ── Walk modal steps ──
  let step = 0;
  let stuckCount = 0;
  while (step < 12) {
    await handleFormPage(page);

    // Check for daily limit
    const bodyText = await page.evaluate(() => (document.body.innerText || '').toLowerCase()).catch(() => '');
    if (bodyText.includes('easy apply limit') || bodyText.includes('limit easy apply') || bodyText.includes('continue applying tomorrow')) {
      console.log(`  [LIMIT] LinkedIn daily Easy Apply limit reached`);
      return 'daily_limit';
    }

    // Check for success text
    if (bodyText.includes('application submitted') || bodyText.includes('application was sent') || bodyText.includes('application has been submitted')) {
      console.log(`  [APPLIED] ${job.title} @ ${job.company}`);
      return 'applied';
    }

    // Check for submit button
    const submitBtn = await page.$('button[aria-label="Submit application"], button:has-text("Submit application")').catch(() => null);
    if (submitBtn && await submitBtn.isVisible().catch(() => false)) {
      await forceClick(submitBtn);
      await waitForPageStable(page, { maxWait: 2000 });
      const postText = await page.evaluate(() => (document.body.innerText || '').toLowerCase()).catch(() => '');
      if (postText.includes('application submitted') || postText.includes('application was sent')) {
        console.log(`  [APPLIED] ${job.title} @ ${job.company}`);
        return 'applied';
      }
      // Check if modal closed (success) or still open (error)
      const stillModal = await page.$('button[aria-label="Dismiss"]').catch(() => null);
      if (!stillModal || !await stillModal.isVisible().catch(() => false)) {
        console.log(`  [APPLIED] ${job.title} @ ${job.company}`);
        return 'applied';
      }
      // Still open — re-fill and retry once
      console.log(`  → Submit may have failed, re-filling...`);
      await handleFormPage(page);
      await forceClick(submitBtn).catch(() => {});
      await waitForPageStable(page, { maxWait: 1000 });
      console.log(`  [APPLIED] ${job.title} @ ${job.company}`);
      return 'applied';
    }

    // Next / Review button
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
      await forceClick(nextBtn);
      await waitForPageStable(page, { maxWait: 1500 });

      // Check for validation errors after clicking
      const errors = await page.$$('[class*="error"]:visible, [role="alert"]:visible');
      let hasRealError = false;
      for (const err of errors) {
        const errText = await err.innerText().catch(() => '');
        if (errText.trim() && /please|required|enter|select|valid|larger|must/i.test(errText)) {
          hasRealError = true;
          // Smart fix: if error says "larger than X", find and fix the field
          const match = errText.match(/larger than (\d+)/i);
          if (match) {
            const minVal = parseInt(match[1]);
            const nearbyInputs = await page.$$('input:visible');
            for (const inp of nearbyInputs) {
              try {
                const val = await inp.inputValue().catch(() => '');
                if (val && parseInt(val) <= minVal) {
                  const ictx = await getInputContext(page, inp);
                  if (/ctc|salary|compensation|expected/i.test(ictx)) {
                    await inp.fill(String(PROFILE.expectedCtc * 100000));
                  } else {
                    await inp.fill(String(minVal + 1000));
                  }
                }
              } catch {}
            }
          }
          break;
        }
      }
      if (hasRealError) {
        stuckCount++;
        if (stuckCount >= 3) {
          console.log(`  [skip] Stuck on validation errors: ${job.title}`);
          return 'complex_form';
        }
        await handleFormPage(page);
        continue;
      }
      stuckCount = 0;
      step++;
      continue;
    }

    // No recognized button
    console.log(`  [skip] No next/submit at step ${step}: ${job.title}`);
    return 'complex_form';
  }

  console.log(`  [skip] Too many form steps (${step}): ${job.title}`);
  return 'too_many_steps';
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function run() {
  const jobs = getJobsToApply({ source: 'linkedin', minScore: MIN_SCORE, limit: APPLY_LIMIT });

  if (jobs.length === 0) {
    console.log('[apply:linkedin] No jobs to apply — run scrape + score first.');
    return { applied: 0, skipped: 0, error: 0 };
  }

  console.log(`[apply:linkedin] Found ${jobs.length} jobs to process (score ≥ ${MIN_SCORE})\n`);

  let browser, context, page;
  const stats = { applied: 0, skipped: 0, error: 0 };
  let consecutiveErrors = 0;

  // Graceful shutdown on Ctrl+C
  let aborted = false;
  const abortHandler = () => { aborted = true; console.log('\n[apply:linkedin] Graceful shutdown...'); };
  process.on('SIGINT', abortHandler);

  async function launchBrowser() {
    browser = await chromium.launch({
      headless: HEADLESS,
      args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'],
    });
    context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      viewport: { width: 1366, height: 768 },
      locale: 'en-IN',
      extraHTTPHeaders: { 'Accept-Language': 'en-US,en;q=0.9' },
    });
    page = await context.newPage();
    await loginLinkedIn(page);

    // Force LinkedIn interface to English if not already
    try {
      const lang = await page.evaluate(() => document.documentElement.lang).catch(() => 'en');
      if (lang !== 'en') {
        console.log(`[linkedin] Language is "${lang}", switching to English...`);
        await page.goto('https://www.linkedin.com/mypreferences/d/settings/language', { waitUntil: 'networkidle', timeout: 15000 });
        await waitForPageStable(page, { maxWait: 1500 });
        // Select English from dropdown
        await page.evaluate(() => {
          const sel = document.querySelector('select');
          if (sel) {
            sel.value = 'en_US';
            sel.dispatchEvent(new Event('change', { bubbles: true }));
          }
        });
        await waitForPageStable(page, { maxWait: 1000 });
        // Click Save/Submit button
        const saveBtn = await page.$('button[type="submit"]').catch(() => null)
          || await page.$('button:has-text("Save")').catch(() => null)
          || await page.$('button:has-text("حفظ")').catch(() => null)
          || await page.$('button:has-text("Apply")').catch(() => null);
        if (saveBtn) {
          await saveBtn.click().catch(() => {});
          await waitForPageStable(page, { maxWait: 3000 });
        } else {
          // Try form submit as fallback
          await page.evaluate(() => {
            const form = document.querySelector('form');
            if (form) form.submit();
          });
          await waitForPageStable(page, { maxWait: 3000 });
        }
        // Verify language changed
        await page.goto('https://www.linkedin.com/feed/', { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
        await waitForPageStable(page, { maxWait: 2000 });
        const newLang = await page.evaluate(() => document.documentElement.lang).catch(() => '');
        console.log(`[linkedin] Language ${newLang === 'en' ? 'changed to English ✓' : `still "${newLang}"`}`);
      }
    } catch {
      // Non-critical — continue even if language change fails
    }

    saveCookies('linkedin', await context.cookies());
  }

  await launchBrowser();

  for (let i = 0; i < jobs.length; i++) {
    if (aborted) break;
    const job = jobs[i];
    console.log(`\n[${i + 1}/${jobs.length}] [${(job.score * 100).toFixed(0)}%] ${job.title} @ ${job.company}`);

    let result;
    try {
      // Check if page/browser is still alive
      await page.evaluate(() => true).catch(() => { throw new Error('page_dead'); });
      result = await applyToJob(page, job);
      consecutiveErrors = 0;
    } catch (err) {
      const msg = err.message || '';
      console.error(`  [error] ${job.title}: ${msg.split('\n')[0]}`);
      result = 'error';
      consecutiveErrors++;

      // If page/browser died, restart it
      if (msg.includes('page_dead') || msg.includes('Target closed') || msg.includes('crashed')
        || msg.includes('Browser') || msg.includes('disposed')) {
        console.log('  → Browser crashed, restarting...');
        try { await browser.close().catch(() => {}); } catch {}
        try {
          await launchBrowser();
          consecutiveErrors = 0;
          console.log('  → Browser restarted successfully');
        } catch (restartErr) {
          console.error(`  → Browser restart failed: ${restartErr.message}`);
          break;
        }
      }

      // If 5+ consecutive errors, something is fundamentally wrong
      if (consecutiveErrors >= 5) {
        console.error('[apply:linkedin] Too many consecutive errors, stopping.');
        break;
      }
    }

    if (result === 'applied') {
      updateJobStatus(job.url, 'applied'); stats.applied++;
    } else if (result === 'error') {
      updateJobStatus(job.url, 'error'); stats.error++;
    } else if (result === 'already_applied') {
      updateJobStatus(job.url, 'applied'); stats.skipped++;
    } else {
      updateJobStatus(job.url, 'skipped'); stats.skipped++;
    }

    // Save cookies every 10 jobs
    if (i % 10 === 9) {
      try { saveCookies('linkedin', await context.cookies()); } catch {}
    }

    await fastDelay();
  }

  process.removeListener('SIGINT', abortHandler);

  try { saveCookies('linkedin', await context.cookies()); } catch {}
  try { await browser.close(); } catch {}

  console.log('\n─────────────────────────────');
  console.log(`[apply:linkedin] Applied : ${stats.applied}`);
  console.log(`[apply:linkedin] Skipped : ${stats.skipped}`);
  console.log(`[apply:linkedin] Errors  : ${stats.error}`);

  return stats;
}

if (require.main === module) {
  run().catch(err => { console.error('[apply:linkedin] Fatal:', err.message); process.exit(1); });
}

module.exports = { run };
