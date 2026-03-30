/**
 * Universal Form Filler — works on ANY job application page
 * Handles LinkedIn Easy Apply, Workday, Greenhouse, Lever, SmartRecruiters, iCIMS, etc.
 *
 * Strategy: scan ALL visible form fields, extract context from labels/placeholders/aria,
 * match against profile data, fill intelligently.
 */
const fs = require('fs');
const path = require('path');
const { humanDelay, humanClick } = require('./stealth');
const { getExperienceYears, generateCoverLetter } = require('./profile');

// ─── Context Extraction ──────────────────────────────────────────────────────

async function getFieldContext(page, el) {
  try {
    const id = (await el.getAttribute('id') || '').toLowerCase();
    const name = (await el.getAttribute('name') || '').toLowerCase();
    const placeholder = (await el.getAttribute('placeholder') || '').toLowerCase();
    const ariaLabel = (await el.getAttribute('aria-label') || '').toLowerCase();
    const autoId = (await el.getAttribute('data-automation-id') || '').toLowerCase();
    const testId = (await el.getAttribute('data-testid') || '').toLowerCase();
    const type = (await el.getAttribute('type') || 'text').toLowerCase();

    // Get label text
    let labelText = '';
    try {
      const elId = await el.getAttribute('id');
      if (elId) {
        const lbl = await page.$(`label[for="${elId.replace(/([^\w-])/g, '\\\\$1')}"]`).catch(() => null);
        if (lbl) labelText = (await lbl.innerText().catch(() => '')).toLowerCase();
      }
      if (!labelText) {
        const ariaLabelledBy = await el.getAttribute('aria-labelledby');
        if (ariaLabelledBy) {
          const lblEl = await page.$(`#${ariaLabelledBy.replace(/([^\w-])/g, '\\\\$1')}`).catch(() => null);
          if (lblEl) labelText = (await lblEl.innerText().catch(() => '')).toLowerCase();
        }
      }
      if (!labelText) {
        labelText = await el.evaluate(e => {
          let p = e.parentElement;
          for (let i = 0; i < 6 && p; i++) {
            const lbl = p.querySelector('label, legend, [class*="label" i], h3, h4, strong');
            if (lbl && lbl.innerText?.trim().length > 2) return lbl.innerText.trim().toLowerCase();
            p = p.parentElement;
          }
          return '';
        }).catch(() => '');
      }
    } catch {}

    const ctx = [id, name, placeholder, ariaLabel, autoId, testId, labelText].join(' ').replace(/\s+/g, ' ').trim();
    return { ctx, id, name, placeholder, ariaLabel, autoId, testId, labelText, type };
  } catch {
    return { ctx: '', id: '', name: '', placeholder: '', ariaLabel: '', autoId: '', testId: '', labelText: '', type: 'text' };
  }
}

// ─── Field Matchers (ordered by priority) ────────────────────────────────────

