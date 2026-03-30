require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const path = require('path');
const readline = require('readline');
const { fastDelay } = require('../scrapers/utils');
const aiBrain = require('./ai-brain');
const { loadProfile, generateCoverLetter } = require('../profile');
const { fillAllFields, fillWorkdayWidgets, fixValidationErrors, isApplicationSuccess } = require('../form-filler');
const { humanDelay, humanClick, smartGoto, waitForPageStable, waitForCondition, smartWaitForElement } = require('../stealth');
const captchaSolver = require('../captcha-solver');

// Load profile from .env (or pass overrides for multi-user)
let PROFILE = loadProfile();

const RESUME_PATH  = PROFILE.resumePath;
const EMAIL        = PROFILE.email;
const PHONE        = PROFILE.phone;
const FIRST_NAME   = PROFILE.firstName;
const LAST_NAME    = PROFILE.lastName;
const FULL_NAME    = PROFILE.fullName;
const EXPECTED_CTC = String(PROFILE.expectedCtcLPA);
const NOTICE_DAYS  = String(PROFILE.noticeDays);
const CITY         = PROFILE.city;
const LINKEDIN_URL = PROFILE.linkedinUrl || `https://www.linkedin.com/in/${PROFILE.firstName.toLowerCase()}-${PROFILE.lastName.toLowerCase()}`;
const CURRENT_CTC  = String(PROFILE.currentCtcLPA);
const PASSWORD     = PROFILE.linkedinPassword || PROFILE.naukriPassword;

const COVER = generateCoverLetter(PROFILE);

// Allow external callers to set profile for multi-user support
function setProfile(profileOverrides) {
  PROFILE = loadProfile(profileOverrides);
}

// ─── Human-in-the-Loop ────────────────────────────────────────────────────────

// Pause automation and wait for user. If they type a code (OTP), return it.
// timeoutMs: auto-resume after this long even if user doesn't press Enter (default 2 min).
async function waitForHuman(reason, timeoutMs = 120000) {
  console.log(`\n  ⚠️  HUMAN NEEDED: ${reason}`);
  console.log('  → You can either:');
  console.log('     1. Complete it in the browser, then press ENTER here');
  console.log('     2. Type the OTP/code here and it will be auto-filled in the browser');
  const userInput = await new Promise(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const timer = setTimeout(() => { rl.close(); resolve(''); }, timeoutMs);
    rl.question('  [Enter OTP/code, or press ENTER when done]: ', (answer) => {
      clearTimeout(timer);
      rl.close();
      resolve((answer || '').trim());
    });
  });
  console.log('  → Resuming automation...');
  return userInput; // return whatever the user typed (OTP code or empty)
}

// OTP input selectors — comprehensive list
const OTP_SELECTORS = [
  'input[placeholder*="OTP" i]', 'input[placeholder*="verification code" i]',
  'input[placeholder*="enter code" i]', 'input[placeholder*="code" i]',
  'input[name*="otp" i]', 'input[name*="code"][maxlength]',
  'input[id*="otp" i]', 'input[id*="verif" i]',
  'input[autocomplete="one-time-code"]',
  'input[type="tel"][maxlength="6"]', 'input[type="number"][maxlength="6"]',
  'input[type="text"][maxlength="6"]', 'input[type="text"][maxlength="4"]',
];

// Detect if the current page is showing a verification / CAPTCHA / OTP challenge.
// Returns { type, reason } or null if all clear.
async function detectVerificationNeeded(page) {
  try {
    // CAPTCHA
    const captcha = await page.$([
      'iframe[src*="recaptcha"]', 'iframe[src*="hcaptcha"]',
      '.g-recaptcha', '[data-sitekey]', '.h-captcha',
      'iframe[title*="reCAPTCHA"]', 'iframe[title*="hCaptcha"]',
      '[class*="captcha"]', '[id*="captcha"]',
    ].join(', ')).catch(() => null);
    if (captcha && await captcha.isVisible().catch(() => false)) {
      return { type: 'captcha', reason: 'CAPTCHA detected — please solve it in the browser' };
    }

    // OTP / verification code input
    const otpInput = await page.$(OTP_SELECTORS.join(', ')).catch(() => null);
    if (otpInput && await otpInput.isVisible().catch(() => false)) {
      return { type: 'otp', reason: 'OTP / verification code required — check your email/phone' };
    }

    // Email verification prompt
    const bodyText = await page.evaluate(() => document.body.innerText.substring(0, 2000)).catch(() => '');
    if (/verify your email|check your inbox|confirmation email|click the link|verification link/i.test(bodyText)) {
      return { type: 'email_verify', reason: 'Email verification required — check your inbox and click the link' };
    }

    // Phone verification
    if (/verify your phone|enter the code sent|sms code|text message/i.test(bodyText)) {
      return { type: 'otp', reason: 'Phone OTP required — enter the SMS code sent to your phone' };
    }

    // 2FA / authenticator
    if (/two.factor|2fa|authenticator app|security code/i.test(bodyText)) {
      return { type: 'otp', reason: '2FA required — enter the code from your authenticator app' };
    }

    // Sign-in wall (site requires account before applying)
    const loginWall = await page.$([
      'form[action*="login"]', 'form[action*="signin"]',
      'input[type="password"]',
    ].join(', ')).catch(() => null);
    if (loginWall && await loginWall.isVisible().catch(() => false)) {
      const url = page.url();
      if (/login|signin|sign-in|auth/i.test(url)) {
        return { type: 'login', reason: `Login required at ${url.substring(0, 60)} — sign in manually` };
      }
    }
  } catch {}
  return null;
}

// Call this at key checkpoints (after page load, after submit click, etc.)
// Auto-solves CAPTCHAs when possible; falls back to human for OTP/email verify.
async function checkAndPauseIfNeeded(page) {
  const detection = await detectVerificationNeeded(page);
  if (!detection) return false;

  // AUTO-SOLVE CAPTCHAs instead of waiting for human
  if (detection.type === 'captcha') {
    console.log(`  → Auto-solving CAPTCHA...`);
    const solved = await captchaSolver.solveCaptcha(page, { maxRetries: 3, allowHumanFallback: true });
    if (solved) {
      console.log(`  → CAPTCHA solved automatically!`);
      return true;
    }
    console.log(`  → CAPTCHA auto-solve failed, falling through to human...`);
  }

  const userInput = await waitForHuman(detection.reason);

  // If user typed an OTP code, auto-fill it in the browser
  if (userInput && /^\d{3,8}$/.test(userInput) && (detection.type === 'otp')) {
    console.log(`  → Auto-filling OTP: ${userInput}`);
    const otpInput = await page.$(OTP_SELECTORS.join(', ')).catch(() => null);
    if (otpInput) {
      try {
        await otpInput.fill('');
        await otpInput.fill(userInput);
        await humanDelay(150, 300);

        // Try to find and click submit/verify button
        const verifyBtn = await page.$([
          'button[type="submit"]', 'button:has-text("Verify")', 'button:has-text("Submit")',
          'button:has-text("Continue")', 'button:has-text("Confirm")',
          'input[type="submit"]', 'button:has-text("Next")',
          'button[class*="verify" i]', 'button[class*="submit" i]',
        ].join(', ')).catch(() => null);
        if (verifyBtn && await verifyBtn.isVisible().catch(() => false)) {
          await forceClick(verifyBtn);
          console.log('  → OTP submitted, waiting for verification...');
          await waitForPageStable(page, { maxWait: 2000 });
        } else {
          // Try pressing Enter as fallback
          await otpInput.press('Enter');
          await waitForPageStable(page, { maxWait: 2000 });
        }
      } catch (err) {
        console.log(`  → Auto-fill failed: ${err.message.split('\n')[0]}`);
      }
    }
    // Check if there are multiple OTP inputs (split OTP like _ _ _ _ _ _)
    const splitInputs = await page.$$('input[maxlength="1"]').catch(() => []);
    if (splitInputs.length >= 4 && splitInputs.length <= 8) {
      console.log(`  → Detected split OTP (${splitInputs.length} digits)`);
      for (let i = 0; i < Math.min(userInput.length, splitInputs.length); i++) {
        try {
          await splitInputs[i].fill(userInput[i]);
        } catch {}
      }
      await humanDelay(150, 300);
      // Auto-submit
      const verifyBtn = await page.$('button[type="submit"], button:has-text("Verify"), button:has-text("Submit")').catch(() => null);
      if (verifyBtn) await forceClick(verifyBtn);
      await waitForPageStable(page, { maxWait: 2000 });
    }
  }

  await humanDelay(250, 500);
  return true; // human was needed
}

// ─── ATS Detection ────────────────────────────────────────────────────────────
function detectATS(url) {
  if (/greenhouse\.io/i.test(url))                       return 'greenhouse';
  if (/gh_jid=/i.test(url))                              return 'greenhouse-embed';
  if (/lever\.co/i.test(url))                            return 'lever';
  if (/myworkdayjobs\.com|workday\.com/i.test(url))      return 'workday';
  if (/smartrecruiters\.com/i.test(url))                 return 'smartrecruiters';
  if (/icims\.com/i.test(url))                           return 'icims';
  if (/taleo\.net/i.test(url))                           return 'taleo';
  if (/bamboohr\.com/i.test(url))                        return 'bamboohr';
  if (/ashbyhq\.com/i.test(url))                         return 'ashby';
  if (/jobvite\.com/i.test(url))                         return 'jobvite';
  if (/recruitee\.com/i.test(url))                       return 'recruitee';
  if (/breezy\.hr/i.test(url))                           return 'breezy';
  if (/weekday\.works|geektrust\.in/i.test(url))         return 'weekday';
  if (/jobs\.deel\.com/i.test(url))                      return 'deel';
  if (/platform\.uplers\.com/i.test(url))                return 'uplers';
  if (/wellfound\.com|angel\.co/i.test(url))             return 'wellfound';
  if (/apply\.workable\.com/i.test(url))                 return 'workable';
  if (/app\.dover\.com/i.test(url))                      return 'dover';
  if (/ultipro\.com|ultipro\.ca|n\d+\.ultipro/i.test(url)) return 'ultipro';
  if (/successfactors\.com|sapsf\.com/i.test(url))       return 'successfactors';
  if (/oraclecloud\.com.*recruiting/i.test(url))         return 'oracle';
  if (/careers\.jobsoid\.com/i.test(url))                return 'jobsoid';
  if (/contacthr\.com/i.test(url))                       return 'contacthr';
  if (/brassring\.com|kenexa\.com/i.test(url))           return 'brassring';
  if (/applytojob\.com/i.test(url))                      return 'applytojob';
  if (/rippling\.com\/jobs/i.test(url))                  return 'rippling';
  if (/jobs\.smartsearch\.ai/i.test(url))                return 'smartsearch';
  if (/recruitcrm\.io/i.test(url))                       return 'recruitcrm';
  if (/hirehive\.com/i.test(url))                        return 'hirehive';
  if (/freshteam\.com/i.test(url))                       return 'freshteam';
  if (/zohorecruit\.com/i.test(url))                     return 'zoho';
  return 'generic';
}

// ─── Core Helpers ─────────────────────────────────────────────────────────────

async function forceClick(el) {
  if (!el) return false;
  try {
    await el.scrollIntoViewIfNeeded().catch(() => {});
    await el.click({ timeout: 4000 }).catch(async () => {
      await el.click({ force: true, timeout: 4000 }).catch(async () => {
        await el.evaluate(e => e.click());
      });
    });
    return true;
  } catch { return false; }
}

async function safeFill(el, value) {
  if (!el) return;
  try {
    await el.scrollIntoViewIfNeeded().catch(() => {});
    await el.fill(String(value));
  } catch {
    try { await el.type(String(value), { delay: 20 }); } catch {}
  }
}

