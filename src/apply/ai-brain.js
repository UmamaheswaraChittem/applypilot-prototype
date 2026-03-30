/**
 * AI Brain — uses Claude API to analyze pages and make intelligent decisions.
 * Used as a fallback when hardcoded selectors fail.
 */
require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const Anthropic = require('@anthropic-ai/sdk');
const { humanDelay } = require('../stealth');

const API_KEY = process.env.ANTHROPIC_API_KEY;
let client = null;

function getClient() {
  if (!API_KEY) return null;
  if (!client) client = new Anthropic({ apiKey: API_KEY });
  return client;
}

const { loadProfile, generateCoverLetter } = require('../profile');
const _p = loadProfile();
const PROFILE = {
  fullName: _p.fullName,
  firstName: _p.firstName,
  lastName: _p.lastName,
  email: _p.email,
  phone: _p.phone,
  city: _p.city,
  country: _p.country,
  expectedCtc: String(_p.expectedCtcLPA),
  noticeDays: String(_p.noticeDays),
  experience: `${_p.totalExperience} years`,
  currentTitle: _p.currentTitle,
  currentEmployer: _p.currentCompany,
  linkedin: _p.linkedinUrl || `https://www.linkedin.com/in/${_p.firstName.toLowerCase()}-${_p.lastName.toLowerCase()}`,
  skills: _p.skills.join(', '),
  coverLetter: generateCoverLetter(_p),
};

/**
 * Extract a compact text representation of the page for AI analysis.
 * Captures interactive elements, labels, and visible text — not the full DOM.
 */
async function extractPageContext(page) {
  return await page.evaluate(() => {
    const result = [];
    const MAX_LEN = 6000; // keep under token limit

    // Gather all interactive elements and their context
    const els = document.querySelectorAll(
      'a, button, input, select, textarea, [role="button"], [role="link"], [role="combobox"], [role="listbox"], [tabindex]'
    );

    for (const el of els) {
      const style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden') continue;
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) continue;

      const tag = el.tagName.toLowerCase();
      const type = el.type || '';
      const id = el.id || '';
      const name = el.name || '';
      const text = (el.innerText || '').trim().substring(0, 80);
      const href = el.href || '';
      const placeholder = el.placeholder || '';
      const ariaLabel = el.getAttribute('aria-label') || '';
      const value = el.value || '';
      const disabled = el.disabled;
      const required = el.required || el.getAttribute('aria-required') === 'true';
      const autoId = el.getAttribute('data-automation-id') || '';

      // Get associated label
      let label = '';
      if (id) {
        const lbl = document.querySelector(`label[for="${CSS.escape(id)}"]`);
        if (lbl) label = lbl.innerText.trim().substring(0, 60);
      }
      if (!label) {
        let parent = el.parentElement;
        for (let i = 0; i < 3 && parent; i++) {
          const lbl = parent.querySelector('label, legend, [class*="label"]');
          if (lbl && lbl !== el) { label = lbl.innerText.trim().substring(0, 60); break; }
          parent = parent.parentElement;
        }
      }

      // Build compact string
      let line = `<${tag}`;
      if (type) line += ` type="${type}"`;
      if (id) line += ` id="${id.substring(0, 40)}"`;
      if (name) line += ` name="${name.substring(0, 40)}"`;
      if (autoId) line += ` data-automation-id="${autoId.substring(0, 40)}"`;
      if (ariaLabel) line += ` aria-label="${ariaLabel.substring(0, 50)}"`;
      if (placeholder) line += ` placeholder="${placeholder.substring(0, 40)}"`;
      if (required) line += ' required';
      if (disabled) line += ' disabled';
      if (value && tag !== 'button' && tag !== 'a') line += ` value="${value.substring(0, 30)}"`;
      if (text && (tag === 'a' || tag === 'button')) line += `>${text}`;
      if (href && tag === 'a') line += ` href="${href.substring(0, 80)}"`;
      if (label) line += ` [LABEL: ${label}]`;

      // For select, show options
      if (tag === 'select') {
        const opts = [...el.options].slice(0, 8).map(o => o.text.trim().substring(0, 30));
        if (opts.length) line += ` OPTIONS=[${opts.join('|')}]`;
      }

      line += '>';
      result.push(line);

      if (result.join('\n').length > MAX_LEN) break;
    }

    // Also get page title and any headings
    const title = document.title || '';
    const h1 = document.querySelector('h1');
    const h1Text = h1 ? h1.innerText.trim().substring(0, 100) : '';

    return {
      url: window.location.href,
      title,
      heading: h1Text,
      elements: result.join('\n'),
    };
  }).catch(() => ({ url: '', title: '', heading: '', elements: '' }));
}

