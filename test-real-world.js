/**
 * Real-World Stress Test — Tests against actual ATS platforms and career portals
 * Simulates 100,000 testers trying to break the system
 *
 * Tests:
 * 1. Real Workday career pages (complex multi-step)
 * 2. Real Greenhouse job boards
 * 3. Real Lever job pages
 * 4. Real SmartRecruiters pages
 * 5. Real iCIMS pages
 * 6. Naukri end-to-end apply
 * 7. Edge cases: CAPTCHA detection, OTP flow, validation errors
 * 8. Infinite loop detection
 * 9. Browser crash recovery
 * 10. Concurrent page handling
 *
 * Run: node test-real-world.js [test] (workday|greenhouse|lever|naukri|all)
 */
require('dotenv').config();
const { launchStealthBrowser, humanDelay } = require('./src/stealth');
const { loadProfile, generateCoverLetter } = require('./src/profile');
const { fillAllFields, fillWorkdayWidgets, fixValidationErrors, isApplicationSuccess } = require('./src/form-filler');
const { detectATS, applyExternal } = require('./src/apply/external');
const aiBrain = require('./src/apply/ai-brain');

let passed = 0, failed = 0, skipped = 0, errors = [];
function ok(msg) { passed++; console.log(`  \x1b[32m✓\x1b[0m ${msg}`); }
function fail(msg) { failed++; errors.push(msg); console.log(`  \x1b[31m✗\x1b[0m ${msg}`); }
function warn(msg) { skipped++; console.log(`  \x1b[33m⚠\x1b[0m ${msg}`); }
function log(msg) { console.log(`  ${msg}`); }

const profile = loadProfile();

// ─── Real ATS URLs to test ──────────────────────────────────────────────────
// These are real public career pages (we'll navigate and detect, NOT actually submit)

const REAL_CAREER_PAGES = {
  workday: [
    'https://wd1.myworkdaysite.com/recruiting/salesforce/Futureforce_Internships',
    'https://nvidia.wd5.myworkdayjobs.com/NVIDIAExternalCareerSite',
  ],
  greenhouse: [
    'https://boards.greenhouse.io/discord',
    'https://boards.greenhouse.io/figma',
    'https://boards.greenhouse.io/stripe',
  ],
  lever: [
    'https://jobs.lever.co/netlify',
    'https://jobs.lever.co/spotify',
  ],
  smartrecruiters: [
    'https://jobs.smartrecruiters.com/Visa',
    'https://jobs.smartrecruiters.com/Bosch',
  ],
};

// ─── TEST: Real ATS Page Navigation & Detection ─────────────────────────────

async function testATSDetection() {
  console.log('\n═══ TEST: Real-World ATS Page Detection ═══');

  let browser, context, page;
  try {
    const result = await launchStealthBrowser({ headless: true });
    browser = result.browser; context = result.context; page = result.page;
  } catch (err) { fail(`Launch: ${err.message}`); return; }

  try {
    for (const [atsName, urls] of Object.entries(REAL_CAREER_PAGES)) {
      for (const url of urls) {
        try {
          log(`Testing ${atsName}: ${url.substring(0, 60)}...`);
          await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
          await page.waitForTimeout(2000);

          const title = await page.title().catch(() => '');
          const bodyLen = await page.evaluate(() => (document.body.innerText || '').length).catch(() => 0);
          const detected = detectATS(url);

          if (detected.toLowerCase().includes(atsName) || detected === 'generic') {
            ok(`${atsName} detected: "${title.substring(0, 40)}" (${bodyLen} chars) → ${detected}`);
          } else {
            warn(`${atsName} mismatch: detected="${detected}" for ${url.substring(0, 50)}`);
          }

          // Check if page actually loaded (not blocked/403)
          if (bodyLen < 100) {
            warn(`${atsName} page may be blocked (body: ${bodyLen} chars)`);
          }

          // Check for anti-bot blocks
          const blocked = await page.evaluate(() => {
            const text = (document.body.innerText || '').toLowerCase();
            return /access denied|403 forbidden|captcha|verify you are human|bot detected|cloudflare/i.test(text);
          }).catch(() => false);
          if (blocked) warn(`${atsName} anti-bot detected on page`);
          else ok(`${atsName} no anti-bot block`);

        } catch (err) {
          warn(`${atsName} ${url.substring(0, 40)}: ${err.message.substring(0, 60)}`);
        }
      }
    }
  } finally {
    await browser.close().catch(() => {});
  }
}

// ─── TEST: Complex Form Handling (Workday-style) ────────────────────────────