function matchField(ctx, type) {
  const c = ctx.toLowerCase();

  // Contact
  if (/phone|mobile|contact.*number|cell.*number|telephone/i.test(c) && !/country.*code/i.test(c)) return 'phone';
  if (/email/i.test(c) && !/notification|alert|subscribe/i.test(c)) return 'email';

  // Name
  if (/first\s*name|given\s*name|fname/i.test(c)) return 'firstName';
  if (/last\s*name|family\s*name|surname|lname/i.test(c)) return 'lastName';
  if (/full\s*name|your\s*name|candidate\s*name/i.test(c) && !/company|employer/i.test(c)) return 'fullName';

  // Location (exclude words containing 'city' like ethnicity, publicity)
  if (/\bcity\b|location|current.*city|preferred.*location/i.test(c) && !/company|employer|ethnic/i.test(c)) return 'city';
  if (/state|province/i.test(c) && !/united\s*states/i.test(c)) return 'state';
  if (/country(?!.*code)/i.test(c) && !/phone/i.test(c)) return 'country';
  if (/pincode|zip\s*code|postal\s*code/i.test(c)) return 'pincode';
  if (/address\b/i.test(c) && !/email|ip|web/i.test(c)) return 'address';

  // Company / employer
  if (/company.*name|employer|organization|current.*company|recent.*employer|most\s*recent\s*company/i.test(c)) return 'currentCompany';
  if (/current.*title|job.*title|designation|position.*title|current.*role/i.test(c)) return 'currentTitle';

  // URLs
  if (/linkedin\s*profile|linkedin\s*url|linkedin\.com/i.test(c)) return 'linkedinUrl';
  if (/github|portfolio|website|personal.*url|blog/i.test(c) && !/linkedin/i.test(c)) return 'portfolioUrl';

  // Experience (BEFORE salary to avoid "experience with salary systems")
  if (/experience.*year|years.*experience|total.*experience|relevant.*experience|how\s*many\s*years/i.test(c)) return 'experience';
  if (/experience/i.test(c) && (type === 'number' || /\bnumber\b|how\s*many/i.test(c))) return 'experience';

  // Salary / CTC
  if (/salary|ctc|compensation|expected.*package|current.*package|lpa|annual.*pay/i.test(c) && !/experience/i.test(c)) return 'salary';
  if (/rate.*hour|hourly.*rate|per\s*hour/i.test(c)) return 'hourlyRate';

  // Notice period
  if (/notice\s*period|joining.*time|availability|earliest.*start|start.*date/i.test(c)) return 'noticePeriod';

  // Education
  if (/degree|education.*level|qualification|highest.*education/i.test(c)) return 'degree';
  if (/university|college|school|institution|alma\s*mater/i.test(c)) return 'university';
  if (/gpa|cgpa|percentage|grade|marks/i.test(c)) return 'gpa';

  // Work authorization
  if (/authorized.*work|work.*auth|legal.*right|eligible.*work|right\s*to\s*work/i.test(c)) return 'workAuth';
  if (/sponsor|visa\s*sponsor|immigration\s*sponsor/i.test(c)) return 'sponsorship';
  if (/relocat/i.test(c)) return 'relocation';

  // Demographics (should answer decline/no)
  if (/veteran/i.test(c)) return 'veteran';
  if (/disabilit|handicap|accommodat/i.test(c)) return 'disability';
  if (/gender|sex(?!perience)/i.test(c)) return 'gender';
  if (/race|ethnic/i.test(c)) return 'ethnicity';

  // Cover letter / additional
  if (/cover\s*letter|additional\s*info|tell\s*us\s*about|why\s*(are\s*you\s*)?interested|message\s*to\s*hiring|why\s*do\s*you\s*want|motivation|what\s*excites\s*you/i.test(c)) return 'coverLetter';
  if (/how\s*did\s*you\s*hear|source|referral|where\s*did\s*you\s*find/i.test(c)) return 'hearAbout';

  // Age / DOB
  if (/\bage\b/i.test(c) && !/page|stage|manage|package/i.test(c)) return 'age';
  if (/date.*birth|dob|birth.*date/i.test(c)) return 'dob';

  // Fallback for number type
  if (type === 'number') return 'genericNumber';
  return null;
}

// ─── Fill a single field ─────────────────────────────────────────────────────

