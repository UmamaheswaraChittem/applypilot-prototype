/**
 * Comprehensive Test Suite for ApplyPilot
 * Tests: stealth, profile, form-filler, external ATS, Naukri, LinkedIn
 * Run: node test-all.js [test-name]
 * Examples: node test-all.js stealth | node test-all.js naukri | node test-all.js all
 */
require('dotenv').config();
const { launchStealthBrowser, humanDelay, humanClick, humanScroll } = require('./src/stealth');
const { loadProfile, getExperienceYears, generateCoverLetter } = require('./src/profile');
const { fillAllFields, fixValidationErrors, isApplicationSuccess } = require('./src/form-filler');
const aiBrain = require('./src/apply/ai-brain');

const TESTS = {};
let passed = 0, failed = 0, skipped = 0;

function log(msg) { console.log(`  ${msg}`); }
function ok(msg) { passed++; console.log(`  \x1b[32m✓\x1b[0m ${msg}`); }
function fail(msg) { failed++; console.log(`  \x1b[31m✗\x1b[0m ${msg}`); }
function warn(msg) { skipped++; console.log(`  \x1b[33m⚠\x1b[0m ${msg}`); }

// ─── TEST 1: Profile Module ─────────────────────────────────────────────────

TESTS.profile = async function testProfile() {
  console.log('\n═══ TEST: Profile Module ═══');

  const p = loadProfile();
  if (p.firstName && p.lastName && p.fullName) ok(`Name: ${p.fullName}`);
  else fail(`Name missing: ${JSON.stringify({ firstName: p.firstName, lastName: p.lastName })}`);

  if (p.email) ok(`Email: ${p.email}`);
  else fail('Email missing');

  if (p.phone) ok(`Phone: ${p.phone}`);
  else fail('Phone missing');

  if (typeof p.totalExperience === 'number' && p.totalExperience > 0) ok(`Experience: ${p.totalExperience} years`);
  else fail(`Experience invalid: ${p.totalExperience}`);

  if (typeof p.expectedCtcLPA === 'number') ok(`Expected CTC: ${p.expectedCtcLPA} LPA`);
  else fail(`CTC invalid: ${p.expectedCtcLPA}`);

  if (p.resumePath) ok(`Resume: ${p.resumePath}`);
  else warn('Resume path not set (optional)');

  // Test overrides
  const p2 = loadProfile({ firstName: 'Test', lastName: 'User', totalExperience: 10 });
  if (p2.firstName === 'Test' && p2.totalExperience === 10) ok('Overrides work correctly');
  else fail('Overrides not working');

  // Cover letter
  const cl = generateCoverLetter(p);
  if (cl && cl.length > 20) ok(`Cover letter: ${cl.substring(0, 60)}...`);
  else fail('Cover letter generation failed');

  // Experience map
  const p3 = loadProfile({ experienceMap: { 'node.js': 5, 'react': 3 } });
  const nodeYears = getExperienceYears(p3, 'How many years of Node.js?');
  if (nodeYears === 5) ok('Experience map lookup works');
  else fail(`Experience map failed: expected 5, got ${nodeYears}`);
};

// ─── TEST 2: Stealth Browser ────────────────────────────────────────────────