/**
 * Ask AI to analyze a page and decide what to do.
 * Returns structured actions: { action, selector, value, fields, explanation }
 */
async function analyzePageForApply(page) {
  const ai = getClient();
  if (!ai) return null;

  const ctx = await extractPageContext(page);
  if (!ctx.elements) return null;

  try {
    const response = await ai.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1500,
      messages: [{
        role: 'user',
        content: `You are a job application automation assistant. Analyze this page and tell me what to do.

PAGE URL: ${ctx.url}
PAGE TITLE: ${ctx.title}
HEADING: ${ctx.heading}

INTERACTIVE ELEMENTS ON PAGE:
${ctx.elements}

MY PROFILE:
- Name: ${PROFILE.fullName}
- Email: ${PROFILE.email}
- Phone: ${PROFILE.phone}
- Location: ${PROFILE.city}, ${PROFILE.country}
- Experience: ${PROFILE.experience}
- Skills: ${PROFILE.skills}

TASK: I want to apply to this job. Return a JSON response with the actions needed.

Response format (STRICT JSON only, no markdown):
{
  "pageType": "job_listing|application_form|login_page|success|error|other",
  "actions": [
    {"action": "click", "selector": "CSS_SELECTOR", "description": "what this does"},
    {"action": "fill", "selector": "CSS_SELECTOR", "value": "VALUE_TO_TYPE", "description": "field name"},
    {"action": "select", "selector": "CSS_SELECTOR", "value": "OPTION_TEXT", "description": "dropdown name"},
    {"action": "check", "selector": "CSS_SELECTOR", "description": "checkbox description"}
  ],
  "applyButtonSelector": "CSS selector for the main apply/submit button, or null",
  "explanation": "brief explanation of what you see and recommend"
}

Rules:
- For "click" actions: prefer CSS selectors using id, data-automation-id, aria-label, or text content
- For "fill" actions: use my profile data. Phone format: ${PROFILE.phone}
- For "select" actions: pick the best matching option from the visible OPTIONS
- Order actions logically (fill form → click submit)
- If this is a success/thank-you page, set pageType to "success" with empty actions
- If there's an Apply button, always include its selector in applyButtonSelector
- Keep it concise — max 15 actions`
      }],
    });

    const text = response.content[0]?.text || '';
    // Extract JSON from response (handle potential markdown wrapping)
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;

    const parsed = JSON.parse(jsonMatch[0]);
    console.log(`    → AI brain: ${parsed.pageType} — ${parsed.explanation?.substring(0, 80) || 'no explanation'}`);
    return parsed;
  } catch (err) {
    console.log(`    → AI brain error: ${err.message?.substring(0, 60) || 'unknown'}`);
    return null;
  }
}

/**
 * Execute AI-recommended actions on a page.
 * Returns number of actions successfully executed.
 */
async function executeAIActions(page, analysis) {
  if (!analysis || !analysis.actions || !Array.isArray(analysis.actions)) return 0;

  let executed = 0;
  for (const action of analysis.actions) {
    try {
      if (!action.selector) continue;

      if (action.action === 'click') {
        const el = await page.$(action.selector).catch(() => null);
        if (el && await el.isVisible().catch(() => false)) {
          await el.scrollIntoViewIfNeeded().catch(() => {});
          await el.click({ timeout: 3000 }).catch(async () => {
            await page.evaluate(s => document.querySelector(s)?.click(), action.selector);
          });
          executed++;
          await humanDelay(150, 300);
          console.log(`    → AI: clicked "${action.description || action.selector}"`);
        }
      } else if (action.action === 'fill') {
        const el = await page.$(action.selector).catch(() => null);
        if (el && await el.isVisible().catch(() => false)) {
          const current = await el.inputValue().catch(() => '');
          if (!current) {
            await el.fill('').catch(() => {});
            await el.type(action.value || '', { delay: 20 }).catch(() => el.fill(action.value || ''));
            executed++;
            console.log(`    → AI: filled "${action.description || action.selector}" = ${(action.value || '').substring(0, 20)}`);
          }
        }
      } else if (action.action === 'select') {
        const el = await page.$(action.selector).catch(() => null);
        if (el) {
          // Try selecting by visible text
          const options = await el.$$('option');
          for (const opt of options) {
            const optText = await opt.innerText().catch(() => '');
            if (optText.toLowerCase().includes((action.value || '').toLowerCase())) {
              await el.selectOption({ label: optText }).catch(() => {});
              executed++;
              console.log(`    → AI: selected "${action.description || ''}" = ${optText.substring(0, 30)}`);
              break;
            }
          }
        }
      } else if (action.action === 'check') {
        const el = await page.$(action.selector).catch(() => null);
        if (el) {
          await el.check().catch(() => el.click());
          executed++;
          console.log(`    → AI: checked "${action.description || action.selector}"`);
        }
      }
    } catch (err) {
      // Silently skip failed actions
    }
  }

  return executed;
}