async function fillField(page, el, fieldType, profile) {
  try {
    const { ctx, type } = await getFieldContext(page, el);

    switch (fieldType) {
      case 'phone': await el.fill(profile.phone); break;
      case 'email': await el.fill(profile.email); break;
      case 'firstName': await el.fill(profile.firstName); break;
      case 'lastName': await el.fill(profile.lastName); break;
      case 'fullName': await el.fill(profile.fullName); break;
      case 'city':
        await el.fill(profile.city);
        await humanDelay(600, 1000);
        // Handle typeahead
        const sug = await page.$('[role="option"], [role="listbox"] li, [class*="suggestion"], [class*="dropdown"] li').catch(() => null);
        if (sug && await sug.isVisible().catch(() => false)) await humanClick(page, sug);
        else {
          await humanDelay(400, 600);
          const sug2 = await page.$('[role="option"], [role="listbox"] li').catch(() => null);
          if (sug2 && await sug2.isVisible().catch(() => false)) await humanClick(page, sug2);
        }
        break;
      case 'state': await el.fill(profile.state); break;
      case 'country': await el.fill(profile.country); break;
      case 'pincode': await el.fill(profile.pincode); break;
      case 'address': await el.fill(`${profile.city}, ${profile.state}, ${profile.country}`); break;
      case 'currentCompany': await el.fill(profile.currentCompany); break;
      case 'currentTitle': await el.fill(profile.currentTitle); break;
      case 'linkedinUrl': await el.fill(profile.linkedinUrl || `https://www.linkedin.com/in/${profile.firstName.toLowerCase()}-${profile.lastName.toLowerCase()}`); break;
      case 'portfolioUrl': await el.fill(profile.githubUrl || profile.portfolioUrl || `https://github.com/${profile.firstName.toLowerCase()}-${profile.lastName.toLowerCase()}`); break;
      case 'experience': {
        const specific = getExperienceYears(profile, ctx);
        await el.fill(String(specific || profile.totalExperience));
        break;
      }
      case 'salary': {
        const ctcVal = /\binr\b|per\s*annum|annual|rupee/i.test(ctx) ? profile.expectedCtcLPA * 100000 : profile.expectedCtcLPA;
        await el.fill(String(ctcVal));
        break;
      }
      case 'hourlyRate': await el.fill('2500'); break;
      case 'noticePeriod': await el.fill(String(profile.noticeDays)); break;
      case 'degree': await el.fill(profile.degree); break;
      case 'university': await el.fill(profile.university || 'University'); break;
      case 'gpa': await el.fill('75'); break;
      case 'age': await el.fill(String(profile.age)); break;
      case 'dob': await el.fill(profile.dob || '1998-01-15'); break;
      case 'hearAbout': await el.fill('LinkedIn'); break;
      case 'genericNumber': await el.fill(String(profile.totalExperience)); break;
      default: break;
    }
  } catch {}
}

// ─── Main: Fill ALL visible form fields on current page ──────────────────────

async function fillAllFields(page, profile) {
  // ── Text/Number/Email/Tel inputs ──
  const inputs = await page.$$('input:visible');
  for (const input of inputs) {
    try {
      const { ctx, type } = await getFieldContext(page, input);
      if (['hidden', 'file', 'radio', 'checkbox', 'submit', 'button', 'search', 'image'].includes(type)) continue;
      const val = await input.inputValue().catch(() => '');
      if (val?.trim()) continue; // Already filled

      const fieldType = matchField(ctx, type);
      if (fieldType) {
        await fillField(page, input, fieldType, profile);
      } else {
        // Last resort: fill required fields with experience number
        const isReq = await input.getAttribute('required') !== null || await input.getAttribute('aria-required') === 'true';
        if (isReq) {
          if (type === 'number') await input.fill(String(profile.totalExperience));
          else await input.fill(String(profile.totalExperience));
        }
      }
    } catch {}
  }

  // ── Resume Upload ──
  if (profile.resumePath && fs.existsSync(profile.resumePath)) {
    for (const input of await page.$$('input[type="file"]')) {
      try {
        const accept = (await input.getAttribute('accept') || '').toLowerCase();
        const name = (await input.getAttribute('name') || '').toLowerCase();
        const isResume = !accept || accept.includes('pdf') || accept.includes('doc') || accept.includes('*');
        const notImage = !accept.includes('image') && !name.includes('photo');
        if (isResume && notImage) await input.setInputFiles(profile.resumePath);
      } catch {}
    }
  }

  // ── Radio Buttons ──
  await fillRadioButtons(page, profile);

  // ── Dropdowns ──
  await fillDropdowns(page, profile);

  // ── Checkbox Groups ──
  await fillCheckboxes(page, profile);

  // ── Textareas ──
  for (const ta of await page.$$('textarea:visible')) {
    try {
      const val = await ta.inputValue();
      if (val?.trim()) continue;
      await ta.fill(generateCoverLetter(profile));
    } catch {}
  }
}