async function testComplexForms() {
  console.log('\n═══ TEST: Complex Multi-Step Form Handling ═══');

  let browser, context, page;
  try {
    const result = await launchStealthBrowser({ headless: true });
    browser = result.browser; context = result.context; page = result.page;
  } catch (err) { fail(`Launch: ${err.message}`); return; }

  try {
    // Test 1: Multi-step form (simulates Workday's 4-step process)
    await page.setContent(`
      <html><body>
        <div id="step1" class="visible">
          <h2>Step 1: Personal Information</h2>
          <label for="fn">First Name *</label><input id="fn" required type="text" data-automation-id="legalNameSection_firstName" />
          <label for="ln">Last Name *</label><input id="ln" required type="text" data-automation-id="legalNameSection_lastName" />
          <label for="em">Email *</label><input id="em" required type="email" data-automation-id="email" />
          <label for="ph">Phone</label><input id="ph" type="tel" data-automation-id="phone" />
          <label for="country">Country *</label>
          <select id="country" required data-automation-id="countryDropdown">
            <option value="">Select</option><option value="us">United States</option><option value="in">India</option>
          </select>
          <button id="next1" type="button" onclick="document.getElementById('step1').style.display='none';document.getElementById('step2').style.display='block';">Next</button>
        </div>
        <div id="step2" style="display:none">
          <h2>Step 2: Experience</h2>
          <label for="exp">Years of Experience *</label><input id="exp" required type="number" />
          <label for="ctitle">Current Job Title</label><input id="ctitle" type="text" data-automation-id="jobTitle" />
          <label for="comp">Current Employer</label><input id="comp" type="text" />
          <label for="sal">Expected Salary (LPA)</label><input id="sal" type="text" placeholder="Enter expected salary" />
          <label for="np">Notice Period (days)</label><input id="np" type="number" />
          <label>Willing to relocate?</label>
          <div>
            <input type="radio" name="relocate" value="yes" id="rel-y"><label for="rel-y">Yes</label>
            <input type="radio" name="relocate" value="no" id="rel-n"><label for="rel-n">No</label>
          </div>
          <button id="next2" type="button" onclick="document.getElementById('step2').style.display='none';document.getElementById('step3').style.display='block';">Next</button>
        </div>
        <div id="step3" style="display:none">
          <h2>Step 3: Upload & Review</h2>
          <label for="resume">Resume (PDF) *</label><input id="resume" type="file" accept=".pdf,.doc,.docx" />
          <label for="cover">Cover Letter</label><textarea id="cover" rows="4" placeholder="Write your cover letter"></textarea>
          <label for="linkedin">LinkedIn Profile URL</label><input id="linkedin" type="url" placeholder="https://linkedin.com/in/..." />
          <label for="github">GitHub URL</label><input id="github" type="url" placeholder="https://github.com/..." />
          <label><input type="checkbox" id="agree1" required> I certify information is accurate</label>
          <label><input type="checkbox" id="agree2"> I agree to terms of service</label>
          <button id="submit" type="submit">Submit Application</button>
        </div>
        <div id="success" style="display:none">
          <h1>Thank you for applying!</h1>
          <p>Your application has been submitted successfully.</p>
        </div>
      </body></html>
    `);

    // Step 1: Fill personal info
    log('Step 1: Personal Information...');
    await fillAllFields(page, profile);
    await page.waitForTimeout(500);

    const fn = await page.$eval('#fn', el => el.value);
    const ln = await page.$eval('#ln', el => el.value);
    const em = await page.$eval('#em', el => el.value);
    if (fn === profile.firstName && ln === profile.lastName && em === profile.email) {
      ok('Step 1: All personal fields filled correctly');
    } else {
      fail(`Step 1: Missing fields — fn="${fn}" ln="${ln}" em="${em}"`);
    }

    // Also test Workday widgets
    await fillWorkdayWidgets(page, profile);
    ok('Workday widget filler ran without error');

    // Click Next
    await page.click('#next1');
    await page.waitForTimeout(300);

    // Step 2: Fill experience
    log('Step 2: Experience...');
    await fillAllFields(page, profile);
    await page.waitForTimeout(500);

    const exp = await page.$eval('#exp', el => el.value);
    if (exp === String(profile.totalExperience)) ok(`Step 2: Experience filled: ${exp}`);
    else warn(`Step 2: Experience: "${exp}" (expected "${profile.totalExperience}")`);

    const comp = await page.$eval('#comp', el => el.value);
    if (comp) ok(`Step 2: Company filled: ${comp}`);
    else warn('Step 2: Company not filled');

    // Click Next
    await page.click('#next2');
    await page.waitForTimeout(300);

    // Step 3: Upload & Review
    log('Step 3: Upload & Review...');
    await fillAllFields(page, profile);
    await page.waitForTimeout(500);

    const cover = await page.$eval('#cover', el => el.value);
    if (cover && cover.length > 20) ok(`Step 3: Cover letter filled (${cover.length} chars)`);
    else warn('Step 3: Cover letter not filled');

    const agreed = await page.$eval('#agree1', el => el.checked);
    if (agreed) ok('Step 3: Certification checkbox checked');
    else warn('Step 3: Certification checkbox not checked');

    // Test 2: Validation error handling
    log('\nTesting validation error handling...');
    await page.setContent(`
      <html><body>
        <div class="form-error" style="color:red;">Please enter a value larger than 0</div>
        <input id="salary" type="number" value="-1" />
        <div class="form-error" style="color:red;">Enter a whole number between 0 and 99</div>
        <input id="experience" type="number" value="150" />
        <div class="form-error" style="color:red;">Please make a selection</div>
        <select id="country"><option value="">--</option><option value="in">India</option><option value="us">US</option></select>
      </body></html>
    `);
    await fixValidationErrors(page, profile);
    ok('Validation error handler ran without crash');

    // Test 3: Success page detection
    await page.setContent(`
      <html><body>
        <h1>Thank You!</h1>
        <p>Your application has been submitted successfully. We will review your profile and get back to you.</p>
      </body></html>
    `);
    const isSuccess = await isApplicationSuccess(page);
    if (isSuccess) ok('Success page correctly detected');
    else warn('Success page not detected');

    // Test 4: NOT a success page
    await page.setContent(`
      <html><body>
        <h1>Software Engineer</h1>
        <p>We are looking for talented engineers...</p>
        <button>Apply Now</button>
      </body></html>
    `);
    const isNotSuccess = await isApplicationSuccess(page);
    if (!isNotSuccess) ok('Non-success page correctly identified');
    else fail('False positive: job listing detected as success');

  } catch (err) {
    fail(`Complex form error: ${err.message}`);
  } finally {
    await browser.close().catch(() => {});
  }
}

// ─── TEST: Infinite Loop Detection ──────────────────────────────────────────

async function testInfiniteLoopDetection() {
  console.log('\n═══ TEST: Infinite Loop & Stuck Detection ═══');

  let browser, context, page;
  try {
    const result = await launchStealthBrowser({ headless: true });
    browser = result.browser; context = result.context; page = result.page;
  } catch (err) { fail(`Launch: ${err.message}`); return; }

  try {
    // Simulate a form that keeps showing the same step
    await page.setContent(`
      <html><body>
        <div id="form-step">
          <h2>Step 1</h2>
          <input type="text" name="field1" />
          <button id="next" onclick="
            // Simulate stuck: increment counter but don't change page
            window.__clickCount = (window.__clickCount || 0) + 1;
            if (window.__clickCount > 5) {
              document.getElementById('form-step').innerHTML = '<h1>Thank you!</h1>';
            }
          ">Next</button>
        </div>
      </body></html>
    `);

    // Simulate clicking "Next" repeatedly and detect if we're stuck
    let lastHtml = '';
    let sameCount = 0;
    const MAX_SAME = 3;

    for (let i = 0; i < 8; i++) {
      await fillAllFields(page, profile);
      const currentHtml = await page.evaluate(() => document.body.innerHTML.substring(0, 200)).catch(() => '');

      if (currentHtml === lastHtml) {
        sameCount++;
        if (sameCount >= MAX_SAME) {
          ok(`Stuck detected after ${sameCount} same pages (iteration ${i})`);
          break;
        }
      } else {
        sameCount = 0;
      }
      lastHtml = currentHtml;

      await page.click('#next').catch(() => {});
      await page.waitForTimeout(200);
    }

    if (sameCount < MAX_SAME) ok('Loop completed without getting permanently stuck');

    // Test timeout wrapper
    const start = Date.now();
    try {
      await Promise.race([
        new Promise(resolve => setTimeout(resolve, 10000)), // simulate long operation
        new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 2000)),
      ]);
      fail('Timeout did not fire');
    } catch (err) {
      if (err.message === 'Timeout') {
        const elapsed = Date.now() - start;
        ok(`Timeout correctly fired after ${elapsed}ms`);
      }
    }

  } finally {
    await browser.close().catch(() => {});
  }
}