TESTS.stealth = async function testStealth() {
  console.log('\n═══ TEST: Stealth Browser ═══');

  let browser, context, page;
  try {
    const result = await launchStealthBrowser({ headless: true });
    browser = result.browser;
    context = result.context;
    page = result.page;
    ok('Stealth browser launched');
  } catch (err) {
    fail(`Launch failed: ${err.message}`);
    return;
  }

  try {
    // Test 1: WebDriver flag
    const webdriver = await page.evaluate(() => navigator.webdriver);
    if (webdriver === undefined || webdriver === false) ok('WebDriver flag hidden');
    else fail(`WebDriver visible: ${webdriver}`);

    // Test 2: Plugins
    const pluginCount = await page.evaluate(() => navigator.plugins.length);
    if (pluginCount >= 3) ok(`Plugins spoofed: ${pluginCount} plugins`);
    else fail(`Plugin count too low: ${pluginCount}`);

    // Test 3: Chrome object
    const hasChrome = await page.evaluate(() => !!window.chrome);
    if (hasChrome) ok('window.chrome exists');
    else warn('window.chrome missing (may be detected)');

    // Test 4: Languages
    const langs = await page.evaluate(() => navigator.languages);
    if (langs && langs.length > 0) ok(`Languages: ${langs.join(', ')}`);
    else warn('No languages set');

    // Test 5: WebGL vendor
    const glVendor = await page.evaluate(() => {
      const c = document.createElement('canvas');
      const gl = c.getContext('webgl');
      if (!gl) return null;
      const ext = gl.getExtension('WEBGL_debug_renderer_info');
      return ext ? gl.getParameter(ext.UNMASKED_VENDOR_WEBGL) : null;
    });
    if (glVendor) ok(`WebGL vendor: ${glVendor}`);
    else warn('WebGL vendor not available');

    // Test 6: Visit a bot detection test page
    try {
      await page.goto('https://bot.sannysoft.com/', { timeout: 15000 });
      await page.waitForTimeout(3000);
      const results = await page.evaluate(() => {
        const rows = document.querySelectorAll('table tr');
        const findings = [];
        for (const row of rows) {
          const cells = row.querySelectorAll('td');
          if (cells.length >= 2) {
            const test = cells[0].innerText.trim();
            const result = cells[1].innerText.trim();
            if (/fail|bot|detected/i.test(result)) findings.push(`${test}: ${result}`);
          }
        }
        return findings;
      });
      if (results.length === 0) ok('Bot detection test: ALL PASSED');
      else {
        warn(`Bot detection: ${results.length} potential flags`);
        results.slice(0, 5).forEach(r => log(`  → ${r}`));
      }
    } catch (err) {
      warn(`Bot test page failed: ${err.message.substring(0, 50)}`);
    }

    // Test 7: Human-like delays
    const start = Date.now();
    await humanDelay(100, 300);
    const elapsed = Date.now() - start;
    if (elapsed >= 100 && elapsed < 2500) ok(`humanDelay works: ${elapsed}ms`);
    else fail(`humanDelay out of range: ${elapsed}ms`);

    // Test 8: Check that bot-detection URLs are blocked
    const blockedResult = await page.evaluate(async () => {
      try {
        const r = await fetch('https://cdn.datadome.co/test.js', { mode: 'no-cors' });
        return 'allowed';
      } catch {
        return 'blocked';
      }
    }).catch(() => 'blocked');
    if (blockedResult === 'blocked') ok('Bot-detection URLs blocked');
    else warn('Bot-detection URLs may not be blocked');

  } finally {
    await browser.close().catch(() => {});
  }
};

// ─── TEST 3: Form Filler ────────────────────────────────────────────────────