/**
 * AI-powered "find apply button" — when standard selectors fail.
 */
async function aiFindApplyButton(page) {
  const ai = getClient();
  if (!ai) return null;

  const ctx = await extractPageContext(page);
  if (!ctx.elements) return null;

  try {
    const response = await ai.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 300,
      messages: [{
        role: 'user',
        content: `Find the "Apply" or "Easy Apply" button on this job page. Return ONLY a JSON object.

PAGE: ${ctx.url}
TITLE: ${ctx.title}

ELEMENTS:
${ctx.elements}

Return: {"selector": "CSS_SELECTOR_FOR_APPLY_BUTTON", "type": "easy_apply|external|none", "text": "button text"}
If no apply button exists, return: {"selector": null, "type": "none", "text": null}`
      }],
    });

    const text = response.content[0]?.text || '';
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;
    return JSON.parse(jsonMatch[0]);
  } catch {
    return null;
  }
}

/**
 * AI-powered form field analysis — when standard ANSWER_MAP doesn't match.
 */
async function aiAnalyzeFormFields(page) {
  const ai = getClient();
  if (!ai) return null;

  const ctx = await extractPageContext(page);
  if (!ctx.elements) return null;

  try {
    const response = await ai.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1500,
      messages: [{
        role: 'user',
        content: `Analyze this job application form and tell me how to fill each field.

MY PROFILE:
- Full Name: ${PROFILE.fullName} | First: ${PROFILE.firstName} | Last: ${PROFILE.lastName}
- Email: ${PROFILE.email} | Phone: ${PROFILE.phone}
- Location: ${PROFILE.city}, ${PROFILE.country} (Pin: 500081)
- Expected CTC: ${PROFILE.expectedCtc} LPA | Notice: ${PROFILE.noticeDays} days
- Experience: ${PROFILE.experience} | Title: ${PROFILE.currentTitle}
- Employer: ${PROFILE.currentEmployer}
- LinkedIn: ${PROFILE.linkedin}
- Work Authorization: Authorized to work in India, no visa sponsorship needed

FORM ELEMENTS:
${ctx.elements}

Return STRICT JSON array of actions:
[
  {"action": "fill", "selector": "CSS_SELECTOR", "value": "VALUE"},
  {"action": "select", "selector": "CSS_SELECTOR", "value": "OPTION_TEXT"},
  {"action": "check", "selector": "CSS_SELECTOR"},
  {"action": "click", "selector": "CSS_SELECTOR"}
]

Rules:
- Only include fields that are EMPTY (no existing value)
- For dropdowns, pick from the available OPTIONS listed
- For yes/no questions about work authorization: Yes
- For visa sponsorship questions: No (don't need sponsorship)
- For gender/race/veteran/disability: "Prefer not to answer" or "Decline"
- For phone device type: Mobile
- For country: India
- IMPORTANT: Include the submit/next button click at the end if visible`
      }],
    });

    const text = response.content[0]?.text || '';
    const jsonMatch = text.match(/\[[\s\S]*\]/);
    if (!jsonMatch) return null;
    return JSON.parse(jsonMatch[0]);
  } catch {
    return null;
  }
}

function isAvailable() {
  return !!API_KEY;
}

module.exports = {
  isAvailable,
  extractPageContext,
  analyzePageForApply,
  executeAIActions,
  aiFindApplyButton,
  aiAnalyzeFormFields,
};