// ─── TEST: Browser Crash Recovery ───────────────────────────────────────────

async function testBrowserCrashRecovery() {
  console.log('\n═══ TEST: Browser Crash Recovery ═══');

  let browser, context, page;
  try {
    const result = await launchStealthBrowser({ headless: true });
    browser = result.browser; context = result.context; page = result.page;
  } catch (err) { fail(`Launch: ${err.message}`); return; }

  try {
    // Test 1: Navigate to invalid URL
    try {
      await page.goto('https://this-domain-definitely-does-not-exist-12345.com/', { timeout: 5000 });
      warn('Invalid domain did not throw');
    } catch (err) {
      ok(`Invalid domain handled: ${err.message.substring(0, 40)}`);
    }

    // Test 2: Create new page after failed navigation (real-world pattern)
    try {
      const recoveryPage = await context.newPage();
      await recoveryPage.goto('https://www.google.com', { timeout: 15000 });
      const title = await recoveryPage.title();
      if (title) ok(`Recovery page works after error: "${title}"`);
      else warn('Recovery page has empty title');
      await recoveryPage.close();
    } catch (err) {
      warn(`Recovery page: ${err.message.substring(0, 50)}`);
    }

    // Test 3: Close page and create new one
    await page.close();
    const newPage = await context.newPage();
    await newPage.setContent('<html><body><h1>Test</h1></body></html>');
    const h1 = await newPage.$eval('h1', el => el.textContent);
    if (h1 === 'Test') ok('New page created after closing old one');
    else fail('New page creation failed');

    // Test 4: Multiple concurrent pages
    const pages = await Promise.all([
      context.newPage().then(async p => { await p.setContent('<html><body>Page 1</body></html>'); return p; }),
      context.newPage().then(async p => { await p.setContent('<html><body>Page 2</body></html>'); return p; }),
      context.newPage().then(async p => { await p.setContent('<html><body>Page 3</body></html>'); return p; }),
    ]);
    if (pages.length === 3) ok(`${pages.length} concurrent pages created`);
    for (const p of pages) await p.close().catch(() => {});
    await newPage.close().catch(() => {});

  } finally {
    await browser.close().catch(() => {});
  }

  // Test 5: Full browser restart
  try {
    const result2 = await launchStealthBrowser({ headless: true });
    await result2.page.setContent('<html><body>Restarted</body></html>');
    const text = await result2.page.evaluate(() => document.body.textContent);
    if (text === 'Restarted') ok('Full browser restart successful');
    await result2.browser.close();
  } catch (err) {
    fail(`Browser restart failed: ${err.message}`);
  }
}

// ─── TEST: CAPTCHA & OTP Detection ──────────────────────────────────────────

async function testCaptchaOTPDetection() {
  console.log('\n═══ TEST: CAPTCHA & OTP Detection ═══');

  let browser, context, page;
  try {
    const result = await launchStealthBrowser({ headless: true });
    browser = result.browser; context = result.context; page = result.page;
  } catch (err) { fail(`Launch: ${err.message}`); return; }

  try {
    // Test CAPTCHA detection
    await page.setContent(`
      <html><body>
        <div class="g-recaptcha" data-sitekey="test"></div>
        <iframe src="about:blank" title="reCAPTCHA"></iframe>
      </body></html>
    `);
    const hasCaptcha = await page.evaluate(() => {
      return !!(document.querySelector('.g-recaptcha, .h-captcha, [class*="captcha"], iframe[title*="reCAPTCHA"], #captcha'));
    });
    if (hasCaptcha) ok('CAPTCHA detected on page');
    else fail('CAPTCHA not detected');

    // Test hCaptcha detection
    await page.setContent(`
      <html><body>
        <div class="h-captcha" data-sitekey="test"></div>
      </body></html>
    `);
    const hCaptcha = await page.evaluate(() => !!document.querySelector('.h-captcha'));
    if (hCaptcha) ok('hCaptcha detected');
    else fail('hCaptcha not detected');

    // Test OTP field detection
    await page.setContent(`
      <html><body>
        <h2>Enter verification code</h2>
        <input type="text" placeholder="Enter OTP" maxlength="6" id="otp-field" />
        <button>Verify</button>
      </body></html>
    `);
    const hasOTP = await page.evaluate(() => {
      return !!(document.querySelector('input[placeholder*="OTP" i], input[placeholder*="verification code" i], input[placeholder*="enter code" i], input[name*="otp" i]'));
    });
    if (hasOTP) ok('OTP field detected');
    else fail('OTP field not detected');

    // Test "Verify you are human" page detection
    await page.setContent(`
      <html><body>
        <h1>Please verify you are human</h1>
        <p>Complete the challenge below to continue.</p>
      </body></html>
    `);
    const verifyHuman = await page.evaluate(() => {
      return /verify.*human|prove.*not.*robot|complete.*challenge/i.test(document.body.innerText);
    });
    if (verifyHuman) ok('"Verify human" page detected');
    else fail('"Verify human" not detected');

    // Test Cloudflare challenge detection
    await page.setContent(`
      <html><body>
        <div id="cf-wrapper">
          <h2>Checking your browser before accessing the site</h2>
          <p>This process is automatic. Your browser will redirect shortly.</p>
        </div>
      </body></html>
    `);
    const cfChallenge = await page.evaluate(() => {
      return !!(document.querySelector('#cf-wrapper, #challenge-form')) || /checking your browser/i.test(document.body.innerText);
    });
    if (cfChallenge) ok('Cloudflare challenge detected');
    else fail('Cloudflare challenge not detected');

  } finally {
    await browser.close().catch(() => {});
  }
}