// ─── Radio Buttons ───────────────────────────────────────────────────────────

async function fillRadioButtons(page, profile) {
  // Fieldset-based groups
  for (const group of await page.$$('fieldset:visible, [role="radiogroup"]:visible')) {
    try {
      const radios = await group.$$('input[type="radio"]');
      if (!radios.length) continue;
      let anyChecked = false;
      for (const r of radios) { if (await r.isChecked().catch(() => false)) { anyChecked = true; break; } }
      if (anyChecked) continue;

      const legendEl = await group.$('legend, label, h3, h4, [class*="label"]');
      const legend = legendEl ? (await legendEl.innerText().catch(() => '')).toLowerCase() : '';

      // Determine ideal answer based on question context
      const idealAnswer = getIdealRadioAnswer(legend, profile);
      await selectRadioByAnswer(page, radios, idealAnswer);
    } catch {}
  }

  // Standalone radio groups (by name attribute)
  const allRadios = await page.$$('input[type="radio"]:visible');
  const byName = {};
  for (const r of allRadios) {
    const name = await r.getAttribute('name').catch(() => '') || await r.getAttribute('id').catch(() => '') || 'unknown';
    if (!byName[name]) byName[name] = [];
    byName[name].push(r);
  }
  for (const [, radios] of Object.entries(byName)) {
    try {
      let anyChecked = false;
      for (const r of radios) { if (await r.isChecked().catch(() => false)) { anyChecked = true; break; } }
      if (anyChecked) continue;

      const questionCtx = await radios[0].evaluate(el => {
        let p = el.parentElement;
        for (let i = 0; i < 8 && p; i++) {
          const lbl = p.querySelector('legend, h3, h4, label, span[class*="label"], [class*="question"]');
          if (lbl && lbl.innerText?.trim().length > 5) return lbl.innerText.trim();
          p = p.parentElement;
        }
        return '';
      }).catch(() => '');

      const idealAnswer = getIdealRadioAnswer(questionCtx, profile);
      await selectRadioByAnswer(page, radios, idealAnswer);
    } catch {}
  }
}

function getIdealRadioAnswer(question, profile) {
  const q = question.toLowerCase();
  // "No" answers
  if (/sponsor|visa\s*sponsor|immigration|require.*sponsor/i.test(q)) return profile.requiresSponsorship ? 'yes' : 'no';
  if (/disability|handicap|accommodat/i.test(q)) return 'no';
  if (/veteran/i.test(q)) return 'no';
  if (/gender|sex(?!perience)/i.test(q)) return 'decline';
  if (/race|ethnic/i.test(q)) return 'decline';
  if (/criminal|felony|convicted/i.test(q)) return 'no';
  if (/non.?compete|restrictive.*covenant/i.test(q)) return 'no';
  // "Yes" answers
  if (/authorized.*work|legal.*right|eligible.*work|right\s*to\s*work|lawfully|permit/i.test(q)) return 'yes';
  if (/willing.*relocat|open.*relocat/i.test(q)) return profile.willingToRelocate ? 'yes' : 'no';
  if (/willing.*travel/i.test(q)) return 'yes';
  if (/comfortable.*work|comfortable.*commut|hybrid|onsite|on.?site|remote/i.test(q)) return 'yes';
  if (/18\s*years|over\s*18|legal\s*age/i.test(q)) return 'yes';
  if (/agree|consent|acknowledge|confirm|certif/i.test(q)) return 'yes';
  if (/open\s*to\s*contract|contract.*opportunit/i.test(q)) return 'yes';
  // Default: yes
  return 'yes';
}

