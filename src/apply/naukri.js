require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const { fastDelay, saveCookies } = require('../scrapers/utils');
const { loginNaukri } = require('../scrapers/naukri');
const { getJobsToApply, updateJobStatus } = require('../db/database');
const aiBrain = require('./ai-brain');
const { loadProfile, generateCoverLetter } = require('../profile');
const { launchStealthBrowser, humanDelay, smartGoto, waitForPageStable, waitForCondition, smartWaitForElement } = require('../stealth');
const captchaSolver = require('../captcha-solver');

const HEADLESS = process.env.HEADLESS !== 'false';
const APPLY_LIMIT = parseInt(process.env.APPLY_LIMIT || '40');
const MIN_SCORE = parseFloat(process.env.MIN_APPLY_SCORE || '0.50');
const PARALLEL = parseInt(process.env.NAUKRI_APPLY_PARALLEL || '3');

const _profile = loadProfile();
const PROFILE = {
  phone: _profile.phone,
  expectedCtc: _profile.expectedCtcLPA,
  noticePeriod: _profile.noticeDays,
  firstName: _profile.firstName,
  lastName: _profile.lastName,
  fullName: _profile.fullName,
  email: _profile.email,
  city: _profile.city,
  totalExperience: _profile.totalExperience,
  coverNote: process.env.COVER_NOTE || generateCoverLetter(_profile),
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

// ─── Find Naukri Apply Button ─────────────────────────────────────────────────

async function findApplyButton(page) {
  // Strategy 1: known CSS selectors (try waitForSelector with short timeout)
  const cssSelectors = [
    'button#apply-button',
    'a#apply-button',
    '[class*="apply-button"]',
    '[class*="applyButton"]',
    '[class*="apply_button"]',
    'button[type="button"][class*="pply"]',
    'a[class*="pply"]',
    '.styles_jhc__apply-btn__C2tUE',
    '[class*="apply-btn"]',
    '[class*="applyBtn"]',
    'div[class*="apply"] > button',
    'div[class*="apply"] > a',
    // Naukri updated selectors
    '#apply-button-container button',
    '.apply-button-container button',
    'button[id*="apply"]',
    'a[id*="apply"]',
    '[data-ga-track*="apply"]',
    'button[class*="chat-bot-apply"]',
    'button[class*="chatbot-apply"]',
    '.styles_jhc__cta-container__sMBSk button',
    '.naukri-apply', '.apply-cta',
    // 2025/2026 Naukri selectors
    'button[class*="styles_jhc__apply"]',
    'button[class*="apply-button"]',
    'a[class*="apply-button"]',
    'div[class*="apply"] button',
    'div[class*="cta-apply"] button',
    'div[class*="cta-apply"] a',
    '.styles_jhc__cta__naukri button',
    'button[class*="interested"]',
    'a.chatbot-apply',
    'a[title*="Apply"]',
    'button[title*="Apply"]',
  ];

  for (const sel of cssSelectors) {
    try {
      const el = await page.waitForSelector(sel, { timeout: 800, state: 'visible' });
      if (el) return el;
    } catch {}
  }

  // Strategy 2: scan all visible buttons/links by text
  const applyTexts = ['apply', 'apply now', 'quick apply', 'apply for this job', 'apply on company site', 'i am interested', 'interested'];
  const elements = await page.$$('button, a[href], div[role="button"], span[role="button"]');
  for (const el of elements) {
    try {
      if (!await el.isVisible()) continue;
      const txt = (await el.innerText()).trim().toLowerCase();
      if (applyTexts.includes(txt) || txt.startsWith('apply') || /^(i('m|\s+am)\s+interested|apply\s)/i.test(txt)) return el;
      // Also check title and aria-label attributes
      const title = (await el.getAttribute('title') || '').toLowerCase();
      const ariaLabel = (await el.getAttribute('aria-label') || '').toLowerCase();
      if (title.includes('apply') || ariaLabel.includes('apply') || ariaLabel.includes('interested')) return el;
    } catch {}
  }

  // Strategy 3: JS-based deep search (catches shadow DOM, dynamic buttons)
  const btnInfo = await page.evaluate(() => {
    const all = [...document.querySelectorAll('button, a, div[role="button"], span[role="button"]')];
    for (const el of all) {
      if (el.offsetParent === null) continue; // hidden
      const txt = (el.innerText || el.textContent || '').trim().toLowerCase();
      if (txt === 'apply' || txt === 'apply now' || txt === 'quick apply' || txt === 'i am interested') {
        // Return a unique selector
        if (el.id) return { type: 'id', value: el.id };
        // Use XPath-like position fallback
        const parent = el.parentElement;
        const siblings = parent ? [...parent.children] : [];
        const idx = siblings.indexOf(el);
        const tag = el.tagName.toLowerCase();
        return { type: 'nth', tag, parentClass: parent?.className || '', index: idx };
      }
    }
    return null;
  }).catch(() => null);

  if (btnInfo) {
    if (btnInfo.type === 'id') {
      const el = await page.$(`#${btnInfo.value}`).catch(() => null);
      if (el) return el;
    }
  }

  // Strategy 4: Wait longer for dynamically loaded apply button (Naukri loads late)
  try {
    const lateBtn = await page.waitForSelector(
      'button:has-text("Apply"), button:has-text("apply"), a:has-text("Apply Now"), button:has-text("I am interested")',
      { timeout: 3000, state: 'visible' }
    );
    if (lateBtn) return lateBtn;
  } catch {}

  return null;
}

// ─── Fill Chat Apply (Naukri conversational flow) ─────────────────────────────

async function fillChatApply(page) {
  const maxTurns = 10;
  for (let turn = 0; turn < maxTurns; turn++) {
    await humanDelay(250, 500);

    const chatInput = await page.$('input[placeholder*="Type"], textarea[placeholder*="type"], .chatbot-input, input[class*="chat"]').catch(() => null);
    const questionEl = await page.$('.chatbot-question, [class*="question"], .bot-message, [class*="botMessage"], [class*="chat-bubble"]').catch(() => null);
    const question = questionEl ? (await questionEl.innerText().catch(() => '')).toLowerCase() : '';

    if (!chatInput) {
      // Look for option buttons
      const options = await page.$$('.chat-option, [class*="option-btn"], [class*="chatOption"], button[class*="chat"]');
      if (options.length > 0) {
        let clicked = false;
        for (const opt of options) {
          const text = (await opt.innerText().catch(() => '')).toLowerCase();
          if (/yes|confirm|proceed|submit/i.test(text)) {
            await forceClick(opt); clicked = true; break;
          }
        }
        if (!clicked) await forceClick(options[0]);
        continue;
      }
      // Check for submit
      const submitBtn = await page.$('button[type="submit"], button[class*="submit"], button:has-text("Submit")').catch(() => null);
      if (submitBtn) { await forceClick(submitBtn); break; }
      break;
    }

    let answer = 'Yes';
    if (/salary|ctc|expected|compensation/i.test(question)) answer = String(PROFILE.expectedCtc);
    else if (/notice|joining|available/i.test(question)) answer = String(PROFILE.noticePeriod);
    else if (/phone|mobile|contact/i.test(question)) answer = PROFILE.phone;
    else if (/cover|note|message|introduce|about yourself/i.test(question)) answer = PROFILE.coverNote;
    else if (/experience|years/i.test(question)) answer = String(PROFILE.totalExperience);
    else if (/name/i.test(question)) answer = PROFILE.fullName;
    else if (/email/i.test(question)) answer = PROFILE.email;
    else if (/city|location/i.test(question)) answer = PROFILE.city;

    await chatInput.fill(answer);
    await chatInput.press('Enter');
  }
  console.log(`  [APPLIED via chat]`);
}

// ─── Fill Modal Apply ─────────────────────────────────────────────────────────

async function fillModalApply(page) {
  const noteField = await page.$('textarea[name*="cover"], textarea[id*="cover"], textarea[placeholder*="cover" i], textarea[placeholder*="message" i]').catch(() => null);
  if (noteField) {
    const val = await noteField.inputValue().catch(() => '');
    if (!val) await noteField.fill(PROFILE.coverNote);
  }

  const ctcField = await page.$('input[name*="ctc" i], input[id*="ctc" i], input[placeholder*="CTC" i], input[placeholder*="salary" i]').catch(() => null);
  if (ctcField) {
    const val = await ctcField.inputValue().catch(() => '');
    if (!val) await ctcField.fill(String(PROFILE.expectedCtc));
  }

  const noticeField = await page.$('input[name*="notice" i], input[id*="notice" i], input[placeholder*="notice" i]').catch(() => null);
  if (noticeField) {
    const val = await noticeField.inputValue().catch(() => '');
    if (!val) await noticeField.fill(String(PROFILE.noticePeriod));
  }

  // Submit
  const submitBtn = await page.$('button[type="submit"], button[class*="apply"], button[class*="submit"], button:has-text("Apply"), button:has-text("Submit")').catch(() => null);
  if (submitBtn) {
    await forceClick(submitBtn);
    await humanDelay(250, 500);
  }
  console.log(`  [APPLIED via modal]`);
}

// ─── Apply to a Single Naukri Job ─────────────────────────────────────────────

// Per-job timeout wrapper
function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`Timeout: ${label} exceeded ${ms}ms`)), ms)),
  ]);
}