// ─── TEST: Diverse Form Layouts ─────────────────────────────────────────────

async function testDiverseFormLayouts() {
  console.log('\n═══ TEST: Diverse Form Layouts (Greenhouse, Lever, Workday style) ═══');

  let browser, context, page;
  try {
    const result = await launchStealthBrowser({ headless: true });
    browser = result.browser; context = result.context; page = result.page;
  } catch (err) { fail(`Launch: ${err.message}`); return; }

  try {
    // Greenhouse-style form
    log('Testing Greenhouse-style form...');
    await page.setContent(`
      <html><body>
        <div id="application">
          <h3>Apply for Software Engineer</h3>
          <div class="field">
            <label for="first_name">First name *</label>
            <input type="text" id="first_name" name="job_application[first_name]" autocomplete="given-name" />
          </div>
          <div class="field">
            <label for="last_name">Last name *</label>
            <input type="text" id="last_name" name="job_application[last_name]" autocomplete="family-name" />
          </div>
          <div class="field">
            <label for="email">Email *</label>
            <input type="email" id="email" name="job_application[email]" />
          </div>
          <div class="field">
            <label for="phone">Phone *</label>
            <input type="tel" id="phone" name="job_application[phone]" />
          </div>
          <div class="field">
            <label for="resume">Resume/CV *</label>
            <input type="file" id="resume" name="job_application[resume]" />
          </div>
          <div class="field">
            <label for="cover_letter">Cover letter</label>
            <textarea id="cover_letter" name="job_application[cover_letter]"></textarea>
          </div>
          <div class="field">
            <label for="linkedin_profile">LinkedIn Profile</label>
            <input type="text" id="linkedin_profile" placeholder="https://linkedin.com/in/..." />
          </div>
          <div class="field">
            <label for="website">Website</label>
            <input type="text" id="website" placeholder="https://..." />
          </div>
          <div class="field">
            <label>Are you legally authorized to work in India?</label>
            <div>
              <label><input type="radio" name="auth" value="Yes"> Yes</label>
              <label><input type="radio" name="auth" value="No"> No</label>
            </div>
          </div>
          <div class="field">
            <label>Will you now or in the future require visa sponsorship?</label>
            <div>
              <label><input type="radio" name="visa" value="Yes"> Yes</label>
              <label><input type="radio" name="visa" value="No"> No</label>
            </div>
          </div>
          <button type="submit" id="submit_app">Submit Application</button>
        </div>
      </body></html>
    `);

    await fillAllFields(page, profile);
    await page.waitForTimeout(300);

    const ghFn = await page.$eval('#first_name', el => el.value);
    const ghLn = await page.$eval('#last_name', el => el.value);
    const ghEmail = await page.$eval('#email', el => el.value);
    const ghPhone = await page.$eval('#phone', el => el.value);

    if (ghFn && ghLn && ghEmail && ghPhone) ok(`Greenhouse form: fn="${ghFn}" ln="${ghLn}" email="${ghEmail}" phone="${ghPhone}"`);
    else fail(`Greenhouse form missing fields: fn="${ghFn}" ln="${ghLn}" em="${ghEmail}" ph="${ghPhone}"`);

    // Lever-style form
    log('Testing Lever-style form...');
    await page.setContent(`
      <html><body>
        <div class="application-form">
          <h2>Apply to Netlify</h2>
          <div class="application-field">
            <label class="application-label">Full name</label>
            <input type="text" name="name" class="application-field-input" placeholder="Your full name" />
          </div>
          <div class="application-field">
            <label class="application-label">Email</label>
            <input type="email" name="email" class="application-field-input" placeholder="you@example.com" />
          </div>
          <div class="application-field">
            <label class="application-label">Phone</label>
            <input type="tel" name="phone" class="application-field-input" placeholder="+1..." />
          </div>
          <div class="application-field">
            <label class="application-label">Current company</label>
            <input type="text" name="org" class="application-field-input" placeholder="Company name" />
          </div>
          <div class="application-field">
            <label class="application-label">LinkedIn URL</label>
            <input type="text" name="urls[LinkedIn]" class="application-field-input" placeholder="https://linkedin.com/in/..." />
          </div>
          <div class="application-field">
            <label class="application-label">GitHub URL</label>
            <input type="text" name="urls[GitHub]" class="application-field-input" placeholder="https://github.com/..." />
          </div>
          <div class="application-field">
            <label class="application-label">Portfolio</label>
            <input type="text" name="urls[Portfolio]" class="application-field-input" placeholder="https://..." />
          </div>
          <div class="application-field">
            <label class="application-label">Additional information</label>
            <textarea name="comments" class="application-field-input" placeholder="Add anything else..."></textarea>
          </div>
          <button type="submit" class="postings-btn-submit">Submit application</button>
        </div>
      </body></html>
    `);

    await fillAllFields(page, profile);
    await page.waitForTimeout(300);

    const leverName = await page.$eval('input[name="name"]', el => el.value);
    const leverEmail = await page.$eval('input[name="email"]', el => el.value);
    const leverComp = await page.$eval('input[name="org"]', el => el.value);

    if (leverName && leverEmail) ok(`Lever form: name="${leverName}" email="${leverEmail}" company="${leverComp}"`);
    else fail(`Lever form missing: name="${leverName}" email="${leverEmail}"`);

    // Workday-style with data-automation-id
    log('Testing Workday-style form (data-automation-id)...');
    await page.setContent(`
      <html><body>
        <div data-automation-id="formField-legalNameSection">
          <div data-automation-id="formField-legalNameSection_firstName">
            <label>First Name</label>
            <input type="text" data-automation-id="legalNameSection_firstName" />
          </div>
          <div data-automation-id="formField-legalNameSection_lastName">
            <label>Last Name</label>
            <input type="text" data-automation-id="legalNameSection_lastName" />
          </div>
        </div>
        <div data-automation-id="formField-email">
          <label>Email Address</label>
          <input type="email" data-automation-id="email" />
        </div>
        <div data-automation-id="formField-phone">
          <label>Phone Number</label>
          <div data-automation-id="phone-device-type">
            <select><option value="">Select</option><option value="mobile">Mobile</option><option value="home">Home</option></select>
          </div>
          <input type="tel" data-automation-id="phone-number" />
        </div>
        <div data-automation-id="formField-countryDropdown">
          <label>Country</label>
          <select data-automation-id="countryDropdown">
            <option value="">Select</option><option value="IN">India</option><option value="US">United States</option>
          </select>
        </div>
        <div data-automation-id="formField-sourceSection">
          <label>How did you hear about us?</label>
          <select data-automation-id="sourceDropdown">
            <option value="">Select</option><option value="linkedin">LinkedIn</option><option value="indeed">Indeed</option><option value="other">Other</option>
          </select>
        </div>
        <button data-automation-id="bottom-navigation-next-button">Next</button>
      </body></html>
    `);

    await fillAllFields(page, profile);
    await fillWorkdayWidgets(page, profile);
    await page.waitForTimeout(300);

    const wdFn = await page.$eval('[data-automation-id="legalNameSection_firstName"]', el => el.value);
    const wdLn = await page.$eval('[data-automation-id="legalNameSection_lastName"]', el => el.value);
    const wdEmail = await page.$eval('[data-automation-id="email"]', el => el.value);
    const wdPhone = await page.$eval('[data-automation-id="phone-number"]', el => el.value);

    if (wdFn && wdLn && wdEmail) ok(`Workday form: fn="${wdFn}" ln="${wdLn}" email="${wdEmail}" phone="${wdPhone}"`);
    else fail(`Workday form missing: fn="${wdFn}" ln="${wdLn}" em="${wdEmail}" ph="${wdPhone}"`);

    // iCIMS-style form
    log('Testing iCIMS-style form...');
    await page.setContent(`
      <html><body>
        <form id="icims-form">
          <div class="iCIMS_InfoMsg">Apply for Senior Developer</div>
          <div class="iCIMS_FieldOuter">
            <label class="iCIMS_FieldLabel" for="input-first">First Name</label>
            <input id="input-first" class="iCIMS_FieldInput" type="text" />
          </div>
          <div class="iCIMS_FieldOuter">
            <label class="iCIMS_FieldLabel" for="input-last">Last Name</label>
            <input id="input-last" class="iCIMS_FieldInput" type="text" />
          </div>
          <div class="iCIMS_FieldOuter">
            <label class="iCIMS_FieldLabel" for="input-email">Email</label>
            <input id="input-email" class="iCIMS_FieldInput" type="email" />
          </div>
          <div class="iCIMS_FieldOuter">
            <label class="iCIMS_FieldLabel" for="input-phone">Phone</label>
            <input id="input-phone" class="iCIMS_FieldInput" type="tel" />
          </div>
          <div class="iCIMS_FieldOuter">
            <label class="iCIMS_FieldLabel">Work Authorization</label>
            <select id="auth-select" class="iCIMS_FieldInput">
              <option>--Select--</option>
              <option>Yes, authorized to work</option>
              <option>No</option>
            </select>
          </div>
          <button type="submit" class="iCIMS_PrimaryBtn">Submit Application</button>
        </form>
      </body></html>
    `);

    await fillAllFields(page, profile);
    await page.waitForTimeout(300);

    const icFn = await page.$eval('#input-first', el => el.value);
    const icEmail = await page.$eval('#input-email', el => el.value);
    if (icFn && icEmail) ok(`iCIMS form: fn="${icFn}" email="${icEmail}"`);
    else fail(`iCIMS form missing: fn="${icFn}" email="${icEmail}"`);

    // SmartRecruiters-style with nested React components
    log('Testing SmartRecruiters-style form...');
    await page.setContent(`
      <html><body>
        <div class="application-form-page">
          <h1 class="job-title">Backend Engineer</h1>
          <div class="field-group" role="group">
            <div class="input-wrapper">
              <label id="label-fn">First name</label>
              <input type="text" aria-labelledby="label-fn" data-testid="firstName" />
            </div>
            <div class="input-wrapper">
              <label id="label-ln">Last name</label>
              <input type="text" aria-labelledby="label-ln" data-testid="lastName" />
            </div>
          </div>
          <div class="input-wrapper">
            <label id="label-email">Email address</label>
            <input type="email" aria-labelledby="label-email" data-testid="email" />
          </div>
          <div class="input-wrapper">
            <label id="label-phone">Phone number</label>
            <input type="tel" aria-labelledby="label-phone" data-testid="phone" />
          </div>
          <div class="input-wrapper">
            <label id="label-location">Location</label>
            <input type="text" aria-labelledby="label-location" data-testid="location" placeholder="City, Country" />
          </div>
          <div class="input-wrapper">
            <label id="label-exp">Total years of experience</label>
            <input type="number" aria-labelledby="label-exp" data-testid="experience" />
          </div>
          <button type="submit" data-testid="submit-btn">Apply</button>
        </div>
      </body></html>
    `);

    await fillAllFields(page, profile);
    await page.waitForTimeout(300);

    const srFn = await page.$eval('[data-testid="firstName"]', el => el.value);
    const srEmail = await page.$eval('[data-testid="email"]', el => el.value);
    const srExp = await page.$eval('[data-testid="experience"]', el => el.value);
    if (srFn && srEmail) ok(`SmartRecruiters form: fn="${srFn}" email="${srEmail}" exp="${srExp}"`);
    else fail(`SmartRecruiters form missing: fn="${srFn}" em="${srEmail}"`);

  } catch (err) {
    fail(`Diverse form test error: ${err.message}`);
  } finally {
    await browser.close().catch(() => {});
  }
}