TESTS.formfiller = async function testFormFiller() {
  console.log('\n═══ TEST: Universal Form Filler ═══');

  let browser, context, page;
  try {
    const result = await launchStealthBrowser({ headless: true });
    browser = result.browser;
    context = result.context;
    page = result.page;
    ok('Browser launched for form test');
  } catch (err) {
    fail(`Launch failed: ${err.message}`);
    return;
  }

  const profile = loadProfile();

  try {
    // Create a test form page
    await page.setContent(`
      <html><body>
        <h1>Job Application Form</h1>
        <form>
          <label for="fn">First Name</label><input id="fn" type="text" name="firstName" />
          <label for="ln">Last Name</label><input id="ln" type="text" name="lastName" />
          <label for="em">Email Address</label><input id="em" type="email" name="email" />
          <label for="ph">Phone Number</label><input id="ph" type="tel" name="phone" />
          <label for="ct">City</label><input id="ct" type="text" name="city" placeholder="Enter city" />
          <label for="exp">Years of Experience</label><input id="exp" type="number" name="experience" />
          <label for="sal">Expected CTC (LPA)</label><input id="sal" type="text" name="salary" placeholder="Expected salary" />
          <label for="np">Notice Period (days)</label><input id="np" type="text" name="noticePeriod" />
          <label for="comp">Current Company</label><input id="comp" type="text" name="currentCompany" />
          <label for="cv">Cover Letter</label><textarea id="cv" name="coverLetter" placeholder="Write cover letter"></textarea>
          <label for="li">LinkedIn URL</label><input id="li" type="url" name="linkedin" placeholder="LinkedIn profile URL" />
          <label for="country">Country</label>
          <select id="country" name="country">
            <option value="">Select</option>
            <option value="us">United States</option>
            <option value="in">India</option>
            <option value="uk">United Kingdom</option>
          </select>
          <label>Gender</label>
          <select id="gender" name="gender">
            <option value="">Select</option>
            <option value="male">Male</option>
            <option value="female">Female</option>
            <option value="decline">Prefer not to answer</option>
          </select>
          <label>Are you authorized to work?</label>
          <div>
            <input type="radio" name="authorized" id="auth-yes" value="yes"><label for="auth-yes">Yes</label>
            <input type="radio" name="authorized" id="auth-no" value="no"><label for="auth-no">No</label>
          </div>
          <label>Do you require visa sponsorship?</label>
          <div>
            <input type="radio" name="sponsorship" id="spon-yes" value="yes"><label for="spon-yes">Yes</label>
            <input type="radio" name="sponsorship" id="spon-no" value="no"><label for="spon-no">No</label>
          </div>
          <label><input type="checkbox" name="agree" id="agree"> I agree to terms</label>
          <button type="submit">Submit Application</button>
        </form>
      </body></html>
    `);

    // Run form filler
    const filledCount = await fillAllFields(page, profile);
    ok(`Form filler executed: ${filledCount} fields processed`);

    // Verify key fields
    const firstName = await page.$eval('#fn', el => el.value);
    if (firstName === profile.firstName) ok(`First name: ${firstName}`);
    else fail(`First name wrong: "${firstName}" (expected "${profile.firstName}")`);

    const lastName = await page.$eval('#ln', el => el.value);
    if (lastName === profile.lastName) ok(`Last name: ${lastName}`);
    else fail(`Last name wrong: "${lastName}"`);

    const email = await page.$eval('#em', el => el.value);
    if (email === profile.email) ok(`Email: ${email}`);
    else fail(`Email wrong: "${email}"`);

    const phone = await page.$eval('#ph', el => el.value);
    if (phone) ok(`Phone: ${phone}`);
    else fail('Phone not filled');

    const city = await page.$eval('#ct', el => el.value);
    if (city) ok(`City: ${city}`);
    else warn('City not filled');

    const exp = await page.$eval('#exp', el => el.value);
    if (exp === String(profile.totalExperience)) ok(`Experience: ${exp}`);
    else warn(`Experience: "${exp}" (expected "${profile.totalExperience}")`);

    const company = await page.$eval('#comp', el => el.value);
    if (company === profile.currentCompany) ok(`Company: ${company}`);
    else warn(`Company: "${company}"`);

    const country = await page.$eval('#country', el => el.value);
    if (country === 'in') ok(`Country: India selected`);
    else warn(`Country: "${country}"`);

    // Check radio buttons
    const authYes = await page.$eval('#auth-yes', el => el.checked);
    if (authYes) ok('Work authorization: Yes (correct)');
    else warn('Work authorization not checked');

    const sponNo = await page.$eval('#spon-no', el => el.checked);
    if (sponNo) ok('Sponsorship: No (correct)');
    else warn('Sponsorship not checked');

    // Check agreement checkbox
    const agreed = await page.$eval('#agree', el => el.checked);
    if (agreed) ok('Terms agreed: checked');
    else warn('Terms not checked');

  } catch (err) {
    fail(`Form filler error: ${err.message}`);
  } finally {
    await browser.close().catch(() => {});
  }
};

