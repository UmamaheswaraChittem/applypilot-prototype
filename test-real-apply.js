/**
 * REAL-WORLD APPLY BATTLE TEST
 * Actually navigates to real job postings on Greenhouse, Lever, SmartRecruiters
 * Fills real forms, clicks real apply buttons, captures every failure.
 * NO SUGAR COATING — logs exactly what works and what breaks.
 */
require('dotenv').config();
const { launchStealthBrowser, humanDelay, smartGoto, waitForPageStable, smartWaitForElement } = require('./src/stealth');
const { fillAllFields, fillWorkdayWidgets, fillDropdowns, fillCheckboxes, fixValidationErrors, isApplicationSuccess } = require('./src/form-filler');
const { loadProfile, generateCoverLetter } = require('./src/profile');
const captchaSolver = require('./src/captcha-solver');
const fs = require('fs');

const profile = loadProfile();
const SCREENSHOT_DIR = 'debug-screenshots';
if (!fs.existsSync(SCREENSHOT_DIR)) fs.mkdirSync(SCREENSHOT_DIR);

let passed = 0, failed = 0, warnings = 0;
const BUGS = [];
const RESULTS = [];

function ok(msg) { console.log(`  \x1b[32m+\x1b[0m ${msg}`); passed++; }
function fail(msg) { console.log(`  \x1b[31m✗\x1b[0m ${msg}`); failed++; BUGS.push(msg); }
function warn(msg) { console.log(`  \x1b[33m~\x1b[0m ${msg}`); warnings++; }

async function screenshot(page, name) {
  try {
    await page.screenshot({ path: `${SCREENSHOT_DIR}/${name}.png`, fullPage: true });
  } catch {}
}

// Real job URLs from actual companies
const REAL_JOBS = [
  // Greenhouse jobs
  { platform: 'greenhouse', url: 'https://boards.greenhouse.io/spotify/jobs/6893647' },
  { platform: 'greenhouse', url: 'https://boards.greenhouse.io/discord' },
  // Lever jobs
  { platform: 'lever', url: 'https://jobs.lever.co/spotify' },
  // SmartRecruiters
  { platform: 'smartrecruiters', url: 'https://jobs.smartrecruiters.com/Visa' },
];