// CSS.escape polyfill for Node.js context (not available outside browser)
function cssEscape(id) {
  if (!id) return '';
  return id.replace(/([.[\]:"'#(){}!@$%^&*+|~`<>=?,;/\\])/g, '\\$1')
           .replace(/^(\d)/, '\\3$1 ');
}

// Wait for page to settle after submit, then check success
async function waitForSuccess(page, timeoutMs = 3000) {
  await Promise.race([
    page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: timeoutMs }).catch(() => {}),
    page.waitForTimeout(timeoutMs),
  ]);
  return isSuccessPage(page);
}

async function uploadResume(page) {
  const fs = require('fs');
  if (!fs.existsSync(RESUME_PATH)) {
    console.log('    → Resume not found:', RESUME_PATH);
    return false;
  }
  // Try all file inputs
  const fileInputs = await page.$$('input[type="file"]');
  for (const input of fileInputs) {
    try {
      const accept = (await input.getAttribute('accept') || '').toLowerCase();
      const name   = (await input.getAttribute('name') || '').toLowerCase();
      const id     = (await input.getAttribute('id') || '').toLowerCase();
      const isResume = !accept || accept.includes('pdf') || accept.includes('doc') || accept.includes('*');
      const notImage = !accept.includes('image') && !name.includes('photo') && !name.includes('image');
      if (isResume && notImage) {
        await input.setInputFiles(RESUME_PATH);
        await humanDelay(250, 500);
        console.log('    → Resume uploaded');
        return true;
      }
    } catch {}
  }
  // Fallback: try dropzone
  const dropzone = await page.$('[class*="resume"], [class*="upload"], [data-testid*="resume"]').catch(() => null);
  if (dropzone) {
    const hiddenInput = await dropzone.$('input[type="file"]').catch(() => null);
    if (hiddenInput) {
      await hiddenInput.setInputFiles(RESUME_PATH).catch(() => {});
      await humanDelay(250, 500);
      console.log('    → Resume uploaded (dropzone)');
      return true;
    }
  }
  return false;
}

async function dismissCookieConsent(page) {
  const selectors = [
    '#onetrust-accept-btn-handler', '#accept-cookie-consent', '.cookie-accept',
    '[data-testid="cookie-accept"]', '[id*="cookie"] button',
    'button:has-text("Accept all")', 'button:has-text("Accept All")',
    'button:has-text("Accept cookies")', 'button:has-text("Accept")',
    'button:has-text("Agree")', 'button:has-text("Allow all")',
    'button:has-text("I agree")', 'button:has-text("Got it")',
    '[aria-label*="Accept"]', '[aria-label*="accept cookies"]',
    'button.cc-btn.cc-allow', '#cookieConsentButton',
  ];
  for (const sel of selectors) {
    try {
      const btn = await page.$(sel);
      if (btn && await btn.isVisible()) {
        await forceClick(btn);
        await humanDelay(150, 300);
        return true;
      }
    } catch {}
  }
  return false;
}

async function isSuccessPage(page) {
  try {
    const url = page.url();
    if (/thank[-_]?you|confirmation|applied|submitted|success|application[-_]?complete/i.test(url)) return true;
    if (/thank_you=true|submitted=true/i.test(url)) return true;
    const bodyText = await page.evaluate(() => document.body.innerText).catch(() => '');
    if (/thank you for (applying|your application|submitting|your interest)/i.test(bodyText)) return true;
    if (/application (has been|was|is) (submitted|received|sent|complete|processed)/i.test(bodyText)) return true;
    if (/successfully (applied|submitted|sent|received)/i.test(bodyText)) return true;
    if (/we('ve| have) received your (application|resume|cv)/i.test(bodyText)) return true;
    if (/you('ve| have) (applied|submitted|successfully applied)/i.test(bodyText)) return true;
    if (/your application is (complete|under review|being reviewed)/i.test(bodyText)) return true;
    if (/application complete|we'll be in touch|keep you (posted|updated)/i.test(bodyText)) return true;
    if (/hiring team will (review|contact|reach out)/i.test(bodyText)) return true;
    if (/congratulations.*appli/i.test(bodyText)) return true;
    // Check for modal / success overlay
    const successEl = await page.$([
      '[class*="success"]', '[class*="confirmation"]',
      '[class*="thank-you"]', '[class*="thankYou"]',
      '[class*="applied"]', '[data-testid*="success"]',
      '.success-message', '.confirmation-message',
    ].join(', ')).catch(() => null);
    if (successEl && await successEl.isVisible().catch(() => false)) {
      const txt = (await successEl.innerText().catch(() => '')).toLowerCase();
      if (txt.includes('thank') || txt.includes('submit') || txt.includes('receiv') || txt.includes('appli')) return true;
    }
  } catch {}
  return false;
}

// ─── Label-based field finder ─────────────────────────────────────────────────
async function findFieldByLabel(page, labelRegex) {
  const labels = await page.$$('label');
  for (const label of labels) {
    try {
      const text = await label.innerText();
      if (!labelRegex.test(text)) continue;
      const forAttr = await label.getAttribute('for');
      if (forAttr) {
        const escaped = forAttr.replace(/([.[\]:"'#])/g, '\\$1');
        const el = await page.$(`#${escaped}`).catch(() => null)
          || await page.$(`[name="${forAttr}"]`).catch(() => null);
        if (el) return el;
      }
      const sibling = await label.evaluateHandle(el => {
        const parent = el.parentElement;
        return parent && parent.querySelector('input, select, textarea');
      }).catch(() => null);
      if (sibling && sibling.asElement()) return sibling.asElement();
    } catch {}
  }
  return null;
}

// ─── PAGE SCANNER ENGINE ──────────────────────────────────────────────────────
// Scans the ENTIRE visible page, finds all form fields, extracts context, and
// makes intelligent decisions about how to fill each one.

async function scanPageFields(page) {
  try { await page.evaluate(() => true); } catch { return []; } // page dead check
  return await page.evaluate(() => {
    const fields = [];
    const seen = new Set();

    function getContext(el) {
      // Gather ALL contextual clues for this element
      const id = el.id || '';
      const name = el.name || '';
      const placeholder = el.placeholder || '';
      const ariaLabel = el.getAttribute('aria-label') || '';
      const autoId = el.getAttribute('data-automation-id') || '';
      const testId = el.getAttribute('data-testid') || '';
      const type = el.type || '';
      const tag = el.tagName.toLowerCase();
      const required = el.required || el.getAttribute('aria-required') === 'true';

      // Find label via for=, aria-labelledby, or DOM proximity
      let labelText = '';
      if (el.id) {
        const lbl = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
        if (lbl) labelText = lbl.innerText.trim();
      }
      if (!labelText && el.getAttribute('aria-labelledby')) {
        const lblEl = document.getElementById(el.getAttribute('aria-labelledby'));
        if (lblEl) labelText = lblEl.innerText.trim();
      }
      if (!labelText) {
        // Walk up to find label in parent/grandparent/great-grandparent
        let parent = el.parentElement;
        for (let i = 0; i < 4 && parent; i++) {
          const lbl = parent.querySelector('label, legend, [class*="label" i], [class*="Label"]');
          if (lbl && lbl.innerText.trim()) { labelText = lbl.innerText.trim(); break; }
          // Check for header/strong text nearby
          const hdr = parent.querySelector('h1, h2, h3, h4, h5, h6, strong, b, p');
          if (hdr && hdr.innerText.trim().length < 100) { labelText = hdr.innerText.trim(); break; }
          parent = parent.parentElement;
        }
      }
      // Also check preceding sibling text
      if (!labelText) {
        const prev = el.previousElementSibling;
        if (prev && prev.innerText && prev.innerText.trim().length < 100) {
          labelText = prev.innerText.trim();
        }
      }

      // For selects, get available options
      let options = [];
      if (tag === 'select') {
        options = Array.from(el.querySelectorAll('option')).map(o => ({
          value: o.value, text: o.textContent.trim()
        }));
      }

      // Current value
      const currentValue = el.value || '';
      // Include elements in DOM even if below the fold — don't skip by offsetParent
      // Only skip truly hidden elements (display:none or hidden attribute)
      const style = window.getComputedStyle(el);
      const isVisible = style.display !== 'none' && style.visibility !== 'hidden'
        && !el.hidden && el.offsetWidth > 0;
      const isDisabled = el.disabled || el.readOnly;

      return {
        tag, type, id, name, placeholder, ariaLabel, autoId, testId,
        labelText, required, options, currentValue, isVisible, isDisabled,
        // Build a combined context string for matching
        context: [labelText, placeholder, ariaLabel, name, id, autoId].join(' ').toLowerCase()
      };
    }

    // Scan all inputs, selects, textareas
    const elements = document.querySelectorAll([
      'input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="image"])',
      'select', 'textarea',
    ].join(', '));
    for (const el of elements) {
      const info = getContext(el);
      if (!info.isVisible || info.isDisabled) continue;
      const key = info.id || info.name || `${info.tag}_${fields.length}`;
      if (seen.has(key)) continue;
      seen.add(key);
      fields.push(info);
    }

    // Also scan for custom widgets: Workday comboboxes, listbox triggers, etc.
    const customWidgets = document.querySelectorAll([
      '[data-automation-id][role="combobox"]',
      '[data-automation-id][role="listbox"]',
      '[data-automation-id] input[role="combobox"]',
      '[role="combobox"]:not(select)',
      'button[aria-haspopup="listbox"]',
      '[data-automation-id][role="spinbutton"]',
    ].join(', '));
    for (const el of customWidgets) {
      const info = getContext(el);
      if (!info.isVisible) continue;
      info.isCustomWidget = true;
      info.role = el.getAttribute('role') || '';
      const key = `widget_${info.id || info.autoId || fields.length}`;
      if (seen.has(key)) continue;
      seen.add(key);
      fields.push(info);
    }

    // Scan for unchecked checkboxes (consent, privacy, etc.)
    const checkboxes = document.querySelectorAll('input[type="checkbox"]');
    for (const cb of checkboxes) {
      if (cb.offsetParent === null || cb.checked) continue;
      const info = getContext(cb);
      info.isCheckbox = true;
      fields.push(info);
    }

    // Scan for radio button groups that have no selection
    const radioGroups = {};
    document.querySelectorAll('input[type="radio"]').forEach(r => {
      const group = r.name || r.id;
      if (!radioGroups[group]) radioGroups[group] = [];
      radioGroups[group].push(r);
    });
    for (const [groupName, radios] of Object.entries(radioGroups)) {
      if (radios.some(r => r.checked)) continue; // already answered
      const first = radios[0];
      if (first.offsetParent === null) continue;
      const info = getContext(first);
      info.isRadioGroup = true;
      info.radioOptions = radios.map(r => ({
        value: r.value, label: (r.parentElement?.innerText || r.value).trim()
      }));
      fields.push(info);
    }

    return fields;
  }).catch(() => []);
}

// ─── INTELLIGENT FIELD FILLER ─────────────────────────────────────────────────
// Takes scan results and fills every field intelligently based on context.

const ANSWER_MAP = [
  // Identity
  { match: /first[\s_-]*name/i,                              value: () => FIRST_NAME },
  { match: /last[\s_-]*name|surname|family[\s_-]*name/i,     value: () => LAST_NAME },
  { match: /full[\s_-]*name|^name$|your[\s_-]*name|candidate[\s_-]*name/i, value: () => FULL_NAME },
  { match: /email/i,                                          value: () => EMAIL },
  { match: /phone|mobile|contact[\s_-]*no|telephone|cell/i,  value: () => PHONE },
  { match: /linkedin/i,                                       value: () => LINKEDIN_URL },
  { match: /portfolio|website|personal[\s_-]*url|github|blog/i, value: () => LINKEDIN_URL },
  // Location
  { match: /city|location|where[\s_-]*are|address|region|state|country/i, value: () => `${CITY}, India` },
  { match: /zip|postal|pin[\s_-]*code/i,                      value: () => '500081' },
  // Compensation & notice
  { match: /expected[\s_-]*(ctc|salary|comp)|desired[\s_-]*(salary|comp|ctc)/i, value: () => `${EXPECTED_CTC} LPA` },
  { match: /current[\s_-]*(ctc|salary|comp)|present[\s_-]*(salary|ctc)/i,       value: () => `${CURRENT_CTC} LPA` },
  { match: /notice[\s_-]*(period|days|time)|serving[\s_-]*notice/i,             value: () => `${NOTICE_DAYS} days` },
  // Experience
  { match: /years?[\s_-]*(of[\s_-]*)?experience|experience[\s_-]*(in[\s_-]*)?years|total[\s_-]*experience/i, value: () => '8' },
  { match: /relevant[\s_-]*experience/i,                       value: () => '8' },
  // Employment
  { match: /employer|current[\s_-]*company|organization|where[\s_-]*do[\s_-]*you[\s_-]*work/i, value: () => 'Self Employed' },
  { match: /job[\s_-]*title|current[\s_-]*title|designation/i, value: () => 'Senior Software Engineer' },
  // Source
  { match: /source|how[\s_-]*did[\s_-]*you|hear[\s_-]*about|referr|where[\s_-]*did[\s_-]*you[\s_-]*find/i, value: () => 'LinkedIn' },
  // Salary catch-all
  { match: /salary|ctc|compensation|pay[\s_-]*expect/i,        value: () => `${EXPECTED_CTC} LPA` },
  // Cover / message
  { match: /cover[\s_-]*letter|message|introduction|about[\s_-]*you|additional[\s_-]*info|why[\s_-]*(should|do[\s_-]*you)|tell[\s_-]*us/i, value: () => COVER },
];

// Answers for select/radio fields based on context
const SELECT_ANSWER_MAP = [
  { match: /visa|sponsor/i,                    prefer: /no|not[\s_-]*required|don't[\s_-]*require/i },
  { match: /authoriz|eligible|right[\s_-]*to[\s_-]*work|legally[\s_-]*permitted|work[\s_-]*permit/i, prefer: /yes/i },
  { match: /notice|period/i,                   prefer: /30|one[\s_-]*month|less[\s_-]*than|immediately|1[\s_-]*month/i },
  { match: /source|hear|find|referral|how[\s_-]*did/i, prefer: /linkedin/i },
  { match: /gender/i,                          prefer: /prefer[\s_-]*not|decline|no[\s_-]*answer|rather[\s_-]*not/i },
  { match: /race|ethnicity|veteran|disability/i, prefer: /prefer[\s_-]*not|decline|no[\s_-]*answer|rather[\s_-]*not/i },
  { match: /privacy|acknowledge|consent|agree|terms|gdpr/i, prefer: /yes|agree|accept|consent|acknowledge/i },
  { match: /ai|machine[\s_-]*learning|familiarity/i, prefer: /expert|advanced|proficient|5|senior/i },
  { match: /proficiency|skill[\s_-]*level|expertise/i, prefer: /expert|advanced|proficient|senior/i },
  { match: /education|degree|qualification/i,   prefer: /bachelor|b\.?tech|b\.?e\.?|under[\s_-]*grad/i },
  { match: /relocat/i,                          prefer: /no|not[\s_-]*willing|remote/i },
  { match: /remote|hybrid|on[\s_-]*site|work[\s_-]*mode/i, prefer: /remote|hybrid/i },
  { match: /available|start[\s_-]*date|when[\s_-]*can/i, prefer: /immediately|30[\s_-]*days|1[\s_-]*month|asap/i },
  { match: /phone[\s_-]*device[\s_-]*type|phone[\s_-]*type|device[\s_-]*type/i, prefer: /mobile|cell/i },
  { match: /country[\s_-]*code|country[\s_-]*phone|phone[\s_-]*country/i, prefer: /india|\+91|91/i },
  { match: /country|nationality/i, prefer: /india/i },
];

async function fillScannedFields(page, fields) {
  if (!fields || !Array.isArray(fields)) return 0;
  let filledCount = 0;
  for (const field of fields) {
    try {
      if (!field) continue;
      const ctx = field.context || '';

      // Skip already filled
      if (field.currentValue && field.tag !== 'select' && !field.isCheckbox && !field.isRadioGroup) continue;

      // Handle checkboxes — check all (consent, privacy, etc.)
      if (field.isCheckbox) {
        const selector = field.id ? `#${cssEscape(field.id)}` : `input[name="${field.name}"]`;
        const el = await page.$(selector).catch(() => null);
        if (el) { await el.check().catch(() => forceClick(el)); filledCount++; }
        continue;
      }

      // Handle radio groups
      if (field.isRadioGroup) {
        let targetValue = 'Yes';
        for (const rule of SELECT_ANSWER_MAP) {
          if (rule.match.test(ctx)) {
            // Find the radio option matching the preference
            const matchOpt = field.radioOptions.find(o => rule.prefer.test(o.label) || rule.prefer.test(o.value));
            if (matchOpt) { targetValue = matchOpt.value; break; }
          }
        }
        const selector = field.name
          ? `input[type="radio"][name="${field.name}"][value="${targetValue}"]`
          : `input[type="radio"][value="${targetValue}"]`;
        let radioEl = await page.$(selector).catch(() => null);
        if (!radioEl && field.name) {
          // Fallback: click first "Yes" or first option
          radioEl = await page.$(`input[type="radio"][name="${field.name}"]`).catch(() => null);
        }
        if (radioEl) { await radioEl.check().catch(() => forceClick(radioEl)); filledCount++; }
        continue;
      }

      // Handle select dropdowns
      if (field.tag === 'select') {
        if (field.options.length <= 1) continue; // only placeholder
        const selector = field.id ? `#${cssEscape(field.id)}` : `select[name="${field.name}"]`;
        const el = await page.$(selector).catch(() => null);
        if (!el) continue;

        let matched = false;
        for (const rule of SELECT_ANSWER_MAP) {
          if (rule.match.test(ctx)) {
            matched = await selectByText(el, rule.prefer);
            break;
          }
        }
        if (!matched) {
          // Default: pick first non-empty option
          await selectByText(el, /.+/, 1);
        }
        filledCount++;
        continue;
      }

      // Handle text inputs and textareas
      if (field.tag === 'input' || field.tag === 'textarea') {
        if (field.type === 'file') continue;
        const selector = field.id ? `#${cssEscape(field.id)}`
          : field.name ? `${field.tag}[name="${field.name}"]`
          : null;
        if (!selector) continue;
        const el = await page.$(selector).catch(() => null);
        if (!el) continue;

        let value = null;
        for (const rule of ANSWER_MAP) {
          if (rule.match.test(ctx)) { value = rule.value(); break; }
        }
        // Textarea fallback
        if (value === null && field.tag === 'textarea') value = COVER;
        // Input fallback for required fields
        if (value === null && field.required && field.tag === 'input') {
          if (field.type === 'number') value = '8';
          else if (field.type === 'url') value = LINKEDIN_URL;
          else if (field.type === 'email') value = EMAIL;
          else if (field.type === 'tel') value = PHONE;
          else value = 'Yes';
        }
        if (value !== null) { await safeFill(el, value); filledCount++; }
      }
    } catch {}
  }
  return filledCount;
}

// ─── SCROLL + SCAN + FILL (full page) ─────────────────────────────────────────
// Scrolls through the entire page in chunks, scans all fields, and fills them.
// This ensures fields below the fold are found and filled.
async function scrollScanAndFill(page) {
  let totalFilled = 0;

  // First scroll to top
  await page.evaluate(() => window.scrollTo(0, 0)).catch(() => {});
  await humanDelay(150, 300);

  // Get page height
  const pageHeight = await page.evaluate(() => document.body.scrollHeight).catch(() => 0);
  const viewportHeight = await page.evaluate(() => window.innerHeight).catch(() => 768);
  const scrollSteps = Math.ceil(pageHeight / (viewportHeight * 0.7)); // 70% overlap

  let totalFields = 0;
  for (let step = 0; step <= scrollSteps; step++) {
    // Scroll to position
    const scrollY = Math.min(step * viewportHeight * 0.7, pageHeight);
    await page.evaluate((y) => window.scrollTo(0, y), scrollY).catch(() => {});
    await humanDelay(100, 200);

    // Scan and fill at this scroll position
    const fields = await scanPageFields(page);
    totalFields += fields.length;
    const filled = await fillScannedFields(page, fields);
    totalFilled += filled;
  }
  if (totalFields > 0) console.log(`    → Scan: ${totalFields} fields found, ${totalFilled} filled (page height: ${pageHeight}px, ${scrollSteps + 1} scroll steps)`);

  // Also run label-based fill as backup
  await page.evaluate(() => window.scrollTo(0, 0)).catch(() => {});
  await fillGenericByLabel(page);

  // Universal form filler pass (catches anything the ATS-specific scan missed)
  try {
    await fillAllFields(page, PROFILE);
    // Workday-specific widgets
    if (/workday|myworkdayjobs/i.test(page.url())) {
      await fillWorkdayWidgets(page, PROFILE);
    }
  } catch {}

  // Upload resume if not done yet
  await uploadResume(page);

  // Scroll back to top
  await page.evaluate(() => window.scrollTo(0, 0)).catch(() => {});

  return totalFilled;
}

// ─── FIND AND FIX ERROR FIELDS ────────────────────────────────────────────────
// After a failed submit, find fields with error indicators and try to fill them.
async function fixErrorFields(page) {
  let fixed = 0;

  // Strategy 1: Find inputs with aria-invalid="true" or red border / error class
  const errorFields = await page.evaluate(() => {
    const results = [];
    const els = document.querySelectorAll('[aria-invalid="true"], .error input, .error select, .error textarea, [class*="error"] input, [class*="error"] select, [class*="error"] textarea');
    for (const el of els) {
      const style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden') continue;
      const tag = el.tagName.toLowerCase();
      const id = el.id || '';
      const name = el.name || '';
      const type = el.type || '';
      const required = el.required || el.getAttribute('aria-required') === 'true';
      const value = el.value || '';

      // Get label
      let labelText = '';
      if (el.id) {
        const lbl = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
        if (lbl) labelText = lbl.innerText.trim();
      }
      if (!labelText) {
        let parent = el.parentElement;
        for (let i = 0; i < 4 && parent; i++) {
          const lbl = parent.querySelector('label, legend, [class*="label"]');
          if (lbl) { labelText = lbl.innerText.trim(); break; }
          parent = parent.parentElement;
        }
      }

      results.push({ tag, id, name, type, required, value, labelText,
        context: [labelText, el.placeholder || '', el.getAttribute('aria-label') || '', name, id].join(' ').toLowerCase()
      });
    }
    return results;
  }).catch(() => []);

  if (errorFields.length > 0) {
    console.log(`    → fixErrorFields: found ${errorFields.length} error fields: ${errorFields.map(f => f.labelText || f.name || f.id || f.tag).slice(0, 5).join(', ')}`);
  }

  for (const field of errorFields) {
    try {
      if (field.value && field.tag !== 'select') continue; // already has value

      const selector = field.id ? `#${cssEscape(field.id)}`
        : field.name ? `${field.tag}[name="${field.name}"]` : null;
      if (!selector) continue;
      const el = await page.$(selector).catch(() => null);
      if (!el) continue;

      const ctx = field.context;

      if (field.tag === 'select') {
        let matched = false;
        for (const rule of SELECT_ANSWER_MAP) {
          if (rule.match.test(ctx)) { await selectByText(el, rule.prefer); matched = true; break; }
        }
        if (!matched) await selectByText(el, /.+/, 1);
        fixed++;
      } else if (field.tag === 'input' || field.tag === 'textarea') {
        if (field.type === 'file') {
          await uploadResume(page);
          continue;
        }
        let value = null;
        for (const rule of ANSWER_MAP) {
          if (rule.match.test(ctx)) { value = rule.value(); break; }
        }
        // Fallback for any empty required field
        if (value === null && field.tag === 'textarea') value = COVER;
        if (value === null) {
          if (field.type === 'email') value = EMAIL;
          else if (field.type === 'tel') value = PHONE;
          else if (field.type === 'url') value = LINKEDIN_URL;
          else if (field.type === 'number') value = '8';
          else value = 'Yes';
        }
        await safeFill(el, value);
        fixed++;
      }
    } catch {}
  }

  // Strategy 2: Find required-but-empty fields
  const emptyRequired = await page.evaluate(() => {
    const results = [];
    document.querySelectorAll('[required], [aria-required="true"]').forEach(el => {
      const style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden') return;
      if (el.value && el.value.trim()) return; // has value
      if (el.type === 'hidden' || el.type === 'submit' || el.type === 'button') return;
      if (el.type === 'checkbox' && el.checked) return;
      if (el.type === 'radio') return; // handled separately

      let labelText = '';
      if (el.id) {
        const lbl = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
        if (lbl) labelText = lbl.innerText.trim();
      }
      if (!labelText) {
        let parent = el.parentElement;
        for (let i = 0; i < 4 && parent; i++) {
          const lbl = parent.querySelector('label, legend');
          if (lbl) { labelText = lbl.innerText.trim(); break; }
          parent = parent.parentElement;
        }
      }

      results.push({
        tag: el.tagName.toLowerCase(), id: el.id, name: el.name, type: el.type || '',
        labelText,
        context: [labelText, el.placeholder || '', el.getAttribute('aria-label') || '', el.name || '', el.id || ''].join(' ').toLowerCase()
      });
    });
    return results;
  }).catch(() => []);

  if (emptyRequired.length > 0) {
    console.log(`    → fixErrorFields: found ${emptyRequired.length} required-but-empty: ${emptyRequired.map(f => f.labelText || f.name || f.id || f.tag).slice(0, 5).join(', ')}`);
  }

  for (const field of emptyRequired) {
    try {
      const selector = field.id ? `#${cssEscape(field.id)}`
        : field.name ? `${field.tag}[name="${field.name}"]` : null;
      if (!selector) continue;
      const el = await page.$(selector).catch(() => null);
      if (!el) continue;

      const ctx = field.context;
      if (field.tag === 'select') {
        let matched = false;
        for (const rule of SELECT_ANSWER_MAP) {
          if (rule.match.test(ctx)) { await selectByText(el, rule.prefer); matched = true; break; }
        }
        if (!matched) await selectByText(el, /.+/, 1);
        fixed++;
      } else {
        let value = null;
        for (const rule of ANSWER_MAP) {
          if (rule.match.test(ctx)) { value = rule.value(); break; }
        }
        if (value === null && field.tag === 'textarea') value = COVER;
        if (value === null) {
          if (field.type === 'email') value = EMAIL;
          else if (field.type === 'tel') value = PHONE;
          else if (field.type === 'url') value = LINKEDIN_URL;
          else if (field.type === 'number') value = '8';
          else value = 'Yes';
        }
        await safeFill(el, value);
        fixed++;
      }
    } catch {}
  }

  console.log(`    → Fixed ${fixed} error/required fields`);
  return fixed;
}

// ─── VALIDATION ERROR DETECTION ───────────────────────────────────────────────
async function detectValidationErrors(page) {
  return await page.evaluate(() => {
    const errors = [];
    // Common error selectors
    const errorEls = document.querySelectorAll([
      '[class*="error"]:not([class*="error-boundary"])',
      '[class*="Error"]:not([class*="ErrorBoundary"])',
      '[role="alert"]', '[aria-invalid="true"]',
      '.invalid-feedback', '.field-error', '.form-error',
      '[data-automation-id*="error"]', '[data-testid*="error"]',
      '.css-1wc848c', // Workday error class
    ].join(', '));
    for (const el of errorEls) {
      if (el.offsetParent === null) continue; // not visible
      const text = el.innerText?.trim();
      if (text && text.length < 200) errors.push(text);
    }
    // Also check for red-bordered inputs (browser validation)
    const invalidInputs = document.querySelectorAll('input:invalid, select:invalid, textarea:invalid');
    for (const el of invalidInputs) {
      if (el.offsetParent === null) continue;
      const label = document.querySelector(`label[for="${el.id}"]`);
      errors.push(`Required: ${label?.innerText?.trim() || el.name || el.placeholder || 'unknown field'}`);
    }
    return errors;
  });
}

// ─── WORKDAY CUSTOM WIDGET HANDLER ────────────────────────────────────────────
async function handleWorkdayWidgets(page) {
  // Workday uses custom combobox/dropdown widgets, not standard <select>
  const widgets = await page.$$('[data-automation-id][role="combobox"], [data-automation-id] input[role="combobox"]');
  for (const widget of widgets) {
    try {
      if (!await widget.isVisible().catch(() => false)) continue;
      const autoId = await widget.getAttribute('data-automation-id') || '';
      let val = '';
      try { val = await widget.inputValue(); } catch { try { val = await widget.innerText(); } catch {} }
      if (val && val.trim()) continue; // already has a value

      // Get the label context
      const labelText = await widget.evaluate(el => {
        let p = el.parentElement;
        for (let i = 0; i < 5 && p; i++) {
          const lbl = p.querySelector('label');
          if (lbl) return lbl.innerText.trim().toLowerCase();
          p = p.parentElement;
        }
        return '';
      });

      const ctx = (autoId + ' ' + labelText).toLowerCase();
      let fillValue = null;

      if (/country|countryregion|addresssection_country/i.test(ctx)) fillValue = 'India';
      else if (/state|province|addresssection_state/i.test(ctx)) fillValue = 'Telangana';
      else if (/city|addresssection_city/i.test(ctx)) fillValue = CITY;
      else if (/phone.*type|device.*type|phone-device/i.test(ctx)) fillValue = 'Mobile';
      else if (/source|how.*hear|referral/i.test(ctx)) fillValue = 'LinkedIn';
      else if (/degree|education.*level/i.test(ctx)) fillValue = "Bachelor's";
      else if (/language/i.test(ctx)) fillValue = 'English';

      if (fillValue) {
        // Click to open the dropdown
        await forceClick(widget);
        await humanDelay(200, 400);

        // Type to filter
        await widget.fill('').catch(() => {});
        await widget.type(fillValue, { delay: 50 }).catch(() => {});
        await humanDelay(250, 500);

        // Click the first matching option in the dropdown
        const option = await page.$([
          '[role="option"]', '[role="listbox"] li',
          '[data-automation-id*="option"]', '[class*="option"]',
          '[class*="menuItem"]', 'li[id]',
        ].join(', ')).catch(() => null);
        if (option && await option.isVisible().catch(() => false)) {
          await forceClick(option);
          await humanDelay(150, 300);
        } else {
          // Press Enter to select
          await page.keyboard.press('Enter').catch(() => {});
          await humanDelay(100, 200);
        }
      }
    } catch {}
  }

  // Handle Workday multi-select buttons (e.g., skills, categories)
  const multiSelects = await page.$$('[data-automation-id*="multiselectInputContainer"]');
  for (const ms of multiSelects) {
    try {
      const input = await ms.$('input').catch(() => null);
      if (input && await input.isVisible().catch(() => false)) {
        const v = await input.inputValue().catch(() => '');
        if (!v) {
          await forceClick(input);
          await humanDelay(150, 300);
          // Select first option if available
          const opt = await page.$('[role="option"]').catch(() => null);
          if (opt) await forceClick(opt);
        }
      }
    } catch {}
  }
}

// Fill a select by matching option text
async function selectByText(sel, textRegex, fallbackIndex = 1) {
  try {
    const options = await sel.$$('option');
    for (const opt of options) {
      const text = await opt.innerText();
      if (textRegex.test(text)) {
        const val = await opt.getAttribute('value');
        await sel.selectOption(val);
        return true;
      }
    }
    if (options.length > fallbackIndex) {
      const val = await options[fallbackIndex].getAttribute('value');
      if (val) await sel.selectOption(val);
    }
  } catch {}
  return false;
}

// ─── LinkedIn OAuth ────────────────────────────────────────────────────────────
async function applyWithLinkedIn(page) {
  const btn = await page.$([
    'button[data-provider="linkedin"]', 'a[href*="linkedin.com/oauth"]',
    'button:has-text("Apply with LinkedIn")', 'a:has-text("Apply with LinkedIn")',
    'button:has-text("Sign in with LinkedIn")', 'a:has-text("Sign in with LinkedIn")',
    '[class*="linkedin-apply"]', '[id*="linkedin-apply"]',
  ].join(', ')).catch(() => null);
  if (!btn) return false;
  console.log('    → Apply with LinkedIn found');

  const [popup] = await Promise.all([
    page.context().waitForEvent('page', { timeout: 8000 }).catch(() => null),
    forceClick(btn),
  ]);
  if (popup) {
    await popup.waitForLoadState('domcontentloaded').catch(() => {});
    await waitForPageStable(popup, { maxWait: 800 });
    const allowBtn = await popup.$([
      'button[aria-label*="Allow"]', 'button:has-text("Allow")',
      'button:has-text("Authorize")', 'button:has-text("Continue")',
      'button[type="submit"]',
    ].join(', ')).catch(() => null);
    if (allowBtn) { await forceClick(allowBtn); await waitForPageStable(popup, { maxWait: 2000 }); }
    if (!popup.isClosed()) await popup.close().catch(() => {});
  }
  await waitForPageStable(page, { maxWait: 1000 });
  await dismissCookieConsent(page);
  await checkAndPauseIfNeeded(page); // some sites send OTP after LinkedIn OAuth
  return true;
}

// ─── Generic label-based fill ────────────────────────────────────────────────
async function fillGenericByLabel(page) {
  const mapping = [
    { regex: /first\s*name/i,                   value: FIRST_NAME,            tag: 'input' },
    { regex: /last\s*name|surname/i,             value: LAST_NAME,             tag: 'input' },
    { regex: /full\s*name|your\s*name|^name$/i,  value: FULL_NAME,             tag: 'input' },
    { regex: /email/i,                            value: EMAIL,                 tag: 'input' },
    { regex: /phone|mobile|contact\s*no/i,       value: PHONE,                 tag: 'input' },
    { regex: /linkedin/i,                         value: LINKEDIN_URL,          tag: 'input' },
    { regex: /expected.*ctc|expected.*salary|desired.*salary/i, value: `${EXPECTED_CTC} LPA`, tag: 'input' },
    { regex: /current.*ctc|current.*salary|present.*salary/i,  value: `${CURRENT_CTC} LPA`,  tag: 'input' },
    { regex: /notice\s*period|notice\s*days|serving\s*notice/i, value: `${NOTICE_DAYS} days`, tag: 'input' },
    { regex: /city|location|where\s*are\s*you/i, value: `${CITY}, India`,      tag: 'input' },
    { regex: /years.*experience|experience.*years/i, value: '8',              tag: 'input' },
    { regex: /salary|ctc|compensation|pay/i,     value: `${EXPECTED_CTC} LPA`, tag: 'input' },
    { regex: /portfolio|website|github/i,         value: LINKEDIN_URL,          tag: 'input' },
    { regex: /source|how.*hear|referr|where.*find/i, value: 'LinkedIn',        tag: 'input' },
    { regex: /employer|current.*company|working\s*at/i, value: 'Self Employed', tag: 'input' },
  ];

  for (const { regex, value } of mapping) {
    try {
      const el = await findFieldByLabel(page, regex);
      if (!el) continue;
      const tag = await el.evaluate(e => e.tagName.toLowerCase()).catch(() => '');
      if (tag !== 'input' && tag !== 'textarea') continue;
      const v = await el.inputValue().catch(() => '');
      if (v) continue;
      if (!await el.isVisible().catch(() => false)) continue;
      await safeFill(el, value);
    } catch {}
  }

  // Fill all visible textareas with cover if empty
  const textareas = await page.$$('textarea');
  for (const ta of textareas) {
    try {
      if (!await ta.isVisible().catch(() => false)) continue;
      const v = await ta.inputValue().catch(() => '');
      if (!v) await safeFill(ta, COVER);
    } catch {}
  }
}

// ─── clickSubmit helper ────────────────────────────────────────────────────────
async function clickSubmit(page) {
  const selectors = [
    'button[type="submit"]', 'input[type="submit"]',
    'button:has-text("Submit application")', 'button:has-text("Submit Application")',
    'button:has-text("Submit")', 'button:has-text("Apply Now")',
    'button:has-text("Apply now")', 'button:has-text("Send Application")',
    'button:has-text("Complete Application")', '#submit_app',
    '[data-qa="btn-submit"]', '[data-testid="submit-btn"]',
    '[data-automation-id="submitButton"]',
  ];
  for (const sel of selectors) {
    try {
      const el = await page.$(sel);
      if (el && await el.isVisible().catch(() => true)) {
        const disabled = await el.getAttribute('disabled').catch(() => null);
        if (disabled !== null) continue; // skip disabled buttons
        await forceClick(el);
        await humanDelay(150, 300);
        return true;
      }
    } catch {}
  }
  // Scan visible buttons
  const buttons = await page.$$('button:visible, input[type="submit"]:visible');
  for (const btn of buttons) {
    try {
      const txt = (await btn.innerText().catch(() => '')).trim().toLowerCase();
      if (/^(submit|apply|send|confirm|complete|finish|done)/.test(txt)) {
        const disabled = await btn.getAttribute('disabled').catch(() => null);
        if (disabled !== null) continue;
        await forceClick(btn);
        await humanDelay(150, 300);
        return true;
      }
    } catch {}
  }
  return false;
}

// ─── Greenhouse ───────────────────────────────────────────────────────────────
async function applyGreenhouse(page) {
  console.log('    → Greenhouse: scanning full page...');

  // Phase 1: Fill known Greenhouse-specific fields
  const fill = async (sel, val) => {
    const el = await page.$(sel).catch(() => null);
    if (el && await el.isVisible().catch(() => false)) {
      const v = await el.inputValue().catch(() => '');
      if (!v) await safeFill(el, val);
    }
  };
  await fill('input[name="first_name"], #first_name', FIRST_NAME);
  await fill('input[name="last_name"], #last_name', LAST_NAME);
  await fill('input[name="email"], #email', EMAIL);
  await fill('input[name="phone"], #phone', PHONE);
  await fill('input[name="job_application[linkedin_profile_url]"]', LINKEDIN_URL);
  await fill('input[name="job_application[website]"]', LINKEDIN_URL);

  // Location autocomplete — Greenhouse uses a typeahead
  const locSels = [
    'input[name="candidate_location"]', '#candidate_location',
    'input[id*="location"][role="combobox"]', 'input[name*="location"]',
    'input[aria-label*="Location" i]', 'input[placeholder*="location" i]',
    'input[placeholder*="city" i]', 'input[id*="auto_complete"]',
  ];
  const locInput = await page.$(locSels.join(', ')).catch(() => null);
  if (locInput && await locInput.isVisible().catch(() => false)) {
    const v = await locInput.inputValue().catch(() => '');
    if (!v) {
      await locInput.click().catch(() => {});
      await locInput.fill('');
      await locInput.type(`${CITY}, India`, { delay: 50 });
      await waitForPageStable(page, { maxWait: 1000 });
      // Click autocomplete suggestion if it appears
      const suggestion = await page.$([
        '[class*="suggestion"]', '[class*="autocomplete"] li', '[role="option"]',
        '[class*="location-autocomplete"] li', '.pac-item', '[class*="pac-container"] div',
        'ul[role="listbox"] li', '.DropdownIndicator', '[class*="dropdown"] li',
      ].join(', ')).catch(() => null);
      if (suggestion && await suggestion.isVisible().catch(() => false)) {
        await forceClick(suggestion);
        await humanDelay(200, 400);
      } else {
        // No autocomplete — try pressing Enter to confirm
        await locInput.press('Enter').catch(() => {});
        await humanDelay(150, 300);
      }
    }
  }

  // GDPR / Privacy checkboxes — Greenhouse often has these at the bottom
  const privacyCheckboxes = await page.$$([
    'input[type="checkbox"][id*="gdpr"]', 'input[type="checkbox"][id*="privacy"]',
    'input[type="checkbox"][id*="consent"]', 'input[type="checkbox"][id*="acknowledge"]',
    'input[type="checkbox"][name*="gdpr"]', 'input[type="checkbox"][name*="privacy"]',
    'input[type="checkbox"][name*="consent"]', 'input[type="checkbox"][name*="data_processing"]',
  ].join(', '));
  for (const cb of privacyCheckboxes) {
    try {
      if (!await cb.isChecked()) await cb.check().catch(() => forceClick(cb));
    } catch {}
  }

  // Also check any checkbox whose label mentions privacy/GDPR/consent
  const allCheckboxes = await page.$$('input[type="checkbox"]');
  for (const cb of allCheckboxes) {
    try {
      if (await cb.isChecked()) continue;
      const cbId = await cb.getAttribute('id') || '';
      const lbl = cbId ? await page.$(`label[for="${cbId}"]`).catch(() => null) : null;
      const lblText = lbl ? (await lbl.innerText().catch(() => '')).toLowerCase() : '';
      const parentText = await cb.evaluate(el => {
        let p = el.parentElement;
        for (let i = 0; i < 3 && p; i++) { if (p.innerText) return p.innerText.substring(0, 200).toLowerCase(); p = p.parentElement; }
        return '';
      }).catch(() => '');
      if (/privacy|gdpr|consent|acknowledge|agree|terms|data[\s_-]*processing/i.test(lblText + ' ' + parentText)) {
        await cb.check().catch(() => forceClick(cb));
      }
    } catch {}
  }

  // Phase 2: Resume upload
  await uploadResume(page);

  // Cover letter text
  const coverTextarea = await page.$([
    'textarea[name="cover_letter_text"]', '#cover_letter_text',
    'textarea[placeholder*="cover" i]', 'textarea[id*="cover"]',
  ].join(', ')).catch(() => null);
  if (coverTextarea) { const v = await coverTextarea.inputValue().catch(() => ''); if (!v) await safeFill(coverTextarea, COVER); }

  // Phase 3: Scroll through ENTIRE page, scan and fill at each position
  const totalFilled = await scrollScanAndFill(page);
  console.log(`    → Greenhouse: filled ${totalFilled} fields via full-page scroll+scan`);

  // Phase 4: Also run legacy question handler for [id^="question_"] elements
  const questions = await page.$$('[id^="question_"], [class*="custom-question"] input, [class*="custom-question"] select, [class*="custom-question"] textarea');
  for (const q of questions) {
    try {
      const id = await q.getAttribute('id') || '';
      const label = id ? await page.$(`label[for="${id}"]`).catch(() => null) : null;
      let labelText = label ? (await label.innerText().catch(() => '')).toLowerCase() : '';
      if (!labelText) {
        labelText = await q.evaluate(el => {
          let p = el.parentElement;
          for (let i = 0; i < 3 && p; i++) {
            const lbl = p.querySelector('label');
            if (lbl) return lbl.innerText.trim().toLowerCase();
            p = p.parentElement;
          }
          return '';
        });
      }
      const tag = await q.evaluate(el => el.tagName.toLowerCase());
      const ctx = labelText + ' ' + (await q.getAttribute('name') || '') + ' ' + id;

      if (tag === 'select') {
        let matched = false;
        for (const rule of SELECT_ANSWER_MAP) {
          if (rule.match.test(ctx)) { await selectByText(q, rule.prefer); matched = true; break; }
        }
        if (!matched) await selectByText(q, /yes/i, 1);
      } else if (tag === 'input') {
        const v = await q.inputValue().catch(() => '');
        if (v) continue;
        let value = null;
        for (const rule of ANSWER_MAP) {
          if (rule.match.test(ctx)) { value = rule.value(); break; }
        }
        if (value !== null) await safeFill(q, value);
        else await safeFill(q, 'Yes');
      } else if (tag === 'textarea') {
        const v = await q.inputValue().catch(() => '');
        if (v) continue;
        if (/authorization|visa|work permit/i.test(ctx)) await safeFill(q, 'Authorized to work in India. No visa sponsorship needed.');
        else if (/gap|history/i.test(ctx)) await safeFill(q, 'No gaps in employment history.');
        else await safeFill(q, COVER);
      }
    } catch {}
  }

  // Phase 5: Submit with validation error retry loop
  for (let attempt = 0; attempt < 3; attempt++) {
    // Scroll to bottom to reveal submit
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight)).catch(() => {});
    await humanDelay(200, 400);

    const submitBtn = await page.$('#submit_app, button[type="submit"], input[type="submit"], button:has-text("Submit Application"), button:has-text("Submit application")').catch(() => null);
    if (!submitBtn) {
      console.log('    → Greenhouse: no submit button found');
      return 'incomplete';
    }

    await forceClick(submitBtn);
    await waitForPageStable(page, { maxWait: 2000 });

    if (await isSuccessPage(page)) {
      console.log('    → Application confirmed');
      return 'applied';
    }

    // Check for validation errors
    const errors = await detectValidationErrors(page);
    if (errors.length === 0) {
      await waitForPageStable(page, { maxWait: 2000 });
      if (await isSuccessPage(page)) {
        console.log('    → Application confirmed (delayed)');
        return 'applied';
      }
      console.log('    → Submit clicked, no errors but no confirmation either');
      return 'incomplete';
    }

    console.log(`    → Greenhouse: validation errors (attempt ${attempt + 1}): ${errors.slice(0, 3).join('; ')}`);

    // Fix the specific error fields + re-scan full page
    await fixErrorFields(page);
    await scrollScanAndFill(page);

    // On last attempt, try AI if available
    if (attempt === 2 && aiBrain.isAvailable()) {
      console.log('    → Greenhouse: trying AI to fix remaining errors...');
      const aiActions = await aiBrain.aiAnalyzeFormFields(page);
      if (aiActions && aiActions.length > 0) {
        const aiExec = await aiBrain.executeAIActions(page, { actions: aiActions });
        if (aiExec > 0) console.log(`    → Greenhouse: AI executed ${aiExec} actions`);
      }
    }
  }

  console.log('    → Greenhouse: exhausted retry attempts');
  return 'incomplete';
}

// ─── Greenhouse Embedded (company pages using ?gh_jid=) ────────────────────────
async function applyGreenhouseEmbedded(page, originalUrl) {
  // Extract gh_jid from URL and find company slug
  const jidMatch = originalUrl.match(/gh_jid=(\d+)/i);
  if (!jidMatch) return await applyGeneric(page);
  const jid = jidMatch[1];

  // Try to find the actual greenhouse iframe or board URL on the page
  await waitForPageStable(page, { maxWait: 1000 });

  // Check for embedded iframe
  const iframe = await page.$('iframe[src*="greenhouse.io"]').catch(() => null);
  if (iframe) {
    const iframeSrc = await iframe.getAttribute('src');
    const iframePage = await page.context().newPage();
    try {
      await iframePage.goto(iframeSrc, { waitUntil: 'domcontentloaded', timeout: 20000 });
      await humanDelay(250, 500);
      const result = await applyGreenhouse(iframePage);
      await iframePage.close();
      return result;
    } catch {
      await iframePage.close().catch(() => {});
    }
  }

  // Try to find board URL in page source
  const boardUrlMatch = await page.evaluate(() => {
    const scripts = [...document.querySelectorAll('script')];
    for (const s of scripts) {
      const m = (s.innerHTML || '').match(/job-boards\.greenhouse\.io\/([\w-]+)\/jobs\/(\d+)/);
      if (m) return `https://job-boards.greenhouse.io/${m[1]}/jobs/${m[2]}`;
    }
    const links = [...document.querySelectorAll('a[href*="greenhouse.io"]')];
    for (const a of links) {
      if (a.href.includes('/jobs/')) return a.href;
    }
    return null;
  }).catch(() => null);

  if (boardUrlMatch) {
    await page.goto(boardUrlMatch, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await humanDelay(250, 500);
    return await applyGreenhouse(page);
  }

  // Fall back to generic
  return await applyGeneric(page);
}

// ─── Lever ────────────────────────────────────────────────────────────────────
async function applyLever(page) {
  console.log('    → Lever: scanning full page...');

  // Phase 1: Fill standard Lever fields
  const fill = async (sel, val) => {
    const el = await page.$(sel).catch(() => null);
    if (el && await el.isVisible().catch(() => false)) {
      const v = await el.inputValue().catch(() => '');
      if (!v) await safeFill(el, val);
    }
  };
  await fill('input[name="name"]', FULL_NAME);
  await fill('input[name="email"]', EMAIL);
  await fill('input[name="phone"]', PHONE);
  await fill('input[name="org"]', 'Self Employed');
  await fill('input[name="urls[LinkedIn]"]', LINKEDIN_URL);
  await fill('input[name="urls[Portfolio]"]', LINKEDIN_URL);
  await fill('input[name="urls[GitHub]"]', '');
  await fill('input[name="urls[Twitter]"]', '');
  await fill('input[name="urls[Other]"]', '');

  // Lever sometimes uses different field name patterns
  await fill('input[name="location"]', `${CITY}, India`);
  await fill('input[name="company"]', 'Self Employed');

  // Cover letter
  const coverSels = [
    'textarea[name="comments"]', 'textarea[id="comments"]',
    'textarea[name="additionalInformation"]', 'textarea[placeholder*="cover" i]',
    'textarea[placeholder*="additional" i]', 'textarea[name*="cover" i]',
  ];
  for (const sel of coverSels) {
    const el = await page.$(sel).catch(() => null);
    if (el && await el.isVisible().catch(() => false)) {
      const v = await el.inputValue().catch(() => '');
      if (!v) await safeFill(el, COVER);
    }
  }

  // Phase 2: Resume upload
  await uploadResume(page);

  // Phase 3: Custom questions (Lever-specific containers)
  await fillLeverCustomQuestions(page);

  // Phase 4: Full page scroll-scan to catch anything missed (including below-fold fields)
  const filled = await scrollScanAndFill(page);
  if (filled > 0) console.log(`    → Lever: filled ${filled} additional fields via scroll-scan`);

  // Phase 5: Check all consent/acknowledgment checkboxes
  const checkboxes = await page.$$('input[type="checkbox"]');
  for (const cb of checkboxes) {
    try {
      if (!await cb.isVisible().catch(() => false)) continue;
      if (!await cb.isChecked()) await cb.check().catch(() => forceClick(cb));
    } catch {}
  }

  // Phase 6: Submit with retry loop
  for (let attempt = 0; attempt < 3; attempt++) {
    // Scroll to bottom to reveal submit button
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight)).catch(() => {});
    await humanDelay(150, 300);

    const submitBtn = await page.$([
      'button[type="submit"]', '.template-btn-submit',
      'button:has-text("Submit application")', 'button:has-text("Submit Application")',
      'button:has-text("Submit")', 'button:has-text("Apply")',
      'button:has-text("Apply for this job")', 'button:has-text("Send application")',
      'input[type="submit"]', 'a.template-btn-submit',
      '.postings-btn-submit', '.application-submit',
      'button[data-qa="btn-submit"]',
    ].join(', ')).catch(() => null);

    if (!submitBtn) {
      // Lever sometimes hides submit until all required fields are filled
      // Try finding it by scanning all buttons
      const allBtns = await page.$$('button');
      let found = null;
      for (const btn of allBtns) {
        try {
          if (!await btn.isVisible().catch(() => false)) continue;
          const txt = (await btn.innerText().catch(() => '')).trim().toLowerCase();
          if (/submit|apply|send/i.test(txt)) { found = btn; break; }
        } catch {}
      }
      if (!found) {
        console.log('    → Lever: no submit button found');
        return 'incomplete';
      }
      await forceClick(found);
    } else {
      // Check if disabled
      const disabled = await submitBtn.getAttribute('disabled').catch(() => null);
      const ariaDisabled = await submitBtn.getAttribute('aria-disabled').catch(() => null);
      if (disabled !== null || ariaDisabled === 'true') {
        console.log(`    → Lever: submit button disabled (attempt ${attempt + 1}), re-filling...`);
        const fixed = await fixErrorFields(page);
        if (fixed > 0) console.log(`    → Lever: fixed ${fixed} error fields`);
        await scrollScanAndFill(page);
        await fillLeverCustomQuestions(page);
        await uploadResume(page);
        continue;
      }
      await forceClick(submitBtn);
    }

    await waitForPageStable(page, { maxWait: 2000 });

    // Check for success
    if (await isSuccessPage(page)) {
      console.log('    → Application confirmed');
      return 'applied';
    }

    // Check for Lever-specific success indicators
    const leverSuccess = await page.$([
      '.application-confirmation', '[class*="thank-you"]', '[class*="thankYou"]',
      '.posting-apply-confirmation', '[data-qa="msg-submit-success"]',
      'h3:has-text("Application submitted")', 'h3:has-text("Thanks for applying")',
      'div:has-text("Your application has been submitted")',
    ].join(', ')).catch(() => null);
    if (leverSuccess && await leverSuccess.isVisible().catch(() => false)) {
      console.log('    → Application confirmed (Lever success element)');
      return 'applied';
    }

    // Check URL for success
    const postUrl = page.url();
    if (/thank|confirm|success|submitted/i.test(postUrl)) {
      console.log('    → Application confirmed (success URL)');
      return 'applied';
    }

    // Check for validation errors
    const errors = await detectValidationErrors(page);
    if (errors.length > 0) {
      console.log(`    → Lever: validation errors (attempt ${attempt + 1}): ${errors.slice(0, 3).join('; ')}`);
      // Fix error fields, then scroll-scan entire page
      const fixed = await fixErrorFields(page);
      if (fixed > 0) console.log(`    → Lever: fixed ${fixed} error fields`);
      await scrollScanAndFill(page);
      await fillLeverCustomQuestions(page);
      await uploadResume(page);
      continue;
    }

    // No errors but no success either — check for Lever's inline error messages
    const leverErrors = await page.$$eval('.application-error, .error-message, [class*="error"]', els =>
      els.filter(e => e.offsetParent !== null).map(e => e.innerText.trim()).filter(t => t)
    ).catch(() => []);
    if (leverErrors.length > 0) {
      console.log(`    → Lever: inline errors: ${leverErrors.slice(0, 3).join('; ')}`);
      continue;
    }

    console.log('    → Lever: submit clicked, no confirmation or errors detected');
    // Wait a bit more — some Lever sites redirect slowly
    await waitForPageStable(page, { maxWait: 3000 });
    if (await isSuccessPage(page)) return 'applied';
    return 'incomplete';
  }

  return 'incomplete';
}

async function fillLeverCustomQuestions(page) {
  // Lever uses multiple container patterns for custom questions
  const sections = await page.$$([
    '.application-question', '.custom-question', '[class*="custom-field"]',
    '.lever-question', '.application-additional', '.posting-question',
    '[class*="question-container"]', '[class*="additionalField"]',
    'li[class*="question"]', 'div[class*="question"]',
  ].join(', '));

  for (const section of sections) {
    try {
      const labelEl = await section.$('label, h4, h3, p strong, .question-label, legend, [class*="label"]').catch(() => null);
      const labelText = labelEl ? (await labelEl.innerText().catch(() => '')).toLowerCase() : '';

      const input    = await section.$('input[type="text"], input[type="number"], input[type="email"], input[type="url"], input[type="tel"]').catch(() => null);
      const textarea = await section.$('textarea').catch(() => null);
      const select   = await section.$('select').catch(() => null);
      const radios   = await section.$$('input[type="radio"]').catch(() => []);
      const checkbox  = await section.$('input[type="checkbox"]').catch(() => null);

      const ctx = labelText;

      if (select) {
        let matched = false;
        for (const rule of SELECT_ANSWER_MAP) {
          if (rule.match.test(ctx)) { await selectByText(select, rule.prefer); matched = true; break; }
        }
        if (!matched) await selectByText(select, /yes/i, 1);
      } else if (radios.length > 0) {
        // Check if already answered
        let anyChecked = false;
        for (const r of radios) { if (await r.isChecked().catch(() => false)) { anyChecked = true; break; } }
        if (!anyChecked) {
          let targetRadio = radios[0];
          for (const radio of radios) {
            try {
              const radioLabel = await radio.evaluate(el => {
                const lbl = el.parentElement?.querySelector('label, span');
                return lbl ? lbl.innerText.trim().toLowerCase() : (el.value || '').toLowerCase();
              });
              if (/visa|sponsor/i.test(ctx)) {
                if (/\bno\b/.test(radioLabel)) { targetRadio = radio; break; }
              } else {
                if (/\byes\b/.test(radioLabel)) { targetRadio = radio; break; }
              }
            } catch {}
          }
          await targetRadio.check().catch(() => forceClick(targetRadio));
        }
      } else if (checkbox) {
        if (!await checkbox.isChecked().catch(() => false)) {
          await checkbox.check().catch(() => forceClick(checkbox));
        }
      } else if (input) {
        if (!await input.isVisible().catch(() => false)) continue;
        const v = await input.inputValue().catch(() => '');
        if (v) continue;
        let value = null;
        for (const rule of ANSWER_MAP) {
          if (rule.match.test(ctx)) { value = rule.value(); break; }
        }
        if (value !== null) await safeFill(input, value);
        else if (/required/i.test(await section.innerHTML().catch(() => ''))) await safeFill(input, 'Yes');
      } else if (textarea) {
        if (!await textarea.isVisible().catch(() => false)) continue;
        const v = await textarea.inputValue().catch(() => '');
        if (v) continue;
        await safeFill(textarea, COVER);
      }
    } catch {}
  }

  // Also scan any questions NOT in standard containers (flat form fields)
  await fillGenericByLabel(page);
}

// ─── Ashby ────────────────────────────────────────────────────────────────────
async function applyAshby(page) {
  // Wait for form to fully render
  await waitForPageStable(page, { maxWait: 1000 });

  const fill = async (sel, val) => {
    const el = await page.$(sel).catch(() => null);
    if (el && await el.isVisible().catch(() => false)) {
      const v = await el.inputValue().catch(() => '');
      if (!v) await safeFill(el, val);
    }
  };

  await fill('[name="_systemfield_name"]', FULL_NAME);
  await fill('[name="_systemfield_email"]', EMAIL);

  // Resume: Ashby uses a hidden input or drag-drop; try multiple approaches
  const fs = require('fs');
  if (fs.existsSync(RESUME_PATH)) {
    // Try visible file input first
    const fileInputs = await page.$$('input[type="file"]');
    let uploaded = false;
    for (const inp of fileInputs) {
      try {
        const accept = (await inp.getAttribute('accept') || '').toLowerCase();
        if (!accept.includes('image')) {
          await inp.setInputFiles(RESUME_PATH);
          await humanDelay(300, 600);
          console.log('    → Resume uploaded');
          uploaded = true;
          break;
        }
      } catch {}
    }
    if (!uploaded) {
      // Try Ashby's specific upload button
      const uploadBtn = await page.$('[data-testid="resume-upload"], button:has-text("Upload Resume"), button:has-text("Attach Resume"), label[for*="resume"]').catch(() => null);
      if (uploadBtn) await forceClick(uploadBtn).catch(() => {});
    }
  }

  // Fill custom fields by label
  await fillAshbyCustomFields(page);

  // Full scroll-scan to catch anything missed
  const filled = await scrollScanAndFill(page);
  if (filled > 0) console.log(`    → Ashby: filled ${filled} additional fields via scroll-scan`);

  // Submit with retry loop
  for (let attempt = 0; attempt < 3; attempt++) {
    // Scroll to bottom to reveal submit
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight)).catch(() => {});
    await humanDelay(200, 400);

    const submitBtn = await page.$([
      'button[type="submit"]', 'button:has-text("Submit Application")',
      'button:has-text("Submit")', 'button:has-text("Apply")',
      '[data-testid="submit-button"]',
    ].join(', ')).catch(() => null);

    if (!submitBtn) {
      console.log('    → Ashby: no submit button found');
      return 'incomplete';
    }

    // Check if disabled
    const disabled = await submitBtn.getAttribute('disabled').catch(() => null);
    if (disabled !== null) {
      console.log(`    → Ashby: submit disabled (attempt ${attempt + 1}), re-filling...`);
      await fixErrorFields(page);
      await scrollScanAndFill(page);
      await fillAshbyCustomFields(page);
      await uploadResume(page);
      continue;
    }

    await forceClick(submitBtn);
    await waitForPageStable(page, { maxWait: 2500 });

    if (await isSuccessPage(page)) { console.log('    → Application confirmed'); return 'applied'; }

    // Check for Ashby-specific success
    const ashbySuccess = await page.$('[class*="success"], [class*="thank"], [data-testid*="success"]').catch(() => null);
    if (ashbySuccess && await ashbySuccess.isVisible().catch(() => false)) {
      console.log('    → Application confirmed (Ashby success element)');
      return 'applied';
    }

    const success = await waitForSuccess(page, 3000);
    if (success) { console.log('    → Application confirmed'); return 'applied'; }

    // Check validation errors
    const errors = await detectValidationErrors(page);
    if (errors.length > 0) {
      console.log(`    → Ashby: validation errors (attempt ${attempt + 1}): ${errors.slice(0, 3).join('; ')}`);
      await fixErrorFields(page);
      await scrollScanAndFill(page);
      continue;
    }

    console.log('    → Submit clicked but no confirmation received');
    return 'incomplete';
  }
  return 'incomplete';
}

async function fillAshbyCustomFields(page) {
  // Get ALL form containers — Ashby uses various class names
  const containers = await page.$$([
    '[data-testid*="field"]', '.ashby-application-form-field',
    '[class*="FormField"]', '[class*="formField"]', '[class*="field-wrapper"]',
    '[class*="InputField"]', '[class*="input-field"]', '[class*="FormGroup"]',
    '.application-field', '[class*="application-form"] > div',
  ].join(', '));

  const tryFill = async (container) => {
    try {
      const labelEl = await container.$('label, [class*="label"], [class*="Label"], legend').catch(() => null);
      const labelText = labelEl ? (await labelEl.innerText().catch(() => '')).toLowerCase() : '';
      if (!labelText) return;

      const input    = await container.$('input:not([type="file"]):not([type="checkbox"]):not([type="radio"]):not([type="hidden"])').catch(() => null);
      const textarea = await container.$('textarea').catch(() => null);
      const select   = await container.$('select').catch(() => null);
      const radios   = await container.$$('input[type="radio"]').catch(() => []);

      if (input && await input.isVisible().catch(() => false)) {
        const v = await input.inputValue().catch(() => '');
        if (v) return;
        if (/full\s*name|^name/i.test(labelText))              await safeFill(input, FULL_NAME);
        else if (/email/i.test(labelText))                     await safeFill(input, EMAIL);
        else if (/phone|mobile/i.test(labelText))              await safeFill(input, PHONE);
        else if (/linkedin/i.test(labelText))                  await safeFill(input, LINKEDIN_URL);
        else if (/location|city|where/i.test(labelText))       await safeFill(input, `${CITY}, India`);
        else if (/expected.*ctc|expected.*salary|desired/i.test(labelText)) await safeFill(input, `${EXPECTED_CTC} LPA`);
        else if (/current.*ctc|current.*salary/i.test(labelText)) await safeFill(input, `${CURRENT_CTC} LPA`);
        else if (/notice|period/i.test(labelText))             await safeFill(input, `${NOTICE_DAYS} days`);
        else if (/experience|years/i.test(labelText))          await safeFill(input, '8');
        else if (/employer|company/i.test(labelText))          await safeFill(input, 'Self Employed');
        else if (/referral|source|hear/i.test(labelText))      await safeFill(input, 'LinkedIn');
        else if (/salary|ctc|compensation/i.test(labelText))   await safeFill(input, `${EXPECTED_CTC} LPA`);
        else if (/website|portfolio/i.test(labelText))         await safeFill(input, LINKEDIN_URL);
      } else if (textarea && await textarea.isVisible().catch(() => false)) {
        const v = await textarea.inputValue().catch(() => '');
        if (v) return;
        if (/cover|introduction|about|message/i.test(labelText)) await safeFill(textarea, COVER);
        else await safeFill(textarea, COVER);
      } else if (select && await select.isVisible().catch(() => false)) {
        if (/visa|sponsor/i.test(labelText)) await selectByText(select, /no/i);
        else if (/notice/i.test(labelText)) await selectByText(select, /30|one month/i);
        else if (/source|hear|linkedin/i.test(labelText)) await selectByText(select, /linkedin/i);
        else if (/authoriz|eligible/i.test(labelText)) await selectByText(select, /yes/i);
        else if (/gender/i.test(labelText)) await selectByText(select, /prefer not|decline/i, 0);
        else await selectByText(select, /./, 1);
      } else if (radios.length > 0) {
        const visibleRadios = [];
        for (const r of radios) { if (await r.isVisible().catch(() => false)) visibleRadios.push(r); }
        if (visibleRadios.length === 0) return;
        if (/visa|sponsor/i.test(labelText)) {
          const noRadio = await container.$('input[type="radio"][value*="no" i], input[type="radio"][value*="false"]').catch(() => null)
            || visibleRadios[visibleRadios.length - 1];
          if (noRadio) await noRadio.check().catch(() => forceClick(noRadio));
        } else {
          const yesRadio = await container.$('input[type="radio"][value*="yes" i], input[type="radio"][value*="true"]').catch(() => null)
            || visibleRadios[0];
          if (yesRadio) await yesRadio.check().catch(() => forceClick(yesRadio));
        }
      }
    } catch {}
  };

  if (containers.length > 0) {
    for (const c of containers) await tryFill(c);
  }

  // Fallback: scan all labels
  const labels = await page.$$('label');
  for (const label of labels) {
    try {
      const forAttr = await label.getAttribute('for');
      if (!forAttr) continue;
      const escaped = forAttr.replace(/([.[\]:"'#])/g, '\\$1');
      const field = await page.$(`#${escaped}`).catch(() => null);
      if (!field) continue;
      if (!await field.isVisible().catch(() => false)) continue;
      const labelText = (await label.innerText().catch(() => '')).toLowerCase();
      const tag = await field.evaluate(e => e.tagName.toLowerCase());
      const v = await field.inputValue().catch(() => '');
      if (v) continue;
      if (tag === 'input') {
        if (/name/i.test(labelText)) await safeFill(field, FULL_NAME);
        else if (/email/i.test(labelText)) await safeFill(field, EMAIL);
        else if (/phone/i.test(labelText)) await safeFill(field, PHONE);
        else if (/linkedin/i.test(labelText)) await safeFill(field, LINKEDIN_URL);
        else if (/location|city/i.test(labelText)) await safeFill(field, `${CITY}, India`);
        else if (/expected.*ctc|expected.*salary/i.test(labelText)) await safeFill(field, `${EXPECTED_CTC} LPA`);
        else if (/current.*ctc/i.test(labelText)) await safeFill(field, `${CURRENT_CTC} LPA`);
        else if (/notice/i.test(labelText)) await safeFill(field, `${NOTICE_DAYS} days`);
        else if (/experience|years/i.test(labelText)) await safeFill(field, '8');
      } else if (tag === 'textarea') {
        await safeFill(field, COVER);
      }
    } catch {}
  }
}

// ─── Workday ──────────────────────────────────────────────────────────────────
async function applyWorkday(page) {
  console.log('    → Workday: starting full-page aware apply...');

  // Wait for Workday SPA to load (they load via JS/React)
  await waitForPageStable(page, { maxWait: 2000 });
  const pageUrl = page.url();
  console.log(`    → Workday: page URL: ${pageUrl.substring(0, 80)}`);

  // Log what's visible on the page for debugging
  const pageState = await page.evaluate(() => {
    const btns = [...document.querySelectorAll('a, button')].filter(e => e.offsetParent !== null);
    return btns.slice(0, 15).map(e => `<${e.tagName.toLowerCase()}> "${e.innerText.trim().substring(0, 50)}" [${e.getAttribute('data-automation-id') || ''}]`);
  }).catch(() => []);
  console.log(`    → Workday: visible buttons: ${pageState.slice(0, 5).join(' | ') || 'NONE'}`);

  // Step 1: Click Apply button (extended selectors — Workday uses many patterns)
  let applyBtn = await page.$([
    'a[data-automation-id="applyButton"]',
    'button[data-automation-id="applyButton"]',
    'a[data-automation-id="jobAction-applyButton"]',
    'a[data-automation-id="jobAction-apply"]',
    'button[data-automation-id="jobAction-applyButton"]',
    '[data-automation-id="jobPostingApplyButton"]',
    'a[href*="/apply"]',
  ].join(', ')).catch(() => null);

  // Fallback: scan all links/buttons for "Apply" text
  if (!applyBtn) {
    const allEls = await page.$$('a, button');
    for (const el of allEls) {
      try {
        if (!await el.isVisible().catch(() => false)) continue;
        const txt = (await el.innerText().catch(() => '')).trim().toLowerCase();
        if (txt === 'apply' || txt === 'apply now' || txt.startsWith('apply for')) {
          applyBtn = el; break;
        }
      } catch {}
    }
  }

  if (applyBtn) {
    console.log('    → Workday: clicking Apply button...');
    await forceClick(applyBtn);
    await waitForPageStable(page, { maxWait: 2500 }); // Workday SPA transitions are slow
    await dismissCookieConsent(page);
  } else {
    console.log('    → Workday: no Apply button found on page — checking if already on form...');
    // Check if we're already on an application form (direct link)
    const hasForm = await page.$('input, select, textarea, [data-automation-id*="name"], [data-automation-id*="email"]').catch(() => null);
    if (!hasForm) {
      console.log('    → Workday: no form found either — page may need login or is not an application page');
    }
  }

  // Step 2: Handle auth — try "Apply Manually" or "Use my last application" first
  const quickBtn = await page.$([
    'a:has-text("Apply Manually")', 'button:has-text("Apply Manually")',
    'a:has-text("Use My Last Application")', 'button:has-text("Use My Last Application")',
    'a:has-text("Autofill with Resume")', 'button:has-text("Autofill with Resume")',
    'a:has-text("Start Your Application")', 'button:has-text("Start Your Application")',
  ].join(', ')).catch(() => null);
  if (quickBtn && await quickBtn.isVisible().catch(() => false)) {
    console.log('    → Workday: clicking quick-start option...');
    await forceClick(quickBtn);
    await waitForPageStable(page, { maxWait: 1500 });
  }

  // Try sign in / create account
  const createBtn = await page.$([
    'a:has-text("Create Account")', 'button:has-text("Create Account")',
    'a:has-text("Sign In")', 'button:has-text("Sign In")',
    'a:has-text("Sign in with Email")', 'button:has-text("Sign in with Email")',
  ].join(', ')).catch(() => null);
  if (createBtn && await createBtn.isVisible().catch(() => false)) {
    console.log('    → Workday: attempting sign-in/account creation...');
    await forceClick(createBtn);
    await waitForPageStable(page, { maxWait: 800 });
    const emailField = await page.$('[data-automation-id="email"], input[type="email"], input[name*="email"]').catch(() => null);
    if (emailField) {
      await safeFill(emailField, EMAIL);
      const passField = await page.$('[data-automation-id="password"], input[type="password"]').catch(() => null);
      if (passField) {
        await safeFill(passField, PASSWORD);
        const submitBtn = await page.$('[data-automation-id="signInSubmitButton"], button[type="submit"], button:has-text("Sign In")').catch(() => null);
        if (submitBtn) { await forceClick(submitBtn); await waitForPageStable(page, { maxWait: 2000 }); }
      } else {
        // Some Workday sites just need email → then click continue
        const contBtn = await page.$('button:has-text("Continue"), button:has-text("Next"), button[type="submit"]').catch(() => null);
        if (contBtn) { await forceClick(contBtn); await waitForPageStable(page, { maxWait: 1500 }); }
      }
    }
  }

  await checkAndPauseIfNeeded(page);

  // Log post-auth page state
  const postAuthUrl = page.url();
  const postState = await page.evaluate(() => {
    const inputs = document.querySelectorAll('input:not([type="hidden"]), select, textarea');
    return { inputCount: inputs.length, url: window.location.href };
  }).catch(() => ({ inputCount: 0 }));
  console.log(`    → Workday: form inputs found: ${postState.inputCount} | URL: ${postAuthUrl.substring(0, 80)}`);

  return await walkWorkday(page);
}

async function walkWorkday(page, maxSteps = 15) {
  for (let step = 0; step < maxSteps; step++) {
    await dismissCookieConsent(page);
    await checkAndPauseIfNeeded(page);
    if (await isSuccessPage(page)) { console.log('    → Workday: application confirmed!'); return 'applied'; }

    console.log(`    → Workday: step ${step + 1} — scanning page...`);

    // Detect current page section
    const pageTitle = await page.evaluate(() => {
      const h = document.querySelector('h2, h3, [data-automation-id*="pageHeader"], [data-automation-id*="stepTitle"]');
      return h ? h.innerText.trim() : '';
    }).catch(() => '');
    console.log(`    → Workday: page section: "${pageTitle}"`);

    // Phase A: Fill Workday-specific data-automation-id fields
    const wdFields = [
      ['legalNameSection_firstName', FIRST_NAME],
      ['legalNameSection_lastName', LAST_NAME],
      ['legalNameSection_middleName', ''],
      ['email', EMAIL],
      ['phone-number', PHONE],
      ['phone-device-type', 'Mobile'],
      ['addressSection_addressLine1', `${CITY}`],
      ['addressSection_city', CITY],
      ['addressSection_countryRegion', 'India'],
      ['addressSection_postalCode', '500081'],
      ['linkedinQuestion', LINKEDIN_URL],
      ['linkedin', LINKEDIN_URL],
      ['websiteQuestion', LINKEDIN_URL],
      ['previousWorker', 'No'],
      ['source', 'LinkedIn'],
      ['referral', 'LinkedIn'],
    ];
    for (const [autoId, val] of wdFields) {
      if (!val) continue;
      const el = await page.$(`[data-automation-id="${autoId}"]`).catch(() => null);
      if (el && await el.isVisible().catch(() => false)) {
        const tag = await el.evaluate(e => e.tagName.toLowerCase());
        if (tag === 'input' || tag === 'textarea') {
          const v = await el.inputValue().catch(() => '');
          if (!v) await safeFill(el, val);
        } else if (tag === 'select') {
          await selectByText(el, new RegExp(val, 'i'));
        }
      }
    }

    // Phase B: Handle Workday's custom combobox/dropdown widgets
    await handleWorkdayWidgets(page);

    // Phase C: Resume upload (Workday uses a specific upload area)
    const wdResumeBtn = await page.$([
      '[data-automation-id="file-upload-input-ref"]',
      '[data-automation-id="resumeSection"] input[type="file"]',
      'input[data-automation-id*="resume"]',
      'input[data-automation-id*="file"]',
    ].join(', ')).catch(() => null);
    if (wdResumeBtn) {
      const fs = require('fs');
      if (fs.existsSync(RESUME_PATH)) {
        try {
          await wdResumeBtn.setInputFiles(RESUME_PATH);
          await waitForPageStable(page, { maxWait: 1000 });
          console.log('    → Workday: resume uploaded');
        } catch {}
      }
    } else {
      await uploadResume(page); // fallback generic upload
    }

    // Phase D: Full page scroll-scan — catch everything the specific selectors missed
    const filled = await scrollScanAndFill(page);
    if (filled > 0) console.log(`    → Workday: filled ${filled} additional fields via scroll-scan`);

    // Phase E: Handle Workday "My Experience" section
    if (/experience|work history|employment/i.test(pageTitle)) {
      // Try to skip if possible (some Workday sites allow it)
      const skipBtn = await page.$('button:has-text("Skip"), a:has-text("Skip")').catch(() => null);
      if (skipBtn && await skipBtn.isVisible().catch(() => false)) {
        await forceClick(skipBtn);
        await waitForPageStable(page, { maxWait: 800 });
        continue;
      }
      // Otherwise resume parsing should handle it
    }

    // Phase F: Handle "Voluntary Disclosures" / EEO page
    if (/voluntary|disclosure|eeo|equal|self.?identify|veteran|disability/i.test(pageTitle)) {
      // Select "Prefer not to answer" / "Decline" for all dropdowns
      const allSelects = await page.$$('select');
      for (const sel of allSelects) {
        try {
          if (!await sel.isVisible().catch(() => false)) continue;
          await selectByText(sel, /prefer not|decline|choose not|don't wish|no answer/i, 0);
        } catch {}
      }
    }

    // Phase G: Check validation errors BEFORE clicking Next/Submit
    const preErrors = await detectValidationErrors(page);
    if (preErrors.length > 0) {
      console.log(`    → Workday: pre-navigation errors: ${preErrors.slice(0, 3).join('; ')}`);
      // Fix error/required fields specifically
      const fixed = await fixErrorFields(page);
      if (fixed > 0) console.log(`    → Workday: fixed ${fixed} error fields`);
      await humanDelay(150, 300);
    }

    // Phase H: Navigate — try Next, Save & Continue, or Submit
    const nextBtn = await page.$([
      '[data-automation-id="bottom-navigation-next-button"]',
      '[data-automation-id="saveAndContinueButton"]',
      'button:has-text("Next")', 'button:has-text("Save and Continue")',
      'button:has-text("Continue")',
    ].join(', ')).catch(() => null);
    if (nextBtn && await nextBtn.isVisible().catch(() => false)) {
      const disabled = await nextBtn.getAttribute('disabled').catch(() => null);
      if (disabled === null) {
        await forceClick(nextBtn);
        await waitForPageStable(page, { maxWait: 1200 });

        // Check for validation errors after click
        const postErrors = await detectValidationErrors(page);
        if (postErrors.length > 0) {
          console.log(`    → Workday: post-click errors: ${postErrors.slice(0, 3).join('; ')}`);
          // We're still on the same page — fix errors and retry once
          const fixed = await fixErrorFields(page);
          if (fixed > 0) console.log(`    → Workday: fixed ${fixed} error fields`);
          await handleWorkdayWidgets(page);
          await humanDelay(150, 300);
          await forceClick(nextBtn).catch(() => {});
          await waitForPageStable(page, { maxWait: 1000 });
        }
        continue;
      }
    }

    // Try submit
    const submitBtn = await page.$([
      '[data-automation-id="submitButton"]',
      'button:has-text("Submit")', 'button:has-text("Submit Application")',
    ].join(', ')).catch(() => null);
    if (submitBtn && await submitBtn.isVisible().catch(() => false)) {
      const disabled = await submitBtn.getAttribute('disabled').catch(() => null);
      if (disabled !== null) {
        console.log('    → Workday: submit button is disabled — fixing required fields...');
        const fixed = await fixErrorFields(page);
        if (fixed > 0) console.log(`    → Workday: fixed ${fixed} error fields`);
        await scrollScanAndFill(page);
        await humanDelay(250, 500);
      }
      await forceClick(submitBtn);
      await waitForPageStable(page, { maxWait: 2000 });

      if (await isSuccessPage(page)) {
        console.log('    → Workday: application confirmed!');
        return 'applied';
      }
      // Check for confirmation dialog/modal
      const confirmBtn = await page.$([
        'button:has-text("OK")', 'button:has-text("Yes")', 'button:has-text("Confirm")',
        '[data-automation-id="confirmButton"]',
      ].join(', ')).catch(() => null);
      if (confirmBtn && await confirmBtn.isVisible().catch(() => false)) {
        await forceClick(confirmBtn);
        await waitForPageStable(page, { maxWait: 2000 });
        if (await isSuccessPage(page)) return 'applied';
      }

      const postErrors = await detectValidationErrors(page);
      if (postErrors.length > 0) {
        console.log(`    → Workday: submit errors: ${postErrors.slice(0, 3).join('; ')}`);
        continue; // loop back and try to fix
      }
      return 'incomplete';
    }

    // No Next or Submit found — try AI before giving up
    if (aiBrain.isAvailable()) {
      console.log('    → Workday: no navigation button — asking AI to analyze page...');
      const aiAnalysis = await aiBrain.analyzePageForApply(page);
      if (aiAnalysis) {
        if (aiAnalysis.pageType === 'success') {
          console.log('    → Workday: AI detected success page');
          return 'applied';
        }
        const aiExec = await aiBrain.executeAIActions(page, aiAnalysis);
        if (aiExec > 0) {
          console.log(`    → Workday: AI executed ${aiExec} actions`);
          await waitForPageStable(page, { maxWait: 1500 });
          continue; // loop back to check next state
        }
      }
    }

    console.log('    → Workday: no navigation button found on this step');
    break;
  }
  return 'incomplete';
}

// ─── BambooHR ─────────────────────────────────────────────────────────────────
async function applyBambooHR(page) {
  const fill = async (sel, val) => {
    const el = await page.$(sel).catch(() => null);
    if (el) { const v = await el.inputValue().catch(() => ''); if (!v) await safeFill(el, val); }
  };
  await fill('input[name="firstName"], input[id*="firstName"], input[id*="first_name"]', FIRST_NAME);
  await fill('input[name="lastName"],  input[id*="lastName"],  input[id*="last_name"]', LAST_NAME);
  await fill('input[name="email"], input[type="email"]', EMAIL);
  await fill('input[name="phone"]', PHONE);
  await fill('input[name="city"]', CITY);
  // Scroll-scan entire page to catch custom/below-fold fields
  await scrollScanAndFill(page);

  for (let attempt = 0; attempt < 3; attempt++) {
    const submitBtn = await page.$('button[type="submit"], input[type="submit"], button:has-text("Submit")').catch(() => null);
    if (submitBtn) {
      await forceClick(submitBtn);
      await waitForPageStable(page, { maxWait: 2000 });
      if (await isSuccessPage(page)) return 'applied';
      const success = await waitForSuccess(page, 3000);
      if (success) return 'applied';
      // Check for validation errors and fix
      const errors = await detectValidationErrors(page);
      if (errors.length > 0) {
        console.log(`    → BambooHR: validation errors (attempt ${attempt + 1}): ${errors.slice(0, 3).join('; ')}`);
        const fixed = await fixErrorFields(page);
        if (fixed > 0) console.log(`    → BambooHR: fixed ${fixed} error fields`);
        continue;
      }
      return 'incomplete';
    }
    break;
  }
  return 'incomplete';
}

// ─── SmartRecruiters ──────────────────────────────────────────────────────────
async function applySmartRecruiters(page) {
  await fillGenericByLabel(page);
  await uploadResume(page);
  return await walkForm(page);
}

// ─── iCIMS ────────────────────────────────────────────────────────────────────
async function applyiCIMS(page) {
  const guestBtn = await page.$('a:has-text("Apply as Guest"), button:has-text("Continue as Guest"), a:has-text("Guest")').catch(() => null);
  if (guestBtn) { await forceClick(guestBtn); await humanDelay(250, 500); }
  await fillGenericByLabel(page);
  await uploadResume(page);
  return await walkForm(page);
}

// ─── UltiPro / UKG ────────────────────────────────────────────────────────────
async function applyUltiPro(page) {
  await waitForPageStable(page, { maxWait: 800 });
  // UltiPro often requires clicking an "Apply" button first
  const applyBtn = await page.$([
    'a:has-text("Apply Now")', 'a:has-text("Apply")', 'button:has-text("Apply")',
    '[aria-label*="Apply"]',
  ].join(', ')).catch(() => null);
  if (applyBtn) { await forceClick(applyBtn); await waitForPageStable(page, { maxWait: 800 }); }

  // Try "Continue as Guest" if shown
  const guestBtn = await page.$('a:has-text("Guest"), button:has-text("Guest"), a:has-text("Continue without")')
    .catch(() => null);
  if (guestBtn) { await forceClick(guestBtn); await humanDelay(300, 600); }

  return await walkForm(page);
}

// ─── SAP SuccessFactors ────────────────────────────────────────────────────────
async function applySuccessFactors(page) {
  await waitForPageStable(page, { maxWait: 1000 });
  const applyBtn = await page.$('button:has-text("Apply"), a:has-text("Apply"), [title*="Apply"]').catch(() => null);
  if (applyBtn) { await forceClick(applyBtn); await waitForPageStable(page, { maxWait: 1000 }); }
  await fillGenericByLabel(page);
  await uploadResume(page);
  return await walkForm(page, 15);
}

// ─── Breezy HR ────────────────────────────────────────────────────────────────
async function applyBreezy(page) {
  const fill = async (sel, val) => {
    const el = await page.$(sel).catch(() => null);
    if (el) { const v = await el.inputValue().catch(() => ''); if (!v) await safeFill(el, val); }
  };
  await fill('input[name="name"]', FULL_NAME);
  await fill('input[name="email"], input[type="email"]', EMAIL);
  await fill('input[name="phone"]', PHONE);
  await fill('input[name="address"]', `${CITY}, India`);
  await fill('input[name="summary"]', COVER);
  await uploadResume(page);
  await fillGenericByLabel(page);
  return await walkForm(page);
}

// ─── Workable ─────────────────────────────────────────────────────────────────
async function applyWorkable(page) {
  await humanDelay(300, 600);
  const fill = async (sel, val) => {
    const el = await page.$(sel).catch(() => null);
    if (el) { const v = await el.inputValue().catch(() => ''); if (!v) await safeFill(el, val); }
  };
  await fill('input[name="firstname"]', FIRST_NAME);
  await fill('input[name="lastname"]', LAST_NAME);
  await fill('input[name="email"]', EMAIL);
  await fill('input[name="phone"]', PHONE);
  await fill('input[name="address"]', `${CITY}, India`);
  await uploadResume(page);
  await fillGenericByLabel(page);
  return await walkForm(page);
}

// ─── Recruitee ────────────────────────────────────────────────────────────────
async function applyRecruitee(page) {
  await humanDelay(300, 600);
  const fill = async (sel, val) => {
    const el = await page.$(sel).catch(() => null);
    if (el) { const v = await el.inputValue().catch(() => ''); if (!v) await safeFill(el, val); }
  };
  await fill('input[name="first_name"]', FIRST_NAME);
  await fill('input[name="last_name"]', LAST_NAME);
  await fill('input[name="email"]', EMAIL);
  await fill('input[name="phone"]', PHONE);
  await uploadResume(page);
  await fillGenericByLabel(page);
  return await walkForm(page);
}

// ─── Jobvite ─────────────────────────────────────────────────────────────────
async function applyJobvite(page) {
  await humanDelay(300, 600);
  const applyBtn = await page.$('a.jv-btn-apply, button.jv-btn-apply, a:has-text("Apply")').catch(() => null);
  if (applyBtn) { await forceClick(applyBtn); await humanDelay(300, 600); }
  await fillGenericByLabel(page);
  await uploadResume(page);
  return await walkForm(page);
}

// ─── Wellfound / AngelList ────────────────────────────────────────────────────
async function applyWellfound(page) {
  await humanDelay(300, 600);
  const applyBtn = await page.$('button:has-text("Apply"), a:has-text("Apply")').catch(() => null);
  if (applyBtn) { await forceClick(applyBtn); await humanDelay(300, 600); }
  const fill = async (sel, val) => {
    const el = await page.$(sel).catch(() => null);
    if (el) { const v = await el.inputValue().catch(() => ''); if (!v) await safeFill(el, val); }
  };
  await fill('input[name="firstName"], input[placeholder*="First"]', FIRST_NAME);
  await fill('input[name="lastName"],  input[placeholder*="Last"]',  LAST_NAME);
  await fill('input[name="email"], input[type="email"]', EMAIL);
  await fill('input[name="phone"]', PHONE);
  await uploadResume(page);
  await fillGenericByLabel(page);
  return await walkForm(page);
}

// ─── ContactHR ────────────────────────────────────────────────────────────────
async function applyContactHR(page) {
  await waitForPageStable(page, { maxWait: 800 });
  await fillGenericByLabel(page);
  await uploadResume(page);
  return await walkForm(page);
}

// ─── Generic walkForm ─────────────────────────────────────────────────────────
async function walkForm(page, maxSteps = 10) {
  let lastErrorSignature = '';
  let sameErrorCount = 0;

  for (let step = 0; step < maxSteps; step++) {
    await dismissCookieConsent(page);
    await checkAndPauseIfNeeded(page); // OTP / CAPTCHA / email verify

    if (await isSuccessPage(page)) {
      console.log('    → Application confirmed (success page)');
      return 'applied';
    }

    console.log(`    → walkForm step ${step + 1}: scroll-scanning full page...`);

    // Full page scroll + scan + fill (catches below-fold fields)
    const filled = await scrollScanAndFill(page);
    if (filled > 0) console.log(`    → Filled ${filled} fields via scroll-scan`);

    // AI fallback — if standard scan found nothing and AI is available
    if (filled === 0 && aiBrain.isAvailable()) {
      console.log(`    → AI: standard scan filled nothing, asking AI to analyze form...`);
      const aiActions = await aiBrain.aiAnalyzeFormFields(page);
      if (aiActions && aiActions.length > 0) {
        const aiExec = await aiBrain.executeAIActions(page, { actions: aiActions });
        if (aiExec > 0) console.log(`    → AI: executed ${aiExec} actions`);
      }
    }

    // Check for validation errors before navigation
    const errors = await detectValidationErrors(page);
    if (errors.length > 0) {
      const errSig = errors.slice(0, 5).sort().join('|');
      console.log(`    → Validation errors: ${errors.slice(0, 3).join('; ')}`);

      // Detect stuck loop
      if (errSig === lastErrorSignature) {
        sameErrorCount++;
        if (sameErrorCount >= 2) {
          console.log(`    → Same errors repeated ${sameErrorCount + 1} times — cannot resolve, giving up`);
          return 'incomplete';
        }
      } else {
        lastErrorSignature = errSig;
        sameErrorCount = 0;
      }

      // Fix error/required fields specifically
      const fixed = await fixErrorFields(page);
      if (fixed > 0) console.log(`    → Fixed ${fixed} error fields`);
    }

    // Click Next if available
    const nextBtn = await page.$([
      'button:has-text("Next")', 'button:has-text("Continue")',
      'button:has-text("Next step")', 'button:has-text("Next Step")',
      '[data-qa="btn-next"]', '[aria-label="Next"]',
      'a:has-text("Next")',
    ].join(', ')).catch(() => null);
    if (nextBtn && await nextBtn.isVisible().catch(() => false)) {
      await forceClick(nextBtn);
      await waitForPageStable(page, { maxWait: 800 });

      // Check if we're still on the same page (validation failed)
      const postErrors = await detectValidationErrors(page);
      if (postErrors.length > 0) {
        console.log(`    → Post-click errors: ${postErrors.slice(0, 3).join('; ')}`);
        const fixed = await fixErrorFields(page);
        if (fixed > 0) console.log(`    → Fixed ${fixed} error fields`);
        await humanDelay(150, 300);
        // Retry click
        await forceClick(nextBtn).catch(() => {});
        await humanDelay(300, 600);
      }

      await checkAndPauseIfNeeded(page);
      continue;
    }

    // Click submit
    const submitted = await clickSubmit(page);
    if (submitted) {
      await checkAndPauseIfNeeded(page); // some sites send OTP after submit
      const success = await waitForSuccess(page, 4000);
      if (success) {
        console.log('    → Application confirmed');
        return 'applied';
      }
      // One last check — maybe a verification step appeared
      await checkAndPauseIfNeeded(page);
      if (await isSuccessPage(page)) return 'applied';

      // Check if submit failed due to validation
      const submitErrors = await detectValidationErrors(page);
      if (submitErrors.length > 0) {
        const errSig = submitErrors.slice(0, 5).sort().join('|');
        console.log(`    → Submit failed: ${submitErrors.slice(0, 3).join('; ')}`);

        // Detect stuck loop — same errors repeating means we can't fix them
        if (errSig === lastErrorSignature) {
          sameErrorCount++;
          if (sameErrorCount >= 2) {
            console.log(`    → Same errors repeated ${sameErrorCount + 1} times — cannot resolve, giving up`);
            return 'incomplete';
          }
        } else {
          lastErrorSignature = errSig;
          sameErrorCount = 0;
        }

        // Fix error fields and continue looping
        const fixed = await fixErrorFields(page);
        if (fixed > 0) console.log(`    → Fixed ${fixed} error fields`);
        continue;
      }

      console.log('    → Submit clicked but no confirmation received');
      return 'incomplete';
    }

    break;
  }
  return 'incomplete';
}

// ─── applyGeneric ─────────────────────────────────────────────────────────────
async function applyGeneric(page) {
  await humanDelay(250, 500);
  await dismissCookieConsent(page);

  // Click any Apply button (LinkedIn OAuth already attempted in applyExternal)
  const applyBtn = await page.$([
    'a:has-text("Apply Now")', 'a:has-text("Apply now")', 'a:has-text("Apply")',
    'button:has-text("Apply Now")', 'button:has-text("Apply for this job")',
    'button:has-text("Apply")',
  ].join(', ')).catch(() => null);
  if (applyBtn && await applyBtn.isVisible().catch(() => false)) {
    await forceClick(applyBtn);
    await humanDelay(300, 600);
    await dismissCookieConsent(page);
  }

  // Try sign in if available
  const signInLink = await page.$([
    'a:has-text("Sign in")', 'a:has-text("Log in")', 'a:has-text("Login")',
    'button:has-text("Sign in")', 'button:has-text("Log in")',
  ].join(', ')).catch(() => null);
  if (signInLink && await signInLink.isVisible().catch(() => false)) {
    await forceClick(signInLink);
    await humanDelay(250, 500);
    const emailField = await page.$('input[type="email"], input[name*="email" i]').catch(() => null);
    if (emailField) {
      await safeFill(emailField, EMAIL);
      const passField = await page.$('input[type="password"]').catch(() => null);
      if (passField) {
        await safeFill(passField, PASSWORD);
        await clickSubmit(page);
        await waitForPageStable(page, { maxWait: 800 });
      }
    }
  }

  return await walkForm(page);
}

// ─── Deel ─────────────────────────────────────────────────────────────────────
async function applyDeel(page) {
  const applyBtn = await page.$('a:has-text("Apply"), button:has-text("Apply now"), a:has-text("Apply now")').catch(() => null);
  if (applyBtn) { await forceClick(applyBtn); await humanDelay(250, 500); }
  return await walkForm(page);
}

// ─── Weekday ─────────────────────────────────────────────────────────────────
async function applyWeekday(page) {
  const applyBtn = await page.$('button:has-text("Apply"), a:has-text("Apply"), button:has-text("Express Interest")').catch(() => null);
  if (applyBtn) { await forceClick(applyBtn); await humanDelay(250, 500); await dismissCookieConsent(page); }
  await fillGenericByLabel(page);
  await uploadResume(page);
  return await walkForm(page);
}

// ─── Uplers ───────────────────────────────────────────────────────────────────
async function applyUplers(page) {
  // Uplers requires platform login — try to authenticate
  const loginBtn = await page.$('a:has-text("Login"), button:has-text("Login"), a:has-text("Sign In")').catch(() => null);
  if (loginBtn) {
    await forceClick(loginBtn);
    await humanDelay(300, 600);
    const emailField = await page.$('input[type="email"], input[name*="email" i]').catch(() => null);
    if (emailField) {
      await safeFill(emailField, EMAIL);
      const passField = await page.$('input[type="password"]').catch(() => null);
      if (passField) {
        await safeFill(passField, PASSWORD);
        await clickSubmit(page);
        await waitForPageStable(page, { maxWait: 1000 });
      }
    }
  }
  // Check for "Apply" / "Express Interest" button
  const applyBtn = await page.$('button:has-text("Apply"), button:has-text("Express Interest"), a:has-text("Apply")').catch(() => null);
  if (applyBtn) { await forceClick(applyBtn); await humanDelay(250, 500); }
  return await walkForm(page);
}

// ─── Rippling ─────────────────────────────────────────────────────────────────
async function applyRippling(page) {
  await waitForPageStable(page, { maxWait: 800 });
  await fillGenericByLabel(page);
  await uploadResume(page);
  return await walkForm(page);
}

// ─── Main Entry ───────────────────────────────────────────────────────────────

async function applyExternal(page, externalUrl) {
  try {
    // Validate URL
    if (!externalUrl || !externalUrl.startsWith('http')) {
      console.log(`    → Invalid external URL: ${externalUrl}`);
      return 'error';
    }

    // Check if page is still alive
    try { await page.evaluate(() => true); } catch {
      console.log('    → Page is dead, cannot apply externally');
      return 'error';
    }

    // Navigate with retry
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await page.goto(externalUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
        break;
      } catch (err) {
        if (attempt === 1) {
          console.error(`    → Failed to load: ${err.message.split('\n')[0]}`);
          return 'error';
        }
        console.log('    → Page load retry...');
        await waitForPageStable(page, { maxWait: 2000 });
      }
    }
    await waitForPageStable(page, { maxWait: 800 });

    // Check for error pages / blocked / 404 / access denied
    const pageTitle = await page.title().catch(() => '');
    const pageUrl = page.url();
    if (/404|not found|access denied|forbidden|blocked|error/i.test(pageTitle)
      || pageUrl === 'about:blank' || pageUrl.startsWith('chrome-error')) {
      console.log(`    → Error page: ${pageTitle || pageUrl}`);
      return 'error';
    }

    await dismissCookieConsent(page);

    const finalUrl = page.url();
    const ats = detectATS(finalUrl);
    console.log(`    → ATS: ${ats} | ${finalUrl.substring(0, 80)}`);

    // Check for verification / CAPTCHA immediately after page load
    await checkAndPauseIfNeeded(page);

    // Try LinkedIn OAuth on ANY site — works on Greenhouse, Lever, Ashby, SmartRecruiters, Workable, etc.
    const linkedInUsed = await applyWithLinkedIn(page).catch(() => false);
    if (linkedInUsed) {
      await waitForPageStable(page, { maxWait: 1000 });
      await checkAndPauseIfNeeded(page);
      if (await isSuccessPage(page)) {
        console.log('    → Applied via LinkedIn OAuth');
        console.log('    → External result: applied');
        return 'applied';
      }
    }

    let result;
    try {
      switch (ats) {
        case 'greenhouse':          result = await applyGreenhouse(page); break;
        case 'greenhouse-embed':    result = await applyGreenhouseEmbedded(page, finalUrl); break;
        case 'lever':               result = await applyLever(page); break;
        case 'smartrecruiters':     result = await applySmartRecruiters(page); break;
        case 'workday':             result = await applyWorkday(page); break;
        case 'ashby':               result = await applyAshby(page); break;
        case 'bamboohr':            result = await applyBambooHR(page); break;
        case 'icims':               result = await applyiCIMS(page); break;
        case 'weekday':             result = await applyWeekday(page); break;
        case 'deel':                result = await applyDeel(page); break;
        case 'uplers':              result = await applyUplers(page); break;
        case 'ultipro':             result = await applyUltiPro(page); break;
        case 'successfactors':      result = await applySuccessFactors(page); break;
        case 'breezy':              result = await applyBreezy(page); break;
        case 'workable':            result = await applyWorkable(page); break;
        case 'recruitee':           result = await applyRecruitee(page); break;
        case 'jobvite':             result = await applyJobvite(page); break;
        case 'wellfound':           result = await applyWellfound(page); break;
        case 'contacthr':           result = await applyContactHR(page); break;
        case 'rippling':            result = await applyRippling(page); break;
        default:                    result = await applyGeneric(page);
      }
    } catch (handlerErr) {
      const msg = handlerErr.message || '';
      if (msg.includes('Target closed') || msg.includes('disposed') || msg.includes('crashed')) {
        console.error(`    → Page crashed during ${ats} handler`);
        return 'error';
      }
      console.error(`    → ${ats} handler error: ${msg.split('\n')[0]}`);
      // If the ATS-specific handler crashed, try generic as fallback
      if (ats !== 'generic') {
        console.log('    → Falling back to generic handler...');
        try {
          result = await applyGeneric(page);
        } catch { result = 'error'; }
      } else {
        result = 'error';
      }
    }

    // AI full-page analysis as last resort when result is incomplete
    if (result === 'incomplete' && aiBrain.isAvailable()) {
      console.log('    → AI: attempting full-page analysis as last resort...');
      try {
        const aiAnalysis = await aiBrain.analyzePageForApply(page);
        if (aiAnalysis) {
          if (aiAnalysis.pageType === 'success') {
            console.log('    → AI: detected this is a success page!');
            result = 'applied';
          } else if (aiAnalysis.actions && aiAnalysis.actions.length > 0) {
            const aiExec = await aiBrain.executeAIActions(page, aiAnalysis);
            if (aiExec > 0) {
              console.log(`    → AI: executed ${aiExec} final actions`);
              await waitForPageStable(page, { maxWait: 2000 });
              if (await isSuccessPage(page)) result = 'applied';
            }
          }
        }
      } catch {}
    }

    console.log(`    → External result: ${result}`);
    return result;
  } catch (err) {
    const msg = err.message || '';
    if (msg.includes('Target closed') || msg.includes('disposed')) {
      console.error('    → Page closed unexpectedly');
    } else {
      console.error(`    → External apply error: ${msg.split('\n')[0]}`);
    }
    return 'error';
  }
}

module.exports = { applyExternal, detectATS, setProfile };