async function selectRadioByAnswer(page, radios, idealAnswer) {
  let target = radios[0]; // fallback
  for (const r of radios) {
    try {
      const rid = await r.getAttribute('id') || '';
      let lbl = '';
      if (rid) {
        const lblEl = await page.$(`label[for="${rid.replace(/([^\w-])/g, '\\\\$1')}"]`).catch(() => null);
        if (lblEl) lbl = (await lblEl.innerText().catch(() => '')).toLowerCase();
      }
      if (!lbl) lbl = (await r.getAttribute('aria-label') || '').toLowerCase();
      if (!lbl) lbl = (await r.getAttribute('value') || '').toLowerCase();

      if (idealAnswer === 'yes' && /\byes\b/i.test(lbl)) { target = r; break; }
      if (idealAnswer === 'no' && /\bno\b/i.test(lbl)) { target = r; break; }
      if (idealAnswer === 'decline' && /decline|prefer\s*not|not\s*disclose|not\s*specified/i.test(lbl)) { target = r; break; }
    } catch {}
  }
  await target.check().catch(async () => {
    try { await target.click({ force: true }); } catch {
      try { await target.evaluate(e => e.click()); } catch {}
    }
  });
}

// ─── Dropdowns ───────────────────────────────────────────────────────────────

async function fillDropdowns(page, profile) {
  for (const sel of await page.$$('select:visible')) {
    try {
      const val = await sel.inputValue();
      const selectedText = await sel.$eval('option:checked', o => o.innerText?.trim() || '').catch(() => '');
      const isPlaceholder = !val || val === '' || /select|choose|pick|please|--/i.test(selectedText);
      if (!isPlaceholder) continue;

      const { ctx } = await getFieldContext(page, sel);
      const opts = await sel.$$('option');
      if (opts.length <= 1) continue;

      if (/experience|years/i.test(ctx)) {
        await selectBestExperienceOption(sel, opts, profile.totalExperience);
      } else if (/country/i.test(ctx)) {
        await selectOptionByText(sel, opts, /india/i) || await selectNonPlaceholder(sel, opts);
      } else if (/gender|sex(?!perience)/i.test(ctx)) {
        await selectOptionByText(sel, opts, /decline|prefer\s*not|not\s*specified|other/i) || await selectNonPlaceholder(sel, opts);
      } else if (/race|ethnic/i.test(ctx)) {
        await selectOptionByText(sel, opts, /decline|prefer\s*not|not\s*specified|two|other/i) || await selectNonPlaceholder(sel, opts);
      } else if (/veteran/i.test(ctx)) {
        await selectOptionByText(sel, opts, /not\s*a\s*veteran|no|decline|prefer\s*not/i) || await selectNonPlaceholder(sel, opts);
      } else if (/disabilit/i.test(ctx)) {
        await selectOptionByText(sel, opts, /no.*disabilit|decline|prefer\s*not|no/i) || await selectNonPlaceholder(sel, opts);
      } else if (/education|degree|qualification/i.test(ctx)) {
        await selectOptionByText(sel, opts, /bachelor|b\.?tech|b\.?e\b|b\.?sc/i) || await selectNonPlaceholder(sel, opts);
      } else if (/notice|joining/i.test(ctx)) {
        await selectOptionByText(sel, opts, /30|1\s*month|immediate|less\s*than/i) || await selectNonPlaceholder(sel, opts);
      } else if (/hear.*about|source|how.*find|referr/i.test(ctx)) {
        await selectOptionByText(sel, opts, /linkedin|job\s*board|online/i) || await selectNonPlaceholder(sel, opts);
      } else if (/salary|ctc|compensat/i.test(ctx)) {
        await selectOptionByText(sel, opts, /10|12|15|8/i) || await selectNonPlaceholder(sel, opts);
      } else {
        await selectNonPlaceholder(sel, opts);
      }
    } catch {}
  }
}