async function applyToJob(page, job) {
  try {
    return await withTimeout(_applyToJobInner(page, job), 75000, job.title);
  } catch (err) {
    const msg = err.message || '';
    if (msg.includes('Timeout')) {
      console.log(`  [skip] Timed out: ${job.title}`);
    } else {
      console.error(`  [error] ${job.title}: ${msg.split('\n')[0]}`);
    }
    return 'error';
  } finally {
    // Close any extra tabs this job may have opened
    try {
      const pages = page.context().pages();
      for (const p of pages) {
        if (p !== page && !p.isClosed()) await p.close().catch(() => {});
      }
    } catch {}
  }
}

async function _applyToJobInner(page, job) {
  // Smart navigate — adapts to connection speed, no hardcoded timeouts
  await smartGoto(page, job.url, { maxWait: 60000 });

  // Auto-solve any CAPTCHA before proceeding
  await captchaSolver.solveCaptcha(page, { maxRetries: 2, allowHumanFallback: false });

  // Wait for Naukri SPA to render key elements (dynamic, not timeout-based)
  await smartWaitForElement(page, [
    '#apply-button', '[class*="apply-button"]', '[class*="applyButton"]',
    '.naukri-jd', '.jd-header-comp-name', '.styles_jhc__apply-btn__C2tUE',
    '.other-details', '.job-desc', 'button:has-text("Apply")',
  ], { maxWait: 12000 });

  // Scroll to trigger lazy-loaded apply button
  await page.evaluate(() => {
    const applyArea = document.querySelector('[class*="apply"], #apply-button, .styles_jhc__apply-btn__C2tUE');
    if (applyArea) applyArea.scrollIntoView({ behavior: 'instant', block: 'center' });
    else window.scrollBy(0, 300);
  }).catch(() => {});
  await waitForPageStable(page, { maxWait: 3000 });

  // Check if page is an error / 404 / empty
  const pageTitle = await page.title().catch(() => '');
  if (/404|not found|error|access denied/i.test(pageTitle)) {
    console.log(`  [skip] Page error (${pageTitle.substring(0, 30)}): ${job.title}`);
    return 'no_button';
  }

  // Check for "already applied" indicators before even looking for button
  const alreadyText = await page.evaluate(() => {
    // Check body text
    const body = document.body.innerText || '';
    if (/already applied|you have applied|application submitted|applied on/i.test(body)) return 'body';
    // Check for "Applied ✓" button (Naukri shows this when already applied)
    const btns = [...document.querySelectorAll('button, div[role="button"]')];
    for (const btn of btns) {
      const txt = (btn.innerText || '').trim();
      if (/^applied\b/i.test(txt) || /\bapplied\s*✓?$/i.test(txt)) return `btn:"${txt.substring(0, 30)}"`;
    }
    return null;
  }).catch(() => null);
  if (alreadyText) {
    console.log(`  [skip] Already applied (${alreadyText}): ${job.title}`);
    return 'already_applied';
  }

  let applyBtn = await findApplyButton(page);

  // Log what button was found and check for false positives
  if (applyBtn) {
    const btnInfo = await applyBtn.evaluate(el => ({
      tag: el.tagName, text: (el.innerText || '').trim().substring(0, 60),
      cls: (el.className || '').substring(0, 50), id: el.id || '',
    })).catch(() => ({ tag: '?', text: '?', cls: '?', id: '' }));
    console.log(`  → Found button: <${btnInfo.tag} class="${btnInfo.cls}" id="${btnInfo.id}">"${btnInfo.text}"`);

    // Check if button says "Applied" — already applied, not a real apply button
    if (/\bapplied\b/i.test(btnInfo.text)) {
      console.log(`  [skip] Already applied (button says "${btnInfo.text}"): ${job.title}`);
      return 'already_applied';
    }
  }

  // AI fallback for finding apply button
  if (!applyBtn && aiBrain.isAvailable()) {
    console.log(`  → AI: looking for apply button...`);
    const aiResult = await aiBrain.aiFindApplyButton(page);
    if (aiResult && aiResult.selector && aiResult.type !== 'none') {
      applyBtn = await page.$(aiResult.selector).catch(() => null);
      if (applyBtn) console.log(`  → AI found: "${aiResult.text}"`);
    }
  }

  if (!applyBtn) {
    // Diagnostic: comprehensive page info
    const diagInfo = await page.evaluate(() => {
      const btns = [...document.querySelectorAll('button, a[href], div[role="button"]')]
        .filter(e => e.offsetParent !== null)
        .slice(0, 15)
        .map(e => `<${e.tagName.toLowerCase()} class="${(e.className || '').substring(0, 30)}">"${(e.innerText || '').trim().substring(0, 30)}"`);
      const h1 = (document.querySelector('h1') || {}).innerText || '';
      const hasApplyText = (document.body.innerText || '').toLowerCase().includes('apply');
      return {
        url: window.location.href.substring(0, 100),
        title: document.title.substring(0, 60),
        h1: h1.substring(0, 60),
        btns,
        bodyLen: (document.body.innerText || '').length,
        hasApplyText,
      };
    }).catch(() => ({ url: '', title: '', h1: '', btns: [], bodyLen: 0, hasApplyText: false }));
    console.log(`  [skip] No Apply button: ${job.title}`);
    console.log(`    URL: ${diagInfo.url}`);
    console.log(`    Page: "${diagInfo.title}" | H1: "${diagInfo.h1}" | body: ${diagInfo.bodyLen}chars | hasApplyText: ${diagInfo.hasApplyText}`);
    if (diagInfo.btns.length > 0) console.log(`    Buttons: ${diagInfo.btns.slice(0, 6).join(' | ')}`);
    return 'no_button';
  }

  const btnText = (await applyBtn.innerText().catch(() => '')).toLowerCase();
  if (btnText.includes('already applied') || btnText.includes('applied on')) {
    console.log(`  [skip] Already applied: ${job.title}`);
    return 'already_applied';
  }

  // Click apply — intercept popup/tab if it opens an external site
  const [popup] = await Promise.all([
    page.context().waitForEvent('page', { timeout: 4000 }).catch(() => null),
    forceClick(applyBtn),
  ]);
  await waitForPageStable(page, { maxWait: 1500 });

  // Handle popup (external site opened in new tab)
  if (popup && !popup.isClosed()) {
    await popup.waitForLoadState('domcontentloaded').catch(() => {});
    const popupUrl = popup.url();
    if (popupUrl && !popupUrl.includes('naukri.com') && popupUrl.startsWith('http')) {
      console.log(`  → External tab: ${popupUrl.substring(0, 70)}`);
      const { applyExternal } = require('./external');
      try {
        return await withTimeout(applyExternal(popup, popupUrl), 60000, 'external');
      } finally {
        await popup.close().catch(() => {});
      }
    }
    await popup.close().catch(() => {});
  }

  // Check for external redirect (page navigated away from naukri)
  const currentUrl = page.url();
  if (!currentUrl.includes('naukri.com') && currentUrl.startsWith('http')) {
    console.log(`  → Redirected to external: ${currentUrl.substring(0, 70)}`);
    const { applyExternal } = require('./external');
    return await withTimeout(applyExternal(page, currentUrl), 60000, 'external');
  }

  // Chat apply flow — check for chatbot indicators
  const chatInput = await page.$([
    'input[placeholder*="Type" i]', 'textarea[placeholder*="type" i]',
    '.chatbot-input', '[class*="chatbot"] input', '[class*="chat-input"]',
    'input[class*="chat"]', '[class*="conversational"] input',
  ].join(', ')).catch(() => null);
  if (chatInput && await chatInput.isVisible().catch(() => false)) {
    await fillChatApply(page);
    return 'applied';
  }

  // Modal/overlay apply
  const modal = await page.$([
    '.apply-modal', '[class*="applyModal"]', '[class*="quick-apply"]',
    '[class*="applyPopup"]', '[class*="apply-dialog"]', '[class*="applyOverlay"]',
    '[role="dialog"][class*="apply"]', '.modal-content',
  ].join(', ')).catch(() => null);
  if (modal && await modal.isVisible().catch(() => false)) {
    await fillModalApply(page);
    return 'applied';
  }

  // Maybe the click itself triggered an instant apply (one-click apply)
  const successIndicators = [
    '[class*="success"]', '[class*="applied"]', '.apply-success',
    '[class*="thankYou"]', '[class*="thank-you"]',
    '[class*="congrat"]', '[class*="confirmation"]',
  ];
  for (const sel of successIndicators) {
    const el = await page.$(sel).catch(() => null);
    if (el && await el.isVisible().catch(() => false)) {
      console.log(`  [APPLIED] ${job.title} @ ${job.company}`);
      return 'applied';
    }
  }

  if (/applied|success|thank/i.test(currentUrl)) {
    console.log(`  [APPLIED] ${job.title} @ ${job.company}`);
    return 'applied';
  }

  // Wait a bit more and check again (some Naukri flows are async)
  await waitForPageStable(page, { maxWait: 1500 });
  const bodyText = await page.evaluate(() => document.body.innerText.substring(0, 500)).catch(() => '');
  if (/application.*sent|successfully applied|thank you for applying/i.test(bodyText)) {
    console.log(`  [APPLIED] ${job.title} @ ${job.company}`);
    return 'applied';
  }

  // Last resort: check for chat flow that appeared late
  const lateChatInput = await page.$('input[placeholder*="Type" i], textarea[placeholder*="type" i], [class*="chatbot"] input').catch(() => null);
  if (lateChatInput && await lateChatInput.isVisible().catch(() => false)) {
    await fillChatApply(page);
    return 'applied';
  }

  // AI: try to understand and handle unrecognized flow
  if (aiBrain.isAvailable()) {
    console.log(`  → AI: analyzing unrecognized flow...`);
    const aiAnalysis = await aiBrain.analyzePageForApply(page);
    if (aiAnalysis) {
      if (aiAnalysis.pageType === 'success') return 'applied';
      if (aiAnalysis.actions && aiAnalysis.actions.length > 0) {
        const aiExec = await aiBrain.executeAIActions(page, aiAnalysis);
        if (aiExec > 0) {
          console.log(`  → AI: executed ${aiExec} actions`);
          await waitForPageStable(page, { maxWait: 2000 });
          const postBody = await page.evaluate(() => document.body.innerText.substring(0, 500)).catch(() => '');
          if (/application.*sent|successfully|thank you|applied/i.test(postBody)) return 'applied';
        }
      }
    }
  }

  console.log(`  [skip] Unrecognized apply flow: ${job.title}`);
  return 'unknown_flow';
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function run() {
  const jobs = getJobsToApply({ source: 'naukri', minScore: MIN_SCORE, limit: APPLY_LIMIT });

  if (jobs.length === 0) {
    console.log('[apply:naukri] No jobs to apply — run scrape + score first.');
    return { applied: 0, skipped: 0, error: 0 };
  }

  console.log(`[apply:naukri] Found ${jobs.length} jobs to process (score ≥ ${MIN_SCORE})\n`);

  let browser, context;
  const stats = { applied: 0, skipped: 0, error: 0 };

  // Graceful shutdown
  let aborted = false;
  const abortHandler = () => { aborted = true; console.log('\n[apply:naukri] Graceful shutdown...'); };
  process.on('SIGINT', abortHandler);

  async function launchBrowser() {
    const result = await launchStealthBrowser({ headless: HEADLESS, locale: 'en-IN' });
    browser = result.browser;
    context = result.context;
    const loginPage = await context.newPage();
    await loginNaukri(loginPage);
    await loginPage.close();
    saveCookies('naukri', await context.cookies());
  }

  try {
    await launchBrowser();
  } catch (err) {
    console.error(`[apply:naukri] Failed to launch browser: ${err.message}`);
    return stats;
  }

  let consecutiveErrors = 0;

  for (let i = 0; i < jobs.length; i += PARALLEL) {
    if (aborted) break;
    const batch = jobs.slice(i, i + PARALLEL);
    console.log(`\n[apply:naukri] Batch ${Math.floor(i / PARALLEL) + 1} (${i + 1}-${Math.min(i + PARALLEL, jobs.length)}/${jobs.length})`);

    let results;
    try {
      results = await Promise.all(
        batch.map(async (job) => {
          let page;
          try {
            page = await context.newPage();
          } catch (err) {
            // Context/browser died
            return { job, result: 'error', browserDead: true };
          }
          console.log(`\n  [${(job.score * 100).toFixed(0)}%] ${job.title} @ ${job.company}`);
          try {
            const result = await applyToJob(page, job);
            return { job, result };
          } catch (err) {
            return { job, result: 'error' };
          } finally {
            try { if (page && !page.isClosed()) await page.close(); } catch {}
          }
        })
      );
    } catch (err) {
      console.error(`[apply:naukri] Batch error: ${err.message}`);
      results = batch.map(job => ({ job, result: 'error', browserDead: true }));
    }

    let batchErrors = 0;
    let needRestart = false;
    for (const { job, result, browserDead } of results) {
      if (browserDead) needRestart = true;
      if (result === 'applied') {
        updateJobStatus(job.url, 'applied'); stats.applied++;
        consecutiveErrors = 0;
      } else if (result === 'already_applied') {
        updateJobStatus(job.url, 'applied'); stats.skipped++;
        consecutiveErrors = 0;
      } else if (result === 'error') {
        updateJobStatus(job.url, 'error'); stats.error++;
        batchErrors++;
      } else {
        updateJobStatus(job.url, 'skipped'); stats.skipped++;
        consecutiveErrors = 0;
      }
    }

    consecutiveErrors = batchErrors === batch.length ? consecutiveErrors + 1 : 0;

    // Restart browser if needed
    if (needRestart) {
      console.log('  → Browser died, restarting...');
      try { await browser.close().catch(() => {}); } catch {}
      try {
        await launchBrowser();
        consecutiveErrors = 0;
        console.log('  → Browser restarted');
      } catch (restartErr) {
        console.error(`  → Restart failed: ${restartErr.message}`);
        break;
      }
    }

    if (consecutiveErrors >= 3) {
      console.error('[apply:naukri] Too many consecutive batch errors, stopping.');
      break;
    }

    // Save cookies periodically
    try { saveCookies('naukri', await context.cookies()); } catch {}

    await fastDelay();
  }

  process.removeListener('SIGINT', abortHandler);
  try { saveCookies('naukri', await context.cookies()); } catch {}
  try { await browser.close(); } catch {}

  console.log('\n─────────────────────────────');
  console.log(`[apply:naukri] Applied : ${stats.applied}`);
  console.log(`[apply:naukri] Skipped : ${stats.skipped}`);
  console.log(`[apply:naukri] Errors  : ${stats.error}`);

  return stats;
}

if (require.main === module) {
  run().catch(err => { console.error('[apply:naukri] Fatal:', err.message); process.exit(1); });
}

module.exports = { run };