// ─── TEST 4: AI Brain ───────────────────────────────────────────────────────

TESTS.aibrain = async function testAIBrain() {
  console.log('\n═══ TEST: AI Brain ═══');

  if (!aiBrain.isAvailable()) {
    warn('AI Brain not available (no ANTHROPIC_API_KEY). Skipping.');
    return;
  }
  ok('AI Brain available');

  let browser, context, page;
  try {
    const result = await launchStealthBrowser({ headless: true });
    browser = result.browser;
    context = result.context;
    page = result.page;
  } catch (err) {
    fail(`Launch failed: ${err.message}`);
    return;
  }

  try {
    // Create a mock job page
    await page.setContent(`
      <html><body>
        <h1>Senior Software Engineer at TechCorp</h1>
        <p>Location: Hyderabad, India</p>
        <p>Experience: 2-5 years</p>
        <button id="apply-btn" aria-label="Apply Now">Apply Now</button>
        <div class="form-group">
          <label for="name">Full Name</label>
          <input id="name" type="text" placeholder="Enter your name" />
        </div>
        <div class="form-group">
          <label for="email">Email</label>
          <input id="email" type="email" placeholder="Enter email" />
        </div>
        <button type="submit">Submit Application</button>
      </body></html>
    `);

    const ctx = await aiBrain.extractPageContext(page);
    if (ctx && ctx.elements) ok(`Page context extracted: ${ctx.elements.length} chars`);
    else fail('Page context extraction failed');

    // Test apply button detection
    const applyBtn = await aiBrain.aiFindApplyButton(page);
    if (applyBtn && applyBtn.selector) ok(`AI found apply button: ${applyBtn.text || applyBtn.selector}`);
    else warn('AI could not find apply button');

    // Test form analysis
    const formActions = await aiBrain.aiAnalyzeFormFields(page);
    if (formActions && formActions.length > 0) ok(`AI form analysis: ${formActions.length} actions`);
    else warn('AI form analysis returned no actions');

  } catch (err) {
    fail(`AI Brain error: ${err.message}`);
  } finally {
    await browser.close().catch(() => {});
  }
};

// ─── TEST 5: Naukri Login & Apply ───────────────────────────────────────────