async function selectBestExperienceOption(sel, opts, years) {
  // Try exact match
  for (const opt of opts) {
    const txt = await opt.innerText().catch(() => '');
    if (new RegExp(`\\b${years}\\b`).test(txt)) {
      await sel.selectOption(await opt.getAttribute('value'));
      return true;
    }
  }
  // Try range containing years
  for (const opt of opts) {
    const txt = await opt.innerText().catch(() => '');
    const m = txt.match(/(\d+)\s*[-–]\s*(\d+)/);
    if (m && parseInt(m[1]) <= years && parseInt(m[2]) >= years) {
      await sel.selectOption(await opt.getAttribute('value'));
      return true;
    }
  }
  // Fallback: second option
  if (opts.length > 1) await sel.selectOption(await opts[1].getAttribute('value'));
  return false;
}

async function selectOptionByText(sel, opts, regex) {
  for (const opt of opts) {
    const txt = await opt.innerText().catch(() => '');
    if (regex.test(txt)) {
      await sel.selectOption(await opt.getAttribute('value'));
      return true;
    }
  }
  return false;
}

async function selectNonPlaceholder(sel, opts) {
  for (let i = 1; i < opts.length; i++) {
    const txt = await opts[i].innerText().catch(() => '');
    if (!/select|choose|pick|please|--/i.test(txt)) {
      await sel.selectOption(await opts[i].getAttribute('value'));
      return true;
    }
  }
  if (opts.length > 1) await sel.selectOption(await opts[1].getAttribute('value'));
  return false;
}

// ─── Checkbox Groups ─────────────────────────────────────────────────────────