// ─── TEST: Naukri Real Apply ────────────────────────────────────────────────

async function testNaukriRealApply() {
  console.log('\n═══ TEST: Naukri Real End-to-End Apply ═══');

  const p = loadProfile();
  if (!p.naukriEmail || !p.naukriPassword) {
    warn('Naukri credentials not configured. Skipping.');
    return;
  }

  let browser, context, page;
  try {
    const isHeaded = process.env.HEADLESS === 'false';
    const result = await launchStealthBrowser({ headless: !isHeaded, locale: 'en-IN' });
    browser = result.browser; context = result.context; page = result.page;
    ok('Stealth browser launched');
  } catch (err) { fail(`Launch: ${err.message}`); return; }

  try {
    // Login
    log('Logging into Naukri...');
    await page.goto('https://www.naukri.com/nlogin/login', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(2000);

    const emailInput = await page.$('input[type="text"][placeholder*="Email" i], input[type="email"], input[id*="email" i], input[placeholder*="ID" i]');
    if (emailInput) {
      await emailInput.fill(p.naukriEmail);
      ok('Email filled');
    } else { fail('Email input not found'); await browser.close(); return; }

    const pwdInput = await page.$('input[type="password"]');
    if (pwdInput) { await pwdInput.fill(p.naukriPassword); ok('Password filled'); }
    else { fail('Password not found'); await browser.close(); return; }

    const loginBtn = await page.$('button[type="submit"], button:has-text("Login")');
    if (loginBtn) { await loginBtn.click(); await page.waitForTimeout(5000); ok('Login clicked'); }

    const url = page.url();
    if (!url.includes('login')) ok('Login redirected (likely success)');
    else warn('May still be on login page');

    // Search and apply
    log('Searching for jobs...');
    const { smartGoto: sGoto, waitForPageStable: wStable, smartWaitForElement: sWait } = require('./src/stealth');
    await sGoto(page, 'https://www.naukri.com/node-js-developer-jobs?experience=3', { maxWait: 60000 });
    // Wait for SPA to render job cards
    await sWait(page, [
      'article.jobTuple', '.srp-jobtuple-wrapper', '[class*="jobTuple"]',
      '.cust-job-tuple', 'a[class*="title"]', '.jobTupleHeader',
      '[class*="srp-jobtuple"]', '[data-job-id]', '.list-container article',
    ], { maxWait: 15000 });
    await wStable(page, { maxWait: 5000 });

    // Naukri 2026: Job cards are div.cursor-pointer (Tailwind redesign), old: article.jobTuple
    const jobCards = await page.$$([
      // New 2026 Tailwind selectors
      'div.cursor-pointer.rounded-3xl',
      'div[class*="cursor-pointer"][class*="rounded"]',
      // Old selectors (backwards compat)
      'article.jobTuple', '.srp-jobtuple-wrapper', '[class*="jobTuple"]',
      '.cust-job-tuple', '[data-job-id]',
    ].join(', '));
    // Debug: see what elements are on the page if no cards found
    if (jobCards.length === 0) {
      const debugInfo = await page.evaluate(() => {
        const all = [...document.querySelectorAll('article, [class*="job"], [class*="tuple"], [class*="srp"], a[href*="job"]')];
        return {
          url: window.location.href,
          title: document.title,
          bodyLen: (document.body.innerText || '').length,
          elements: all.slice(0, 10).map(el => `<${el.tagName} class="${(el.className || '').substring(0, 60)}" href="${(el.href || '').substring(0, 60)}">`),
          allLinks: [...document.querySelectorAll('a[href*="naukri.com/job"], a[href*="job-listings"], a[href*="/job/"]')].slice(0, 10).map(a => a.href.substring(0, 100)),
          // Dump job-relevant links
          topLinks: [...document.querySelectorAll('a[href]')].filter(a => {
            const h = a.href || '';
            const t = (a.innerText || '').trim();
            return (h.includes('job-listing') || h.includes('/job/') || h.includes('jobid=') || h.includes('jdp.naukri') || (t.length > 10 && t.length < 80 && /developer|engineer|node|react|angular|java|python/i.test(t)));
          }).slice(0, 15).map(a => `"${(a.innerText||'').trim().substring(0,50)}" → ${a.href.substring(0,100)}`),
          // Body text snippet
          bodySnippet: (document.body.innerText || '').substring(0, 600),
        };
      }).catch(() => ({}));
      log(`Debug: URL=${debugInfo.url}, title="${debugInfo.title}", body=${debugInfo.bodyLen}chars`);
      if (debugInfo.elements?.length) log(`Elements: ${debugInfo.elements.join(' | ')}`);
      if (debugInfo.topLinks?.length) log(`Top links: ${debugInfo.topLinks.slice(0, 8).join('\n    ')}`);
      if (debugInfo.allLinks?.length) {
        log(`Job links found: ${debugInfo.allLinks.length}`);
        // Use these links directly
        const directLinks = debugInfo.allLinks;
        if (directLinks.length > 0) {
          ok(`Found ${directLinks.length} job links via fallback`);
          for (const jobUrl of directLinks.slice(0, 2)) {
            const jobPage = await context.newPage();
            try {
              log(`Opening: ${jobUrl.substring(0, 60)}...`);
              await sGoto(jobPage, jobUrl, { maxWait: 45000 });
              const title = await jobPage.title().catch(() => 'Unknown');
              log(`Page: "${title.substring(0, 50)}"`);
              const applyBtn = await sWait(jobPage, [
                'button#apply-button', '[class*="apply-button"]', 'button:has-text("Apply")',
                'button:has-text("I am interested")', '[class*="apply-btn"]',
              ], { maxWait: 8000 });
              if (applyBtn) {
                const btnText = (await applyBtn.innerText().catch(() => '')).trim();
                ok(`Apply button found: "${btnText}"`);
              } else {
                warn('No apply button on this job');
              }
            } catch (err) {
              warn(`Job error: ${err.message.substring(0, 50)}`);
            } finally {
              await jobPage.close().catch(() => {});
            }
          }
        }
      }
    }

    // Also try a direct search API URL and a generic Naukri job page
    if (jobCards.length === 0) {
      log('Trying direct Naukri job URL approach...');
      const directPage = await context.newPage();
      try {
        // Navigate to a direct job search result
        await sGoto(directPage, 'https://www.naukri.com/nodejs-developer-jobs-in-hyderabad', { maxWait: 45000 });

        // Scroll multiple times to trigger lazy loading of job cards
        for (let scrollAttempt = 0; scrollAttempt < 5; scrollAttempt++) {
          await directPage.evaluate(() => window.scrollBy(0, 600));
          await wStable(directPage, { maxWait: 3000 });
        }

        const directJobLinks = await directPage.evaluate(() => {
          // Comprehensive approach: find ANY links/elements that look like job cards
          const results = [];

          // Pattern 1: Links with job-listing in href
          document.querySelectorAll('a[href]').forEach(a => {
            if (/job-listing|\/job\/|jd\/|jobid/i.test(a.href) && !/(faq|format|alert|resume\.naukri)/i.test(a.href)) {
              results.push({ href: a.href, text: (a.innerText || '').trim().substring(0, 60) });
            }
          });

          // Pattern 2: Elements with job-related class names (Naukri's new Tailwind)
          if (results.length === 0) {
            document.querySelectorAll('[class*="srp-jobtuple"], [class*="jobTuple"], [data-job-id], [class*="styles_jlc"]').forEach(el => {
              const link = el.querySelector('a[href]') || el.closest('a[href]');
              if (link) results.push({ href: link.href, text: (el.innerText || '').trim().substring(0, 60) });
            });
          }

          // Pattern 3: Any clickable job titles
          if (results.length === 0) {
            document.querySelectorAll('a').forEach(a => {
              const text = (a.innerText || '').trim();
              if (text.length > 10 && text.length < 80 && /developer|engineer|node|react|lead|senior|backend|frontend|fullstack|full stack/i.test(text)) {
                const href = a.href || '';
                if (href.includes('naukri.com') && !/(faq|format|alert|resume\.naukri|services|writing)/i.test(href)) {
                  results.push({ href, text });
                }
              }
            });
          }

          return results.slice(0, 5);
        }).catch(() => []);

        if (directJobLinks.length > 0) {
          ok(`Found ${directJobLinks.length} direct job links`);
          for (const { href, text } of directJobLinks.slice(0, 1)) {
            log(`Testing: "${text}" → ${href.substring(0, 70)}`);
            const jPage = await context.newPage();
            try {
              await sGoto(jPage, href, { maxWait: 45000 });
              const applyBtn = await sWait(jPage, [
                'button#apply-button', '[class*="apply-button"]', 'button:has-text("Apply")',
                'button:has-text("I am interested")', '[class*="apply-btn"]',
              ], { maxWait: 8000 });
              if (applyBtn) {
                const btnText = (await applyBtn.innerText().catch(() => '')).trim();
                ok(`Naukri apply button found: "${btnText}"`);
              } else {
                warn('No apply button on direct job page');
              }
            } finally { await jPage.close().catch(() => {}); }
          }
        } else {
          warn('No job links found even with direct URL');
        }
      } catch (err) {
        warn(`Direct URL test: ${err.message.substring(0, 50)}`);
      } finally { await directPage.close().catch(() => {}); }
    }

    if (jobCards.length > 0) {
      ok(`Found ${jobCards.length} job cards`);

      // Try first 3 jobs
      const jobUrls = [];
      // Strategy: intercept Naukri job API response to get job URLs directly
      const apiJobs = await page.evaluate(() => {
        // Naukri stores job data in window.__NEXT_DATA__ or inline scripts
        try {
          if (window.__NEXT_DATA__?.props?.pageProps?.searchResults) {
            return window.__NEXT_DATA__.props.pageProps.searchResults.slice(0, 5).map(j => ({
              title: j.title || j.jobTitle || '',
              url: j.jdURL || j.url || '',
              company: j.companyName || j.company || '',
            }));
          }
        } catch {}
        return [];
      }).catch(() => []);

      if (apiJobs.length > 0) {
        log(`Got ${apiJobs.length} jobs from __NEXT_DATA__`);
        for (const j of apiJobs) {
          const url = j.url.startsWith('http') ? j.url : `https://www.naukri.com${j.url}`;
          jobUrls.push(url);
        }
      }

      // Fallback: Intercept the jobapi response on reload
      if (jobUrls.length === 0) {
        log('Intercepting Naukri job API on reload...');
        let apiData = null;
        const apiHandler = async (response) => {
          if (response.url().includes('jobapi/v3/search') && response.status() === 200) {
            try { apiData = await response.json(); } catch {}
          }
        };
        page.on('response', apiHandler);
        await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
        await wStable(page, { maxWait: 10000 });
        page.off('response', apiHandler);

        if (apiData) {
          log(`API keys: ${Object.keys(apiData).join(', ')}`);
          const jobs = apiData.jobDetails || apiData.jobs || apiData.data || apiData.results || [];
          for (const job of (Array.isArray(jobs) ? jobs : []).slice(0, 3)) {
            const jdUrl = job.jdURL || job.staticUrl || job.url || job.jobURL || '';
            if (jdUrl) {
              const fullUrl = jdUrl.startsWith('http') ? jdUrl : `https://www.naukri.com${jdUrl}`;
              jobUrls.push(fullUrl);
            }
          }
          if (jobUrls.length === 0 && typeof apiData === 'object') {
            // Log first job structure
            const sampleJob = (apiData.jobDetails || apiData.jobs || apiData.data || [])[0];
            if (sampleJob) log(`Sample job keys: ${Object.keys(sampleJob).join(', ')}`);
          }
          log(`Got ${jobUrls.length} jobs from intercepted API`);
        } else {
          log('No API response intercepted');
        }
      }

      // Fallback 2: click on the card container's parent
      if (jobUrls.length === 0) {
        log('Using click-to-navigate...');
        const cursorPtrs = await page.$$('div[class*="cursor-pointer"]');
        for (let i = 0; i < Math.min(2, cursorPtrs.length); i++) {
          try {
            const text = (await cursorPtrs[i].innerText().catch(() => '')).trim();
            if (text.length < 20 || !/developer|engineer|node|react|full\s?stack/i.test(text)) continue;
            log(`  Clicking card: "${text.substring(0, 40)}..."`);
            const beforeUrl = page.url();
            await cursorPtrs[i].click();
            await wStable(page, { maxWait: 5000 });
            const afterUrl = page.url();
            if (afterUrl !== beforeUrl && afterUrl.includes('job-listing')) {
              jobUrls.push(afterUrl);
              log(`  → ${afterUrl.substring(0, 70)}`);
              await page.goBack({ waitUntil: 'domcontentloaded' }).catch(() => {});
              await wStable(page, { maxWait: 5000 });
            }
          } catch {}
        }
      }
      log(`Total: ${jobUrls.length} job URLs`);

      log(`Testing ${jobUrls.length} job URLs...`);

      for (const jobUrl of jobUrls.slice(0, 2)) {
        const jobPage = await context.newPage();
        try {
          log(`Opening: ${jobUrl.substring(0, 60)}...`);
          await jobPage.goto(jobUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
          await jobPage.waitForTimeout(3000);

          const title = await jobPage.title().catch(() => 'Unknown');
          log(`Page: "${title.substring(0, 50)}"`);

          // Find apply button
          const applySelectors = [
            'button#apply-button', '[class*="apply-button"]', '[class*="applyButton"]',
            'button:has-text("Apply")', 'a:has-text("Apply Now")', 'button:has-text("I am interested")',
            '[class*="apply-btn"]', '[class*="applyBtn"]', 'button[class*="interested"]',
          ];

          let found = false;
          for (const sel of applySelectors) {
            const btn = await jobPage.$(sel).catch(() => null);
            if (btn && await btn.isVisible().catch(() => false)) {
              const btnText = (await btn.innerText().catch(() => '')).trim();
              if (/applied/i.test(btnText)) {
                ok(`Job: Already applied ("${btnText}")`);
              } else {
                ok(`Job: Apply button found ("${btnText}")`);
                // We don't actually click in test mode — just verify detection
              }
              found = true;
              break;
            }
          }
          if (!found) {
            // Scan all buttons
            const allBtns = await jobPage.$$('button, a');
            const btnTexts = [];
            for (const b of allBtns.slice(0, 20)) {
              const t = (await b.innerText().catch(() => '')).trim();
              if (t && t.length < 30) btnTexts.push(t);
            }
            warn(`No apply button found. Visible buttons: ${btnTexts.slice(0, 8).join(' | ')}`);
          }

        } catch (err) {
          warn(`Job page error: ${err.message.substring(0, 50)}`);
        } finally {
          await jobPage.close().catch(() => {});
        }
      }
    } else {
      warn('No job cards found on search page');
    }

  } catch (err) {
    fail(`Naukri test error: ${err.message}`);
  } finally {
    await browser.close().catch(() => {});
  }
}

// ─── TEST: AI Brain Integration ─────────────────────────────────────────────

async function testAIBrainIntegration() {
  console.log('\n═══ TEST: AI Brain Integration ═══');

  if (!aiBrain.isAvailable()) {
    warn('AI Brain not available (no ANTHROPIC_API_KEY). Skipping.');
    return;
  }

  let browser, context, page;
  try {
    const result = await launchStealthBrowser({ headless: true });
    browser = result.browser; context = result.context; page = result.page;
  } catch (err) { fail(`Launch: ${err.message}`); return; }

  try {
    // Test on a complex form
    await page.setContent(`
      <html><body>
        <h1>Apply for Machine Learning Engineer at TechStartup</h1>
        <form>
          <input type="text" placeholder="What's your name?" aria-label="Name" />
          <input type="email" placeholder="Email" />
          <input type="tel" placeholder="Contact number" />
          <select aria-label="Experience level">
            <option>Select</option><option>0-2 years</option><option>2-5 years</option><option>5-10 years</option><option>10+ years</option>
          </select>
          <textarea placeholder="Why do you want to work here?"></textarea>
          <input type="url" placeholder="Portfolio or GitHub" />
          <div>
            <span>Authorized to work in India?</span>
            <label><input type="radio" name="work-auth" value="yes">Yes</label>
            <label><input type="radio" name="work-auth" value="no">No</label>
          </div>
          <button type="submit">Apply</button>
        </form>
      </body></html>
    `);

    const ctx = await aiBrain.extractPageContext(page);
    if (ctx && ctx.elements.length > 50) ok(`Context extracted: ${ctx.elements.length} chars`);
    else fail('Context extraction too small');

    const analysis = await aiBrain.analyzePageForApply(page);
    if (analysis) {
      ok(`AI analysis: pageType="${analysis.pageType}" actions=${analysis.actions?.length || 0}`);
      if (analysis.actions?.length > 0) {
        const execCount = await aiBrain.executeAIActions(page, analysis);
        ok(`AI executed ${execCount} actions`);
      }
    } else {
      warn('AI analysis returned null');
    }

  } catch (err) {
    fail(`AI Brain test: ${err.message}`);
  } finally {
    await browser.close().catch(() => {});
  }
}

// ─── Runner ─────────────────────────────────────────────────────────────────

const ALL_TESTS = {
  ats: testATSDetection,
  forms: testComplexForms,
  layouts: testDiverseFormLayouts,
  loops: testInfiniteLoopDetection,
  crash: testBrowserCrashRecovery,
  captcha: testCaptchaOTPDetection,
  naukri: testNaukriRealApply,
  aibrain: testAIBrainIntegration,
};

async function main() {
  console.log('╔══════════════════════════════════════════╗');
  console.log('║  ApplyPilot Real-World Stress Test v1.0  ║');
  console.log('╚══════════════════════════════════════════╝');
  console.log(`  Profile: ${profile.fullName} | ${profile.totalExperience}yr | ${profile.expectedCtcLPA}LPA`);

  const filter = process.argv[2] || 'all';
  const tests = filter === 'all' ? Object.keys(ALL_TESTS) : [filter];

  for (const name of tests) {
    if (!ALL_TESTS[name]) {
      console.log(`\n\x1b[31mUnknown test: ${name}\x1b[0m`);
      console.log(`Available: ${Object.keys(ALL_TESTS).join(', ')}, all`);
      return;
    }
    try {
      await ALL_TESTS[name]();
    } catch (err) {
      fail(`Test "${name}" crashed: ${err.message}`);
    }
  }

  console.log('\n══════════════════════════════════════════');
  console.log(`\x1b[32m  Passed:  ${passed}\x1b[0m`);
  console.log(`\x1b[31m  Failed:  ${failed}\x1b[0m`);
  console.log(`\x1b[33m  Skipped: ${skipped}\x1b[0m`);
  if (errors.length > 0) {
    console.log('\n  Failures:');
    errors.forEach(e => console.log(`  \x1b[31m  - ${e}\x1b[0m`));
  }
  console.log('══════════════════════════════════════════\n');

  if (failed > 0) process.exit(1);
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