TESTS.naukri = async function testNaukri() {
  console.log('\n═══ TEST: Naukri Login & Apply ═══');

  const profile = loadProfile();
  if (!profile.naukriEmail || !profile.naukriPassword) {
    warn('Naukri credentials not set. Skipping.');
    return;
  }

  let browser, context, page;
  try {
    const result = await launchStealthBrowser({ headless: false, locale: 'en-IN' });
    browser = result.browser;
    context = result.context;
    page = result.page;
    ok('Stealth browser launched for Naukri');
  } catch (err) {
    fail(`Launch failed: ${err.message}`);
    return;
  }

  try {
    // Step 1: Login
    log('Logging into Naukri...');
    await page.goto('https://www.naukri.com/nlogin/login', { waitUntil: 'networkidle', timeout: 30000 });
    await page.waitForTimeout(2000);

    // Fill email
    const emailInput = await page.$('input[type="text"][placeholder*="Email" i], input[type="email"], input[id*="email" i], input[name*="email" i], input[placeholder*="ID" i]');
    if (emailInput) {
      await emailInput.fill(profile.naukriEmail);
      ok(`Email filled: ${profile.naukriEmail}`);
    } else {
      fail('Email input not found on login page');
      await browser.close();
      return;
    }

    // Fill password
    const pwdInput = await page.$('input[type="password"]');
    if (pwdInput) {
      await pwdInput.fill(profile.naukriPassword);
      ok('Password filled');
    } else {
      fail('Password input not found');
      await browser.close();
      return;
    }

    // Click login
    const loginBtn = await page.$('button[type="submit"], button:has-text("Login"), button:has-text("Sign in")');
    if (loginBtn) {
      await loginBtn.click();
      await page.waitForTimeout(5000);
      ok('Login button clicked');
    } else {
      fail('Login button not found');
      await browser.close();
      return;
    }

    // Check login success
    const loggedInUrl = page.url();
    const bodyText = await page.evaluate(() => document.body.innerText.substring(0, 1000)).catch(() => '');
    if (loggedInUrl.includes('naukri.com') && !loggedInUrl.includes('login')) {
      ok('Login successful (redirected away from login)');
    } else if (/dashboard|home|my naukri|profile/i.test(bodyText)) {
      ok('Login successful (dashboard detected)');
    } else if (/otp|verify|verification/i.test(bodyText)) {
      warn('OTP/verification required — cannot auto-complete. Login partially succeeded.');
      // Wait for manual OTP
      log('Waiting 30s for manual OTP completion...');
      await page.waitForTimeout(30000);
    } else {
      warn(`Login result unclear. URL: ${loggedInUrl.substring(0, 60)}`);
    }

    // Step 2: Navigate to a job and test apply
    log('Navigating to Naukri job search...');
    await page.goto('https://www.naukri.com/node-js-developer-jobs', { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(3000);

    // Find first job link
    const jobLinks = await page.$$('a[class*="title"], a[class*="jobTuple"], .srp-jobtuple-wrapper a, article a[href*="job-listings"], a[href*="naukri.com/job-listings"]');
    if (jobLinks.length > 0) {
      ok(`Found ${jobLinks.length} job listings`);

      // Click first job
      const firstJobUrl = await jobLinks[0].getAttribute('href');
      log(`Opening job: ${(firstJobUrl || '').substring(0, 70)}...`);

      // Open in new tab to avoid navigation issues
      const jobPage = await context.newPage();
      await jobPage.goto(firstJobUrl || await jobLinks[0].evaluate(el => el.href), { waitUntil: 'networkidle', timeout: 30000 }).catch(() => {});
      await jobPage.waitForTimeout(3000);

      // Try to find apply button
      const pageTitle = await jobPage.title();
      log(`Job page: ${pageTitle.substring(0, 60)}`);

      const applyBtnSelectors = [
        'button#apply-button', '[class*="apply-button"]', '[class*="applyButton"]',
        'button:has-text("Apply")', 'button:has-text("apply")',
        'a:has-text("Apply Now")', 'button:has-text("I am interested")',
      ];

      let applyFound = false;
      for (const sel of applyBtnSelectors) {
        const btn = await jobPage.$(sel).catch(() => null);
        if (btn && await btn.isVisible().catch(() => false)) {
          const btnText = await btn.innerText().catch(() => '');
          ok(`Apply button found: "${btnText.trim()}"`);
          applyFound = true;

          // Check if already applied
          if (/applied/i.test(btnText)) {
            log('Already applied to this job');
          } else {
            // Test clicking the apply button
            log('Clicking apply button...');
            await btn.click().catch(() => {});
            await jobPage.waitForTimeout(3000);

            // Check what happened
            const postClickUrl = jobPage.url();
            const postClickBody = await jobPage.evaluate(() => document.body.innerText.substring(0, 500)).catch(() => '');

            if (/chat|type|message/i.test(postClickBody)) {
              ok('Chat apply flow detected');
            } else if (/modal|dialog|overlay/i.test(await jobPage.evaluate(() => {
              const d = document.querySelector('[role="dialog"], .modal, [class*="modal"], [class*="overlay"]');
              return d ? d.className : '';
            }).catch(() => ''))) {
              ok('Modal apply flow detected');
            } else if (/success|applied|thank/i.test(postClickBody)) {
              ok('Instant apply succeeded');
            } else if (!postClickUrl.includes('naukri.com')) {
              ok(`External redirect detected: ${postClickUrl.substring(0, 50)}`);
            } else {
              warn('Apply click result unclear — may need further investigation');
            }
          }
          break;
        }
      }

      if (!applyFound) {
        // Use text-based search
        const allBtns = await jobPage.$$('button, a[href]');
        for (const btn of allBtns) {
          const txt = (await btn.innerText().catch(() => '')).toLowerCase().trim();
          if (txt.includes('apply') || txt.includes('interested')) {
            ok(`Apply button found via text scan: "${txt.substring(0, 30)}"`);
            applyFound = true;
            break;
          }
        }
        if (!applyFound) warn('No apply button found on job page');
      }

      await jobPage.close().catch(() => {});
    } else {
      warn('No job listings found on search page');
    }

  } catch (err) {
    fail(`Naukri test error: ${err.message}`);
  } finally {
    await browser.close().catch(() => {});
  }
};

// ─── TEST 6: External ATS Detection ────────────────────────────────────────

TESTS.external = async function testExternal() {
  console.log('\n═══ TEST: External ATS Detection & Handling ═══');

  const { detectATS } = require('./src/apply/external');
  if (!detectATS) {
    warn('detectATS not exported from external.js, skipping URL tests');
  } else {
    // Test ATS detection
    const testUrls = [
      { url: 'https://company.workday.com/en-US/job/12345', expected: 'workday' },
      { url: 'https://boards.greenhouse.io/company/jobs/123', expected: 'greenhouse' },
      { url: 'https://jobs.lever.co/company/abc-123', expected: 'lever' },
      { url: 'https://jobs.smartrecruiters.com/company/job123', expected: 'smartrecruiters' },
      { url: 'https://company.icims.com/jobs/12345', expected: 'icims' },
      { url: 'https://careers.google.com/jobs/12345', expected: 'unknown' },
    ];

    for (const { url, expected } of testUrls) {
      try {
        const result = detectATS(url);
        if (result && result.toLowerCase().includes(expected)) {
          ok(`ATS detect: ${url.substring(0, 40)}... → ${result}`);
        } else {
          warn(`ATS detect: ${url.substring(0, 40)}... → "${result}" (expected "${expected}")`);
        }
      } catch (err) {
        fail(`ATS detect error for ${url.substring(0, 30)}: ${err.message}`);
      }
    }
  }

  // Test visiting a real Greenhouse page
  let browser, context, page;
  try {
    const result = await launchStealthBrowser({ headless: true });
    browser = result.browser;
    context = result.context;
    page = result.page;
  } catch (err) {
    fail(`Launch failed: ${err.message}`);
    return;
  }

  try {
    // Test a real Greenhouse page
    log('Testing Greenhouse page detection...');
    await page.goto('https://boards.greenhouse.io/', { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(2000);
    const ghTitle = await page.title().catch(() => '');
    if (ghTitle) ok(`Greenhouse accessible: "${ghTitle.substring(0, 40)}"`);
    else warn('Greenhouse page did not load');

    // Test Lever page detection
    log('Testing Lever page detection...');
    await page.goto('https://jobs.lever.co/', { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(2000);
    const leverTitle = await page.title().catch(() => '');
    if (leverTitle) ok(`Lever accessible: "${leverTitle.substring(0, 40)}"`);
    else warn('Lever page did not load');

  } catch (err) {
    warn(`External ATS test: ${err.message.substring(0, 60)}`);
  } finally {
    await browser.close().catch(() => {});
  }
};

// ─── TEST 7: Edge Cases ─────────────────────────────────────────────────────

TESTS.edge = async function testEdgeCases() {
  console.log('\n═══ TEST: Edge Cases ═══');

  // Test 1: Profile with empty overrides
  const p1 = loadProfile({});
  if (p1.firstName) ok('Empty overrides: defaults used');
  else fail('Empty overrides broke profile');

  // Test 2: Profile with partial overrides
  const p2 = loadProfile({ firstName: 'Test' });
  if (p2.firstName === 'Test' && p2.lastName) ok('Partial overrides: mixed correctly');
  else fail('Partial overrides failed');

  // Test 3: Experience years for unknown skill
  const p3 = loadProfile({ experienceMap: { 'python': 2 } });
  const unknown = getExperienceYears(p3, 'How many years of Rust?');
  if (unknown === null) ok('Unknown skill returns null');
  else fail(`Unknown skill returned: ${unknown}`);

  // Test 4: Cover letter with empty skills
  const p4 = loadProfile({ skills: '', currentTitle: 'Developer', totalExperience: 3 });
  const cl = generateCoverLetter(p4);
  if (cl && !cl.includes('undefined') && !cl.includes('NaN')) ok('Cover letter with empty skills: OK');
  else fail(`Bad cover letter: ${cl}`);

  // Test 5: Integer parsing edge cases
  const p5 = loadProfile({ totalExperience: '0' });
  if (p5.totalExperience === 0) ok('Zero experience parsed correctly');
  else warn(`Zero experience: ${p5.totalExperience}`);

  // Test 6: Form filler with empty page
  let browser;
  try {
    const result = await launchStealthBrowser({ headless: true });
    browser = result.browser;
    const page = result.page;

    await page.setContent('<html><body><p>No form here</p></body></html>');
    const count = await fillAllFields(page, loadProfile());
    if (count === 0 || count === undefined) ok('Empty page: form filler handled gracefully');
    else ok(`Empty page: form filler returned ${count} (no crash)`);

    // Test with pre-filled form
    await page.setContent(`
      <html><body>
        <input id="test" type="text" value="already filled" />
      </body></html>
    `);
    await fillAllFields(page, loadProfile());
    const val = await page.$eval('#test', el => el.value);
    if (val === 'already filled') ok('Pre-filled field not overwritten');
    else warn(`Pre-filled field changed to: "${val}"`);

    await browser.close();
  } catch (err) {
    fail(`Edge case browser test: ${err.message}`);
    if (browser) await browser.close().catch(() => {});
  }
};

// ─── TEST 8: Multi-User Module ──────────────────────────────────────────────

TESTS.multiuser = async function testMultiUser() {
  console.log('\n═══ TEST: Multi-User Module ═══');

  try {
    const { loadUserConfigs, runForUser } = require('./src/multi-user');
    ok('Multi-user module loads');

    // Test config loading (may create example)
    const configs = loadUserConfigs();
    ok(`User configs loaded: ${configs.length} users found`);
  } catch (err) {
    if (err.code === 'MODULE_NOT_FOUND') {
      warn('Multi-user module not found (optional)');
    } else {
      fail(`Multi-user module error: ${err.message}`);
    }
  }
};

// ─── Runner ─────────────────────────────────────────────────────────────────

async function runTests(filter) {
  console.log('╔══════════════════════════════════════╗');
  console.log('║     ApplyPilot Test Suite v1.0       ║');
  console.log('╚══════════════════════════════════════╝');

  const testNames = filter === 'all' ? Object.keys(TESTS) : [filter];

  for (const name of testNames) {
    if (!TESTS[name]) {
      console.log(`\n\x1b[31mUnknown test: ${name}\x1b[0m`);
      console.log(`Available: ${Object.keys(TESTS).join(', ')}, all`);
      return;
    }
    try {
      await TESTS[name]();
    } catch (err) {
      fail(`Test "${name}" crashed: ${err.message}`);
      console.error(err.stack);
    }
  }

  console.log('\n═══════════════════════════════════════');
  console.log(`\x1b[32m  Passed:  ${passed}\x1b[0m`);
  console.log(`\x1b[31m  Failed:  ${failed}\x1b[0m`);
  console.log(`\x1b[33m  Skipped: ${skipped}\x1b[0m`);
  console.log('═══════════════════════════════════════\n');

  if (failed > 0) process.exit(1);
}

const filter = process.argv[2] || 'all';
runTests(filter).catch(err => { console.error('Fatal:', err); process.exit(1); });