async function fillCheckboxes(page, profile) {
  const checkboxes = await page.$$('input[type="checkbox"]:visible');
  const processedGroups = new Set();

  for (const cb of checkboxes) {
    try {
      if (await cb.isChecked()) continue;

      // Get group context
      const groupCtx = await cb.evaluate(el => {
        let p = el.parentElement;
        for (let i = 0; i < 10 && p; i++) {
          const legend = p.querySelector('legend, h3, h4, [class*="label"], span, p');
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

      // Citizenship — check "India"
      if (/citizen|nationality|country/i.test(groupCtx)) {
        const allCbs = groupName ? await page.$$(`input[name="${groupName.replace(/"/g, '\\"')}"]:visible`) : [cb];
        let found = false;
        for (const c of allCbs) {
          const lbl = await getCheckboxLabel(page, c);
          if (/\bindia\b/i.test(lbl)) { await c.check().catch(() => c.click({ force: true })); found = true; break; }
        }
        if (!found) await cb.check().catch(() => cb.click({ force: true }));
        continue;
      }

      // Agreement / Terms / Consent — always check
      if (/agree|consent|acknowledg|certif|terms|privacy|confirm|accept/i.test(groupCtx)) {
        await cb.check().catch(() => cb.click({ force: true }));
        continue;
      }

      // Generic required group — pick "Others" or "None" or first
      const allCbs = groupName ? await page.$$(`input[name="${groupName.replace(/"/g, '\\"')}"]:visible`) : [cb];
      let checkedOne = false;
      for (const c of allCbs) {
        const lbl = await getCheckboxLabel(page, c);
        if (/\bothers?\b|none|not\s*applicable|n\/a/i.test(lbl)) {
          await c.check().catch(() => c.click({ force: true }));
          checkedOne = true;
          break;
        }
      }
      if (!checkedOne) await cb.check().catch(() => cb.click({ force: true }));
    } catch {}
  }
}

async function getCheckboxLabel(page, cb) {
  try {
    const cbId = await cb.getAttribute('id') || '';
    if (cbId) {
      const lbl = await page.$(`label[for="${cbId.replace(/([^\w-])/g, '\\\\$1')}"]`).catch(() => null);
      if (lbl) return await lbl.innerText().catch(() => '');
    }
    return await cb.evaluate(el => {
      const parent = el.parentElement;
      if (parent) {
        const lbl = parent.querySelector('label, span');
        if (lbl) return lbl.innerText?.trim() || '';
      }
      return '';
    }).catch(() => '');
  } catch { return ''; }
}

// ─── Workday-specific combobox/widget handlers ───────────────────────────────

async function fillWorkdayWidgets(page, profile) {
  // Workday uses custom widgets with data-automation-id
  const fieldMap = {
    'legalNameSection_firstName': profile.firstName,
    'legalNameSection_lastName': profile.lastName,
    'addressSection_addressLine1': `${profile.city}, ${profile.state}`,
    'addressSection_city': profile.city,
    'addressSection_postalCode': profile.pincode,
    'phone-number': profile.phone.replace(/^\+\d+/, ''),
    'email': profile.email,
    'linkedinQuestion': profile.linkedinUrl,
    'portfolioQuestion': profile.portfolioUrl || profile.githubUrl,
  };

  for (const [autoId, value] of Object.entries(fieldMap)) {
    if (!value) continue;
    const el = await page.$(`[data-automation-id="${autoId}"], [data-automation-id*="${autoId}"] input`).catch(() => null);
    if (el && await el.isVisible().catch(() => false)) {
      const v = await el.inputValue().catch(() => '');
      if (!v?.trim()) await el.fill(value).catch(() => {});
    }
  }

  // Workday comboboxes (country, state, etc.)
  const combos = await page.$$('[data-automation-id][role="combobox"], [data-automation-id] input[role="combobox"]');
  for (const combo of combos) {
    try {
      const val = await combo.inputValue().catch(() => '');
      if (val?.trim()) continue;
      const autoId = (await combo.getAttribute('data-automation-id') || '').toLowerCase();
      if (/country/i.test(autoId)) {
        await combo.fill('India');
        await humanDelay(500, 800);
        const opt = await page.$('[data-automation-id*="option"]:has-text("India"), [role="option"]:has-text("India")').catch(() => null);
        if (opt) await humanClick(page, opt);
      } else if (/state/i.test(autoId)) {
        await combo.fill('Telangana');
        await humanDelay(500, 800);
        const opt = await page.$('[role="option"]:has-text("Telangana")').catch(() => null);
        if (opt) await humanClick(page, opt);
      }
    } catch {}
  }

  // Workday file upload
  if (profile.resumePath && fs.existsSync(profile.resumePath)) {
    const fileInputs = [
      '[data-automation-id="file-upload-input-ref"]',
      '[data-automation-id="resumeSection"] input[type="file"]',
      'input[data-automation-id*="resume"]',
      'input[data-automation-id*="file"]',
      'input[type="file"]',
    ];
    for (const sel of fileInputs) {
      const fi = await page.$(sel).catch(() => null);
      if (fi) {
        try { await fi.setInputFiles(profile.resumePath); break; } catch {}
      }
    }
  }
}

// ─── Validation Error Recovery ───────────────────────────────────────────────

async function fixValidationErrors(page, profile) {
  const errors = await page.$$('[class*="error"]:visible, [role="alert"]:visible, [class*="Error"]:visible, [data-automation-id*="error"]:visible, [data-testid*="error"]:visible');
  let fixed = false;
  const alreadyFixed = new Set(); // track inputs we've already corrected

  for (const err of errors) {
    try {
      const errText = await err.innerText().catch(() => '');
      if (!errText.trim()) continue;

      // Find the NEAREST input to this error (sibling or in same parent container)
      const nearestInput = await err.evaluate(el => {
        // Walk up to find a container with an input
        let p = el.previousElementSibling || el.parentElement;
        for (let i = 0; i < 5 && p; i++) {
          const inp = p.tagName === 'INPUT' ? p : p.querySelector('input:not([type="hidden"]):not([type="submit"])');
          if (inp) return inp.id || inp.name || '';
          p = p.previousElementSibling || p.parentElement;
        }
        return '';
      }).catch(() => '');

      // "Enter a whole/decimal number larger than X"
      const largerMatch = errText.match(/larger than ([\d.]+)/i);
      if (largerMatch) {
        const minVal = parseFloat(largerMatch[1]);
        for (const inp of await page.$$('input:visible')) {
          const inpId = await inp.getAttribute('id').catch(() => '') || await inp.getAttribute('name').catch(() => '') || '';
          if (alreadyFixed.has(inpId)) continue;
          // If we found a nearest input, only fix that one
          if (nearestInput && inpId !== nearestInput) continue;
          const val = await inp.inputValue().catch(() => '');
          if (val && parseFloat(val) <= minVal) {
            const { ctx } = await getFieldContext(page, inp);
            if (/ctc|salary|compensation|expected|current/i.test(ctx)) {
              await inp.fill(String(profile.expectedCtcLPA * 100000));
            } else {
              await inp.fill(String(Math.ceil(minVal + 1)));
            }
            alreadyFixed.add(inpId);
            fixed = true;
          }
        }
      }

      // "Enter a whole number between X and Y"
      const betweenMatch = errText.match(/between\s+([\d.]+)\s+and\s+([\d.]+)/i);
      if (betweenMatch) {
        const minVal = parseFloat(betweenMatch[1]);
        const maxVal = parseFloat(betweenMatch[2]);
        const midVal = Math.floor((minVal + maxVal) / 2) || profile.totalExperience;
        for (const inp of await page.$$('input:visible')) {
          const inpId = await inp.getAttribute('id').catch(() => '') || await inp.getAttribute('name').catch(() => '') || '';
          if (alreadyFixed.has(inpId)) continue;
          if (nearestInput && inpId !== nearestInput) continue;
          const val = await inp.inputValue().catch(() => '');
          const numVal = parseFloat(val);
          if (val && (isNaN(numVal) || numVal < minVal || numVal > maxVal)) {
            await inp.fill(String(midVal));
            alreadyFixed.add(inpId);
            fixed = true;
          }
        }
      }

      // "Please make a selection" / "Select checkbox"
      if (/make a selection|select.*checkbox|select.*proceed/i.test(errText)) {
        await fillDropdowns(page, profile);
        await fillCheckboxes(page, profile);
        fixed = true;
      }

      // "Please enter a valid answer" / "required"
      if (/valid answer|this field is required|required field|cannot be empty/i.test(errText)) {
        await fillAllFields(page, profile);
        fixed = true;
      }
    } catch {}
  }
  return fixed;
}

// ─── Success Detection ───────────────────────────────────────────────────────

async function isApplicationSuccess(page) {
  try {
    const url = page.url();
    if (/thank[-_]?you|confirmation|applied|submitted|success|application[-_]?complete/i.test(url)) return true;

    const bodyText = await page.evaluate(() => document.body.innerText.substring(0, 3000).toLowerCase()).catch(() => '');
    if (/thank you for (applying|your application|submitting|your interest)/i.test(bodyText)) return true;
    if (/application (has been|was|is) (submitted|received|sent|complete|processed)/i.test(bodyText)) return true;
    if (/successfully (applied|submitted|sent|received)/i.test(bodyText)) return true;
    if (/we('ve| have) received your (application|resume|cv)/i.test(bodyText)) return true;
    if (/your application is (complete|under review|being reviewed)/i.test(bodyText)) return true;
    if (/application complete|we'll be in touch/i.test(bodyText)) return true;
    if (/congratulations.*appli/i.test(bodyText)) return true;
  } catch {}
  return false;
}

module.exports = {
  getFieldContext,
  matchField,
  fillField,
  fillAllFields,
  fillRadioButtons,
  fillDropdowns,
  fillCheckboxes,
  fillWorkdayWidgets,
  fixValidationErrors,
  isApplicationSuccess,
  getCheckboxLabel,
};