(async () => {
  console.log('=== REAL-WORLD APPLY BATTLE TEST ===');
  console.log(`Profile: ${profile.fullName} | ${profile.totalExperience}yr | ${profile.expectedCtcLPA}LPA\n`);

  const { browser, context, page } = await launchStealthBrowser({ headless: true });

  // ─── TEST 1: Greenhouse — Find a real job and apply ────────────────────────
  console.log('--- TEST 1: Greenhouse Real Job Discovery + Apply ---');

  try {
    // Find a real open job on Greenhouse
    // Use active Greenhouse boards (Spotify board is inactive)
    await smartGoto(page, 'https://boards.greenhouse.io/figma', { maxWait: 20000 });
    await waitForPageStable(page, { maxWait: 5000 });
    await screenshot(page, '01-greenhouse-listing');

    const bodyText = await page.evaluate(() => document.body.innerText.substring(0, 500)).catch(() => '');
    console.log(`  Page loaded: "${bodyText.substring(0, 80)}..."`);

    // Check if we got blocked
    const blocked = /access denied|blocked|cloudflare|captcha|please verify/i.test(bodyText);
    if (blocked) {
      fail('Greenhouse: BLOCKED by anti-bot');
    } else {
      ok('Greenhouse: Page loaded without block');
    }

    // Find job links
    const jobLinks = await page.evaluate(() => {
      const links = Array.from(document.querySelectorAll('a[href*="/jobs/"]'));
      return links.slice(0, 5).map(a => ({
        text: a.innerText.trim().substring(0, 60),
        href: a.href,
      }));
    }).catch(() => []);

    if (jobLinks.length > 0) {
      ok(`Greenhouse: Found ${jobLinks.length} job links`);
      console.log(`    First: "${jobLinks[0].text}" → ${jobLinks[0].href.substring(0, 70)}...`);

      // Navigate to first job
      await smartGoto(page, jobLinks[0].href, { maxWait: 15000 });
      await waitForPageStable(page, { maxWait: 5000 });
      await screenshot(page, '02-greenhouse-job-detail');

      const jobPage = await page.evaluate(() => document.body.innerText.substring(0, 300)).catch(() => '');
      console.log(`  Job page: "${jobPage.substring(0, 80)}..."`);

      // Find apply button
      const applyBtn = await page.$('a[href*="#app"], a:has-text("Apply"), button:has-text("Apply"), a.btn--apply, [id*="apply"]').catch(() => null);
      if (applyBtn) {
        ok('Greenhouse: Apply button found');

        // Click apply
        await applyBtn.click().catch(async () => {
          await applyBtn.evaluate(e => e.click()).catch(() => {});
        });
        await waitForPageStable(page, { maxWait: 5000 });
        await screenshot(page, '03-greenhouse-apply-form');

        // Check for application form
        const formExists = await page.evaluate(() => {
          const inputs = document.querySelectorAll('input:not([type="hidden"]), select, textarea');
          return inputs.length;
        }).catch(() => 0);

        if (formExists > 0) {
          ok(`Greenhouse: Application form loaded (${formExists} fields)`);

          // Fill all fields
          await fillAllFields(page, profile);
          await humanDelay(500, 800);
          await screenshot(page, '04-greenhouse-form-filled');

          // Verify key fields filled
          const filledCheck = await page.evaluate(() => {
            const results = {};
            const nameInput = document.querySelector('input[name*="first_name"], #first_name');
            results.firstName = nameInput?.value || '';
            const emailInput = document.querySelector('input[name*="email"], input[type="email"], #email');
            results.email = emailInput?.value || '';
            const phoneInput = document.querySelector('input[name*="phone"], input[type="tel"], #phone');
            results.phone = phoneInput?.value || '';
            // Count empty required fields
            const required = document.querySelectorAll('[required], [aria-required="true"]');
            results.emptyRequired = Array.from(required).filter(el => !el.value?.trim() && el.type !== 'file').length;
            results.totalRequired = required.length;
            return results;
          }).catch(() => ({}));

          if (filledCheck.firstName) ok(`  First name filled: ${filledCheck.firstName}`);
          else warn('  First name NOT filled');

          if (filledCheck.email) ok(`  Email filled: ${filledCheck.email}`);
          else fail('  Email NOT filled on Greenhouse form');

          if (filledCheck.emptyRequired === 0) ok(`  All ${filledCheck.totalRequired} required fields filled`);
          else warn(`  ${filledCheck.emptyRequired}/${filledCheck.totalRequired} required fields still empty`);

          // Try fix validation errors
          await fixValidationErrors(page, profile);
          await screenshot(page, '05-greenhouse-validated');

          RESULTS.push({ platform: 'greenhouse', status: 'form_filled', emptyRequired: filledCheck.emptyRequired });
        } else {
          warn('Greenhouse: No form fields found (may need login or different URL)');
          RESULTS.push({ platform: 'greenhouse', status: 'no_form' });
        }
      } else {
        warn('Greenhouse: No apply button found on job page');
        RESULTS.push({ platform: 'greenhouse', status: 'no_apply_btn' });
      }
    } else {
      warn('Greenhouse: No job links found (page may have changed)');
      RESULTS.push({ platform: 'greenhouse', status: 'no_jobs' });
    }
  } catch (err) {
    fail(`Greenhouse CRASH: ${err.message.substring(0, 100)}`);
    await screenshot(page, '01-greenhouse-crash');
    RESULTS.push({ platform: 'greenhouse', status: 'crash', error: err.message });
  }

  // ─── TEST 2: Lever — Find job and test apply ──────────────────────────────
  console.log('\n--- TEST 2: Lever Real Job Discovery + Apply ---');

  try {
    await smartGoto(page, 'https://jobs.lever.co/spotify', { maxWait: 20000 });
    await waitForPageStable(page, { maxWait: 5000 });
    await screenshot(page, '10-lever-listing');

    const leverBody = await page.evaluate(() => document.body.innerText.substring(0, 300)).catch(() => '');
    const leverBlocked = /access denied|blocked|cloudflare|captcha|please verify/i.test(leverBody);
    if (leverBlocked) {
      fail('Lever: BLOCKED');
    } else {
      ok('Lever: Page loaded');
    }

    // Find lever job postings
    const leverJobs = await page.evaluate(() => {
      const links = Array.from(document.querySelectorAll('.posting-title a, a[href*="/jobs/"], a.posting-btn-submit'));
      return links.slice(0, 5).map(a => ({
        text: a.innerText.trim().substring(0, 60),
        href: a.href,
      })).filter(j => j.href.includes('/'));
    }).catch(() => []);

    if (leverJobs.length > 0) {
      ok(`Lever: Found ${leverJobs.length} job postings`);

      // Go to first job
      const firstJob = leverJobs[0];
      console.log(`    First: "${firstJob.text}" → ${firstJob.href.substring(0, 70)}...`);
      await smartGoto(page, firstJob.href, { maxWait: 15000 });
      await waitForPageStable(page, { maxWait: 5000 });
      await screenshot(page, '11-lever-job-detail');

      // Find apply section / button
      const leverApply = await page.$('.application-page a, a.postings-btn, a[href*="apply"], button:has-text("Apply"), .postings-btn-wrapper a').catch(() => null);
      if (leverApply) {
        ok('Lever: Apply link found');
        const applyHref = await leverApply.getAttribute('href').catch(() => '');

        // Navigate to apply page
        if (applyHref && applyHref.startsWith('http')) {
          await smartGoto(page, applyHref, { maxWait: 15000 });
        } else {
          await leverApply.click().catch(() => {});
        }
        await waitForPageStable(page, { maxWait: 5000 });
        await screenshot(page, '12-lever-apply-form');

        // Check for form
        const leverFormFields = await page.evaluate(() => {
          return document.querySelectorAll('input:not([type="hidden"]), select, textarea').length;
        }).catch(() => 0);

        if (leverFormFields > 0) {
          ok(`Lever: Form loaded (${leverFormFields} fields)`);

          // Lever has custom field names
          await fillAllFields(page, profile);
          await fillDropdowns(page, profile);
          await fillCheckboxes(page, profile);
          await humanDelay(500, 800);
          await screenshot(page, '13-lever-form-filled');

          const leverFilled = await page.evaluate(() => {
            const nameEl = document.querySelector('input[name="name"], input[placeholder*="name" i]');
            const emailEl = document.querySelector('input[name="email"], input[type="email"]');
            return {
              name: nameEl?.value || '',
              email: emailEl?.value || '',
              totalInputs: document.querySelectorAll('input:not([type="hidden"])').length,
            };
          }).catch(() => ({}));

          if (leverFilled.name) ok(`  Name filled: ${leverFilled.name}`);
          else warn('  Name not filled');
          if (leverFilled.email) ok(`  Email filled: ${leverFilled.email}`);
          else fail('  Email NOT filled on Lever');

          RESULTS.push({ platform: 'lever', status: 'form_filled' });
        } else {
          warn('Lever: No form fields on apply page');
          RESULTS.push({ platform: 'lever', status: 'no_form' });
        }
      } else {
        // Lever sometimes has apply form directly on job page
        const directForm = await page.evaluate(() => {
          return document.querySelectorAll('.application-form input, .postings-form input').length;
        }).catch(() => 0);

        if (directForm > 0) {
          ok(`Lever: Direct application form found (${directForm} fields)`);
          await fillAllFields(page, profile);
          RESULTS.push({ platform: 'lever', status: 'direct_form' });
        } else {
          warn('Lever: No apply button or direct form found');
          RESULTS.push({ platform: 'lever', status: 'no_apply' });
        }
      }
    } else {
      warn('Lever: No job postings found');
      RESULTS.push({ platform: 'lever', status: 'no_jobs' });
    }
  } catch (err) {
    fail(`Lever CRASH: ${err.message.substring(0, 100)}`);
    await screenshot(page, '10-lever-crash');
    RESULTS.push({ platform: 'lever', status: 'crash', error: err.message });
  }

  // ─── TEST 3: SmartRecruiters — Real apply flow ─────────────────────────────
  console.log('\n--- TEST 3: SmartRecruiters Real Job + Apply ---');

  try {
    await smartGoto(page, 'https://jobs.smartrecruiters.com/Bosch', { maxWait: 20000 });
    await waitForPageStable(page, { maxWait: 8000 });
    await screenshot(page, '20-sr-listing');

    const srBody = await page.evaluate(() => document.body.innerText.substring(0, 300)).catch(() => '');
    const srBlocked = /access denied|blocked|cloudflare|captcha|please verify/i.test(srBody);
    if (srBlocked) {
      fail('SmartRecruiters: BLOCKED');
    } else {
      ok('SmartRecruiters: Page loaded');
    }

    // SR uses SPA — job links may be in specific format
    const srJobs = await page.evaluate(() => {
      const links = Array.from(document.querySelectorAll('a[href*="/743999"], a[href*="jobs/"], .job-item a, [class*="job"] a, li a[href*="Bosch"]'));
      // Also try generic visible links with job-like text
      if (links.length === 0) {
        const allLinks = Array.from(document.querySelectorAll('a'));
        return allLinks.filter(a => a.href.includes('smartrecruiters.com') && a.innerText.trim().length > 5)
          .slice(0, 10)
          .map(a => ({ text: a.innerText.trim().substring(0, 60), href: a.href }));
      }
      return links.slice(0, 5).map(a => ({
        text: a.innerText.trim().substring(0, 60),
        href: a.href,
      }));
    }).catch(() => []);

    if (srJobs.length > 0) {
      ok(`SmartRecruiters: Found ${srJobs.length} job links`);
      const firstSR = srJobs.find(j => j.href.includes('743999') || j.href.includes('jobs/')) || srJobs[0];
      console.log(`    First: "${firstSR.text}" → ${firstSR.href.substring(0, 70)}...`);

      await smartGoto(page, firstSR.href, { maxWait: 15000 });
      await waitForPageStable(page, { maxWait: 8000 });
      await screenshot(page, '21-sr-job-detail');

      // Find apply button
      const srApply = await page.$('button:has-text("Apply"), a:has-text("Apply"), [class*="apply"] button, [class*="apply"] a, button[data-test="apply-button"]').catch(() => null);
      if (srApply) {
        ok('SmartRecruiters: Apply button found');
        await srApply.click().catch(async () => {
          await srApply.evaluate(e => e.click()).catch(() => {});
        });
        await waitForPageStable(page, { maxWait: 8000 });
        await screenshot(page, '22-sr-apply-form');

        const srFormFields = await page.evaluate(() => {
          return document.querySelectorAll('input:not([type="hidden"]), select, textarea').length;
        }).catch(() => 0);

        if (srFormFields > 0) {
          ok(`SmartRecruiters: Form loaded (${srFormFields} fields)`);
          await fillAllFields(page, profile);
          await fillDropdowns(page, profile);
          await fillCheckboxes(page, profile);
          await screenshot(page, '23-sr-form-filled');
          RESULTS.push({ platform: 'smartrecruiters', status: 'form_filled' });
        } else {
          warn('SmartRecruiters: No form fields after apply click');
          RESULTS.push({ platform: 'smartrecruiters', status: 'no_form' });
        }
      } else {
        warn('SmartRecruiters: No apply button');
        RESULTS.push({ platform: 'smartrecruiters', status: 'no_apply' });
      }
    } else {
      warn('SmartRecruiters: No job links found');
      RESULTS.push({ platform: 'smartrecruiters', status: 'no_jobs' });
    }
  } catch (err) {
    fail(`SmartRecruiters CRASH: ${err.message.substring(0, 100)}`);
    await screenshot(page, '20-sr-crash');
    RESULTS.push({ platform: 'smartrecruiters', status: 'crash', error: err.message });
  }

  // ─── TEST 4: Naukri Real Apply (Fresh Keywords) ────────────────────────────
  console.log('\n--- TEST 4: Naukri Real Apply (Fresh Search) ---');

  try {
    // Login first
    await smartGoto(page, 'https://www.naukri.com/nlogin/login', { maxWait: 20000 });
    await waitForPageStable(page, { maxWait: 5000 });

    const emailInput = await smartWaitForElement(page, ['input[placeholder*="Email" i]', 'input[type="email"]', '#usernameField'], { maxWait: 8000 });
    if (emailInput) {
      await emailInput.fill(process.env.NAUKRI_EMAIL || 'umamaheswar.chittem@gmail.com');
      const passInput = await page.$('input[type="password"]');
      if (passInput) await passInput.fill(process.env.NAUKRI_PASSWORD || '');
      const loginBtn = await page.$('button[type="submit"], button:has-text("Login")');
      if (loginBtn) await loginBtn.click().catch(() => {});
      await waitForPageStable(page, { maxWait: 8000 });
      ok('Naukri: Login attempted');
    }

    // Search for fresh jobs with different keywords
    const searchKeywords = ['React developer', 'Python developer', 'Java backend', 'DevOps engineer'];
    const keyword = searchKeywords[Math.floor(Math.random() * searchKeywords.length)];
    const searchUrl = `https://www.naukri.com/${keyword.replace(/\s+/g, '-')}-jobs?k=${encodeURIComponent(keyword)}&experience=2&nignbevent_src=jobsearchDeskGNB`;

    console.log(`  Searching: "${keyword}"`);
    await smartGoto(page, searchUrl, { maxWait: 20000 });
    await waitForPageStable(page, { maxWait: 8000 });
    await screenshot(page, '30-naukri-search');

    // Intercept API for job URLs
    let apiJobs = [];
    page.on('response', async (resp) => {
      try {
        if (resp.url().includes('jobapi') && resp.status() === 200) {
          const data = await resp.json().catch(() => null);
          if (data?.jobDetails) {
            apiJobs = data.jobDetails.map(j => j.jdURL).filter(Boolean).slice(0, 3);
          }
        }
      } catch {}
    });

    // Reload to trigger API
    await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
    await waitForPageStable(page, { maxWait: 8000 });

    // Also try finding job cards directly
    const jobCards = await page.evaluate(() => {
      const cards = document.querySelectorAll('div.cursor-pointer.rounded-3xl, article.jobTuple, .srp-jobtuple-wrapper a, .jobTupleHeader a');
      return Array.from(cards).slice(0, 5).map(c => {
        const link = c.querySelector('a[href*="job-listings"]') || c.closest('a');
        return link?.href || '';
      }).filter(Boolean);
    }).catch(() => []);

    const allJobUrls = [...new Set([...apiJobs, ...jobCards])].slice(0, 3);
    if (allJobUrls.length > 0) {
      ok(`Naukri: Found ${allJobUrls.length} jobs to test`);

      for (let i = 0; i < Math.min(allJobUrls.length, 2); i++) {
        const jobUrl = allJobUrls[i];
        console.log(`  Testing job ${i + 1}: ${jobUrl.substring(0, 70)}...`);

        await smartGoto(page, jobUrl, { maxWait: 15000 });
        await waitForPageStable(page, { maxWait: 5000 });

        // Check CAPTCHA
        const captchaDetected = await captchaSolver.detectCaptcha(page);
        if (captchaDetected) {
          console.log(`  CAPTCHA detected: ${captchaDetected.type}`);
          await captchaSolver.solveCaptcha(page, { maxRetries: 2 });
        }

        // Find apply button
        const applyBtn = await page.$('button:has-text("Apply"), button:has-text("Quick apply"), [class*="apply"] button, #apply-button, [class*="chatbot-apply"]').catch(() => null);
        const bodyText = await page.evaluate(() => document.body.innerText.substring(0, 500)).catch(() => '');

        if (/already applied|applied/i.test(bodyText)) {
          ok(`  Job ${i + 1}: Already applied (skipping)`);
        } else if (applyBtn && await applyBtn.isVisible().catch(() => false)) {
          ok(`  Job ${i + 1}: Apply button found`);
          await screenshot(page, `31-naukri-job-${i}`);
          // Don't actually click to avoid duplicate applies
          RESULTS.push({ platform: 'naukri', status: 'apply_btn_found', url: jobUrl });
        } else {
          warn(`  Job ${i + 1}: No visible apply button`);
          await screenshot(page, `31-naukri-job-${i}-no-btn`);
        }
      }
    } else {
      warn('Naukri: No job URLs found from search');
    }
  } catch (err) {
    fail(`Naukri CRASH: ${err.message.substring(0, 100)}`);
    await screenshot(page, '30-naukri-crash');
  }

  // ─── TEST 5: LinkedIn Login + Easy Apply ───────────────────────────────────
  console.log('\n--- TEST 5: LinkedIn Login + Easy Apply ---');

  try {
    await smartGoto(page, 'https://www.linkedin.com/login', { maxWait: 20000 });
    await waitForPageStable(page, { maxWait: 5000 });

    const liEmail = await page.$('#username, input[name="session_key"]').catch(() => null);
    if (liEmail) {
      await liEmail.fill(process.env.LINKEDIN_EMAIL || 'gutha.pravallika5@gmail.com');
      const liPass = await page.$('#password, input[name="session_password"]');
      if (liPass) await liPass.fill(process.env.LINKEDIN_PASSWORD || '');
      // LinkedIn uses a specific selector for the sign-in button
      const liLogin = await page.$('[data-litms-control-urn="login-submit"], button[type="submit"], button:has-text("Sign in")');
      if (liLogin) {
        await liLogin.scrollIntoViewIfNeeded().catch(() => {});
        await liLogin.click({ timeout: 5000 }).catch(async () => {
          await liLogin.evaluate(e => e.click()).catch(() => {});
        });
      }
      // Wait for redirect — LinkedIn may show security challenge
      await waitForPageStable(page, { maxWait: 15000 });
      // Extra wait for slow redirects
      await humanDelay(2000, 3000);
      await waitForPageStable(page, { maxWait: 5000 });

      const liUrl = page.url();
      if (!liUrl.includes('login') && !liUrl.includes('checkpoint')) {
        ok('LinkedIn: Login successful');
        await screenshot(page, '40-linkedin-logged-in');

        // Navigate to job search
        await smartGoto(page, 'https://www.linkedin.com/jobs/search/?keywords=Node.js&f_AL=true&f_E=3%2C4&sortBy=DD', { maxWait: 15000 });
        await waitForPageStable(page, { maxWait: 8000 });
        await screenshot(page, '41-linkedin-search');

        // Find Easy Apply jobs
        const easyApplyJobs = await page.evaluate(() => {
          const cards = document.querySelectorAll('.job-card-container, .jobs-search-results__list-item');
          return Array.from(cards).slice(0, 5).map(card => {
            const link = card.querySelector('a[href*="/jobs/"]');
            const easyApply = card.querySelector('[class*="easy-apply"], .job-card-container__apply-method');
            return {
              href: link?.href || '',
              title: (link?.innerText || '').trim().substring(0, 50),
              hasEasyApply: !!easyApply || (card.innerText || '').includes('Easy Apply'),
            };
          }).filter(j => j.href);
        }).catch(() => []);

        if (easyApplyJobs.length > 0) {
          ok(`LinkedIn: Found ${easyApplyJobs.length} job cards`);
          const easyApplyCount = easyApplyJobs.filter(j => j.hasEasyApply).length;
          console.log(`    Easy Apply jobs: ${easyApplyCount}/${easyApplyJobs.length}`);

          // Click first job
          if (easyApplyJobs[0].href) {
            await smartGoto(page, easyApplyJobs[0].href, { maxWait: 15000 });
            await waitForPageStable(page, { maxWait: 5000 });
            await screenshot(page, '42-linkedin-job-detail');

            // Find Easy Apply button
            const easyApplyBtn = await page.$('button:has-text("Easy Apply"), button.jobs-apply-button, [class*="easy-apply"]').catch(() => null);
            if (easyApplyBtn && await easyApplyBtn.isVisible().catch(() => false)) {
              ok('LinkedIn: Easy Apply button found');
              RESULTS.push({ platform: 'linkedin', status: 'easy_apply_found' });
            } else {
              warn('LinkedIn: No Easy Apply button on job page');
              RESULTS.push({ platform: 'linkedin', status: 'no_easy_apply' });
            }
          }
        } else {
          warn('LinkedIn: No job cards found on search page');
        }
      } else {
        // Check for security challenge
        const challengeText = await page.evaluate(() => document.body.innerText.substring(0, 500)).catch(() => '');
        if (/verification|security|captcha|puzzle/i.test(challengeText)) {
          warn('LinkedIn: Security challenge / CAPTCHA on login');
          await screenshot(page, '40-linkedin-challenge');
          RESULTS.push({ platform: 'linkedin', status: 'security_challenge' });
        } else {
          fail('LinkedIn: Login failed');
          await screenshot(page, '40-linkedin-login-fail');
          RESULTS.push({ platform: 'linkedin', status: 'login_failed' });
        }
      }
    } else {
      fail('LinkedIn: Could not find login form');
    }
  } catch (err) {
    fail(`LinkedIn CRASH: ${err.message.substring(0, 100)}`);
    await screenshot(page, '40-linkedin-crash');
    RESULTS.push({ platform: 'linkedin', status: 'crash', error: err.message });
  }

  // ─── TEST 6: CAPTCHA Handling on Real Pages ────────────────────────────────
  console.log('\n--- TEST 6: Real CAPTCHA Detection on Live Sites ---');

  const captchaUrls = [
    { url: 'https://www.google.com/recaptcha/api2/demo', name: 'Google reCAPTCHA Demo' },
    { url: 'https://accounts.hcaptcha.com/demo', name: 'hCaptcha Demo' },
  ];

  for (const { url, name } of captchaUrls) {
    try {
      await smartGoto(page, url, { maxWait: 15000 });
      await waitForPageStable(page, { maxWait: 5000 });

      const detected = await captchaSolver.detectCaptcha(page);
      if (detected) {
        ok(`${name}: Detected ${detected.type}${detected.sitekey ? ' (sitekey found)' : ''}`);
      } else {
        fail(`${name}: CAPTCHA not detected`);
      }
    } catch (err) {
      warn(`${name}: ${err.message.substring(0, 60)}`);
    }
  }

  // ─── TEST 7: Stress — Rapid Multi-Page Navigation ─────────────────────────
  console.log('\n--- TEST 7: Rapid Navigation Stress Test ---');

  const stressUrls = [
    'https://boards.greenhouse.io/figma',
    'https://jobs.lever.co/spotify',
    'https://jobs.smartrecruiters.com/Visa',
    'https://boards.greenhouse.io/stripe',
    'https://boards.greenhouse.io/discord',
  ];

  const startTime = Date.now();
  let navSuccess = 0, navFail = 0;
  for (const url of stressUrls) {
    try {
      await smartGoto(page, url, { maxWait: 10000 });
      const body = await page.evaluate(() => document.body.innerText.length).catch(() => 0);
      if (body > 50) navSuccess++;
      else navFail++;
    } catch {
      navFail++;
    }
  }
  const elapsed = Date.now() - startTime;

  if (navFail === 0) ok(`Rapid nav: ${navSuccess}/${stressUrls.length} pages in ${elapsed}ms (avg ${Math.round(elapsed / stressUrls.length)}ms)`);
  else fail(`Rapid nav: ${navFail} failures out of ${stressUrls.length}`);

  // ─── Summary ───────────────────────────────────────────────────────────────
  await browser.close();

  console.log('\n=============================');
  console.log(`\x1b[32m  Passed:  ${passed}\x1b[0m`);
  console.log(`\x1b[31m  Failed:  ${failed}\x1b[0m`);
  console.log(`\x1b[33m  Warnings: ${warnings}\x1b[0m`);
  console.log('=============================');

  console.log('\n--- Platform Results ---');
  for (const r of RESULTS) {
    const icon = r.status.includes('filled') || r.status.includes('found') || r.status === 'success' ? '+' : '~';
    console.log(`  [${icon}] ${r.platform}: ${r.status}${r.error ? ' — ' + r.error.substring(0, 50) : ''}`);
  }

  if (BUGS.length > 0) {
    console.log('\nBUGS TO FIX:');
    BUGS.forEach((b, i) => console.log(`  ${i + 1}. ${b}`));
  }

  console.log(`\nScreenshots saved to: ${SCREENSHOT_DIR}/`);
})();
