/**
 * Deep Form Filler Audit — Tests every field type, edge case, and ATS form layout
 * Simulates real-world forms from Workday, Greenhouse, Lever, SmartRecruiters, iCIMS, etc.
 */
require('dotenv').config();
const { launchStealthBrowser, smartGoto, waitForPageStable } = require('./src/stealth');
const { fillAllFields, fillWorkdayWidgets, fillRadioButtons, fillDropdowns, fillCheckboxes, fixValidationErrors, isApplicationSuccess, matchField } = require('./src/form-filler');
const { loadProfile } = require('./src/profile');

let passed = 0, failed = 0, warnings = 0;
const BUGS = [];
const profile = loadProfile();

function ok(msg) { console.log(`  \x1b[32m+\x1b[0m ${msg}`); passed++; }
function fail(msg) { console.log(`  \x1b[31m✗\x1b[0m ${msg}`); failed++; BUGS.push(msg); }
function warn(msg) { console.log(`  \x1b[33m~\x1b[0m ${msg}`); warnings++; }

(async () => {
  console.log('=== Deep Form Filler Audit ===\n');
  const { browser, context, page } = await launchStealthBrowser({ headless: true });

  // ─── 1. Field Matcher Coverage ─────────────────────────────────────────────
  console.log('--- Field Matcher Coverage (30+ field types) ---');

  const matchTests = [
    // Contact
    ['Phone Number', 'text', 'phone'],
    ['Mobile Number', 'tel', 'phone'],
    ['Contact Number', 'tel', 'phone'],
    ['Email Address', 'email', 'email'],
    ['email notification', 'text', null], // Should NOT match email
    // Name
    ['First Name', 'text', 'firstName'],
    ['Given Name', 'text', 'firstName'],
    ['Last Name', 'text', 'lastName'],
    ['Surname', 'text', 'lastName'],
    ['Full Name', 'text', 'fullName'],
    ['Candidate Name', 'text', 'fullName'],
    ['Company Name', 'text', 'currentCompany'], // NOT fullName
    // Location
    ['City', 'text', 'city'],
    ['Current Location', 'text', 'city'],
    ['State', 'text', 'state'],
    ['Country', 'text', 'country'],
    ['Phone country code', 'text', null], // Should NOT match country
    ['Zip Code', 'text', 'pincode'],
    ['Postal Code', 'text', 'pincode'],
    ['Address', 'text', 'address'],
    ['Email Address', 'email', 'email'], // email, not address
    // Company
    ['Current Company', 'text', 'currentCompany'],
    ['Most Recent Employer', 'text', 'currentCompany'],
    ['Current Title', 'text', 'currentTitle'],
    ['Job Title', 'text', 'currentTitle'],
    ['Current Role', 'text', 'currentTitle'],
    // URLs
    ['LinkedIn Profile URL', 'url', 'linkedinUrl'],
    ['GitHub', 'url', 'portfolioUrl'],
    ['Portfolio Website', 'url', 'portfolioUrl'],
    ['Personal Blog', 'url', 'portfolioUrl'],
    // Experience
    ['Years of Experience', 'number', 'experience'],
    ['Total Experience', 'number', 'experience'],
    ['How many years of Node.js experience?', 'number', 'experience'],
    // Salary
    ['Expected CTC', 'text', 'salary'],
    ['Salary Expectations', 'text', 'salary'],
    ['Current Package LPA', 'text', 'salary'],
    ['Hourly Rate', 'number', 'hourlyRate'],
    // Notice
    ['Notice Period', 'text', 'noticePeriod'],
    ['Availability', 'text', 'noticePeriod'],
    ['Earliest Start Date', 'text', 'noticePeriod'],
    // Education
    ['Highest Degree', 'text', 'degree'],
    ['University', 'text', 'university'],
    ['GPA', 'text', 'gpa'],
    // Work authorization
    ['Are you authorized to work in India?', 'text', 'workAuth'],
    ['Do you require visa sponsorship?', 'text', 'sponsorship'],
    ['Willing to relocate?', 'text', 'relocation'],
    // Demographics
    ['Gender', 'text', 'gender'],
    ['Veteran Status', 'text', 'veteran'],
    ['Disability', 'text', 'disability'],
    ['Race/Ethnicity', 'text', 'ethnicity'],
    // Cover letter
    ['Cover Letter', 'text', 'coverLetter'],
    ['Additional Info', 'text', 'coverLetter'],
    ['Why are you interested in this role?', 'text', 'coverLetter'],
    // Source
    ['How did you hear about us?', 'text', 'hearAbout'],
    ['Referral Source', 'text', 'hearAbout'],
    // Age/DOB
    ['Age', 'number', 'age'],
    ['Date of Birth', 'text', 'dob'],
    // Should NOT false match
    ['Package version', 'text', null],
    ['Page number', 'text', null],
    ['Stage', 'text', null],
    ['Manage team size', 'text', null],
  ];

  let matchPassed = 0, matchFailed = 0;
  for (const [ctx, type, expected] of matchTests) {
    const result = matchField(ctx, type);
    if (result === expected) {
      matchPassed++;
    } else {
      fail(`matchField("${ctx}", "${type}") = "${result}" (expected: "${expected}")`);
      matchFailed++;
    }
  }
  if (matchFailed === 0) ok(`Field matcher: ALL ${matchPassed} tests passed`);
  else warn(`Field matcher: ${matchPassed} passed, ${matchFailed} failed`);

  // ─── 2. Complex Workday-Style Form ─────────────────────────────────────────
  console.log('\n--- Complex Workday Form (data-automation-id) ---');

  await page.setContent(`<html><body>
    <form>
      <h2>Personal Information</h2>
      <div><label for="fn">First Name *</label>
        <input id="fn" data-automation-id="legalNameSection_firstName" type="text" required></div>
      <div><label for="ln">Last Name *</label>
        <input id="ln" data-automation-id="legalNameSection_lastName" type="text" required></div>
      <div><label for="em">Email *</label>
        <input id="em" data-automation-id="email" type="email" required></div>
      <div><label for="ph">Phone Number *</label>
        <input id="ph" data-automation-id="phone-number" type="tel" required></div>
      <div><label for="city">City</label>
        <input id="city" data-automation-id="addressSection_city" type="text"></div>
      <div><label for="zip">Postal Code</label>
        <input id="zip" data-automation-id="addressSection_postalCode" type="text"></div>

      <h2>Experience</h2>
      <div><label for="exp">Years of Experience *</label>
        <input id="exp" type="number" required></div>
      <div><label for="comp">Current Company</label>
        <input id="comp" type="text"></div>
      <div><label for="title">Current Title</label>
        <input id="title" type="text"></div>

      <h2>URLs</h2>
      <div><label for="li">LinkedIn Profile</label>
        <input id="li" type="url"></div>
      <div><label for="gh">GitHub / Portfolio</label>
        <input id="gh" type="url"></div>

      <h2>Compensation</h2>
      <div><label for="ctc">Expected CTC (INR per annum)</label>
        <input id="ctc" type="text"></div>
      <div><label for="notice">Notice Period (days)</label>
        <input id="notice" type="text"></div>

      <h2>Work Authorization</h2>
      <fieldset>
        <legend>Are you authorized to work in India?</legend>
        <label><input type="radio" name="workAuth" value="yes"> Yes</label>
        <label><input type="radio" name="workAuth" value="no"> No</label>
      </fieldset>
      <fieldset>
        <legend>Do you require visa sponsorship?</legend>
        <label><input type="radio" name="sponsor" value="yes"> Yes</label>
        <label><input type="radio" name="sponsor" value="no"> No</label>
      </fieldset>

      <h2>Demographics (Optional)</h2>
      <select id="gender"><option value="">Select Gender</option><option>Male</option><option>Female</option><option>Prefer not to disclose</option></select>
      <select id="vet"><option value="">Veteran Status</option><option>Not a veteran</option><option>Veteran</option><option>Prefer not to disclose</option></select>

      <h2>Education</h2>
      <select id="edu"><option value="">Highest Degree</option><option>High School</option><option>Bachelor's (B.Tech/B.E.)</option><option>Master's</option><option>PhD</option></select>

      <h2>Additional</h2>
      <div><label for="cover">Cover Letter</label>
        <textarea id="cover" rows="4"></textarea></div>
      <div><label><input type="checkbox" name="terms" required> I agree to the terms and conditions</label></div>
      <div><label for="source">How did you hear about us?</label>
        <select id="source"><option value="">Select</option><option>LinkedIn</option><option>Indeed</option><option>Referral</option></select></div>

      <button type="submit">Submit Application</button>
    </form>
  </body></html>`);

  // Fill with both generic and Workday-specific fillers
  await fillAllFields(page, profile);
  await fillWorkdayWidgets(page, profile);

  // Verify all fields
  const wdResults = await page.evaluate(() => {
    const get = (id) => document.getElementById(id)?.value || '';
    const getRadio = (name) => document.querySelector(`input[name="${name}"]:checked`)?.value || '';
    const getSelect = (id) => document.getElementById(id)?.value || '';
    const getCb = (name) => document.querySelector(`input[name="${name}"]`)?.checked || false;
    return {
      fn: get('fn'), ln: get('ln'), em: get('em'), ph: get('ph'),
      city: get('city'), zip: get('zip'), exp: get('exp'), comp: get('comp'),
      title: get('title'), li: get('li'), gh: get('gh'), ctc: get('ctc'),
      notice: get('notice'), workAuth: getRadio('workAuth'), sponsor: getRadio('sponsor'),
      gender: getSelect('gender'), vet: getSelect('vet'), edu: getSelect('edu'),
      cover: get('cover'), terms: getCb('terms'), source: getSelect('source'),
    };
  });

  // Check each field
  if (wdResults.fn === profile.firstName) ok(`First name: ${wdResults.fn}`);
  else fail(`First name: "${wdResults.fn}" (expected "${profile.firstName}")`);

  if (wdResults.ln === profile.lastName) ok(`Last name: ${wdResults.ln}`);
  else fail(`Last name: "${wdResults.ln}" (expected "${profile.lastName}")`);

  if (wdResults.em === profile.email) ok(`Email: ${wdResults.em}`);
  else fail(`Email: "${wdResults.em}" (expected "${profile.email}")`);

  if (wdResults.ph && wdResults.ph.length >= 6) ok(`Phone: ${wdResults.ph}`);
  else fail(`Phone: "${wdResults.ph}" (expected phone number)`);

  if (wdResults.city) ok(`City: ${wdResults.city}`);
  else fail('City: empty');

  if (wdResults.exp && parseInt(wdResults.exp) > 0) ok(`Experience: ${wdResults.exp}`);
  else fail(`Experience: "${wdResults.exp}"`);

  if (wdResults.comp) ok(`Company: ${wdResults.comp}`);
  else fail('Company: empty');

  if (wdResults.title) ok(`Title: ${wdResults.title}`);
  else fail('Title: empty');

  if (wdResults.li && wdResults.li.includes('linkedin.com')) ok(`LinkedIn: ${wdResults.li.substring(0, 40)}...`);
  else fail(`LinkedIn: "${wdResults.li}"`);

  if (wdResults.ctc && parseInt(wdResults.ctc) > 0) ok(`CTC: ${wdResults.ctc}`);
  else fail(`CTC: "${wdResults.ctc}"`);

  if (wdResults.notice) ok(`Notice: ${wdResults.notice}`);
  else fail('Notice: empty');

  if (wdResults.workAuth === 'yes') ok('Work auth: Yes');
  else fail(`Work auth: "${wdResults.workAuth}" (expected "yes")`);

  if (wdResults.sponsor === 'no') ok('Sponsorship: No');
  else fail(`Sponsorship: "${wdResults.sponsor}" (expected "no")`);

  if (wdResults.gender && !/select/i.test(wdResults.gender)) ok(`Gender: ${wdResults.gender}`);
  else warn(`Gender: "${wdResults.gender}"`);

  if (wdResults.edu && !/select/i.test(wdResults.edu)) ok(`Education: selected`);
  else warn(`Education: "${wdResults.edu}"`);

  if (wdResults.cover && wdResults.cover.length > 50) ok(`Cover letter: ${wdResults.cover.length} chars`);
  else fail(`Cover letter: ${wdResults.cover?.length || 0} chars`);

  if (wdResults.terms) ok('Terms: checked');
  else fail('Terms: not checked');

  if (wdResults.source && !/select/i.test(wdResults.source)) ok(`Source: ${wdResults.source}`);
  else warn('Source: not selected');

  // ─── 3. Pre-filled Form (Should NOT overwrite) ────────────────────────────
  console.log('\n--- Pre-filled Form (No Overwrite) ---');

  await page.setContent(`<html><body><form>
    <input id="name" placeholder="Full Name" value="Already Filled">
    <input id="email" placeholder="Email" value="existing@company.com">
    <input id="phone" placeholder="Phone" value="9999999999">
    <textarea id="bio">I am a pre-existing bio that should not be replaced.</textarea>
    <select id="country"><option value="us" selected>United States</option><option value="in">India</option></select>
  </form></body></html>`);

  await fillAllFields(page, profile);

  const prefilled = await page.evaluate(() => ({
    name: document.getElementById('name').value,
    email: document.getElementById('email').value,
    phone: document.getElementById('phone').value,
    bio: document.getElementById('bio').value,
    country: document.getElementById('country').value,
  }));

  if (prefilled.name === 'Already Filled') ok('Pre-filled name NOT overwritten');
  else fail(`Pre-filled name overwritten: "${prefilled.name}"`);

  if (prefilled.email === 'existing@company.com') ok('Pre-filled email NOT overwritten');
  else fail(`Pre-filled email overwritten: "${prefilled.email}"`);

  if (prefilled.phone === '9999999999') ok('Pre-filled phone NOT overwritten');
  else fail(`Pre-filled phone overwritten: "${prefilled.phone}"`);

  if (prefilled.bio.includes('pre-existing bio')) ok('Pre-filled textarea NOT overwritten');
  else fail('Pre-filled textarea was overwritten');

  if (prefilled.country === 'us') ok('Pre-selected dropdown NOT changed');
  else fail(`Pre-selected dropdown changed to: ${prefilled.country}`);

  // ─── 4. Edge Case: Hidden & Disabled Fields ───────────────────────────────
  console.log('\n--- Hidden & Disabled Fields ---');

  await page.setContent(`<html><body><form>
    <input type="hidden" name="csrf" value="token123">
    <input type="text" id="vis" placeholder="Email" style="display:block">
    <input type="text" id="hid" placeholder="Email" style="display:none">
    <input type="text" id="dis" placeholder="Email" disabled>
    <input type="submit" value="Submit">
    <input type="file" name="resume" accept=".pdf">
  </form></body></html>`);

  await fillAllFields(page, profile);

  const hiddenResults = await page.evaluate(() => ({
    csrf: document.querySelector('[name="csrf"]').value,
    vis: document.getElementById('vis').value,
    hid: document.getElementById('hid').value,
    dis: document.getElementById('dis').value,
  }));

  if (hiddenResults.csrf === 'token123') ok('Hidden CSRF field untouched');
  else fail('Hidden CSRF was modified');

  if (hiddenResults.vis) ok('Visible email filled');
  else warn('Visible email not filled');

  // Hidden fields use :visible selector, so they should be skipped
  if (!hiddenResults.hid) ok('Hidden field skipped');
  else fail('Hidden field was filled');

  // ─── 5. Greenhouse-Style Form ──────────────────────────────────────────────
  console.log('\n--- Greenhouse-Style Form ---');

  await page.setContent(`<html><body><form>
    <div class="field"><label for="first_name">First name *</label>
      <input id="first_name" type="text" name="job_application[first_name]"></div>
    <div class="field"><label for="last_name">Last name *</label>
      <input id="last_name" type="text" name="job_application[last_name]"></div>
    <div class="field"><label for="email">Email *</label>
      <input id="email" type="email" name="job_application[email]"></div>
    <div class="field"><label for="phone">Phone *</label>
      <input id="phone" type="tel" name="job_application[phone]"></div>
    <div class="field"><label for="location">Location (City)</label>
      <input id="location" type="text" name="job_application[location]"></div>
    <div class="field"><label for="resume_text">Resume (paste text)</label>
      <textarea id="resume_text" name="job_application[resume_text]"></textarea></div>
    <div class="field"><label for="cover_letter">Cover Letter</label>
      <textarea id="cover_letter" name="job_application[cover_letter]"></textarea></div>
    <div class="field"><label for="linkedin_profile">LinkedIn Profile</label>
      <input id="linkedin_profile" type="url"></div>
    <div class="field"><label for="website">Website / GitHub</label>
      <input id="website" type="url"></div>

    <div class="field">
      <label for="custom_q1">How many years of experience do you have with Node.js?</label>
      <input id="custom_q1" type="number">
    </div>
    <div class="field">
      <label for="custom_q2">Are you willing to travel up to 25%?</label>
      <fieldset>
        <label><input type="radio" name="travel" value="Yes"> Yes</label>
        <label><input type="radio" name="travel" value="No"> No</label>
      </fieldset>
    </div>
  </form></body></html>`);

  await fillAllFields(page, profile);

  const ghResults = await page.evaluate(() => ({
    fn: document.getElementById('first_name').value,
    ln: document.getElementById('last_name').value,
    em: document.getElementById('email').value,
    ph: document.getElementById('phone').value,
    loc: document.getElementById('location').value,
    cover: document.getElementById('cover_letter').value,
    li: document.getElementById('linkedin_profile').value,
    web: document.getElementById('website').value,
    exp: document.getElementById('custom_q1').value,
    travel: document.querySelector('input[name="travel"]:checked')?.value || '',
  }));

  if (ghResults.fn === profile.firstName) ok(`GH: First name = ${ghResults.fn}`);
  else fail(`GH: First name = "${ghResults.fn}"`);

  if (ghResults.em === profile.email) ok(`GH: Email = ${ghResults.em}`);
  else fail(`GH: Email = "${ghResults.em}"`);

  if (ghResults.loc) ok(`GH: Location = ${ghResults.loc}`);
  else fail('GH: Location empty');

  if (ghResults.cover && ghResults.cover.length > 30) ok(`GH: Cover letter = ${ghResults.cover.length} chars`);
  else fail('GH: Cover letter empty');

  if (ghResults.li && ghResults.li.includes('linkedin')) ok(`GH: LinkedIn filled`);
  else fail(`GH: LinkedIn = "${ghResults.li}"`);

  if (ghResults.exp) ok(`GH: Node.js experience = ${ghResults.exp}`);
  else fail('GH: Experience not filled');

  if (ghResults.travel === 'Yes') ok('GH: Travel willingness = Yes');
  else fail(`GH: Travel = "${ghResults.travel}"`);

  // ─── 6. Complex Dropdown Scenarios ─────────────────────────────────────────
  console.log('\n--- Complex Dropdown Scenarios ---');

  await page.setContent(`<html><body><form>
    <div><label for="exp_sel">Years of Experience</label>
      <select id="exp_sel">
        <option value="">-- Select --</option>
        <option value="0-1">0-1 years</option>
        <option value="2-4">2-4 years</option>
        <option value="5-7">5-7 years</option>
        <option value="8-10">8-10 years</option>
        <option value="10+">10+ years</option>
      </select></div>
    <div><label for="country_sel">Country</label>
      <select id="country_sel">
        <option value="">Choose country</option>
        <option value="us">United States</option>
        <option value="uk">United Kingdom</option>
        <option value="in">India</option>
        <option value="ca">Canada</option>
      </select></div>
    <div><label for="notice_sel">Notice Period</label>
      <select id="notice_sel">
        <option value="">Select notice period</option>
        <option value="immediate">Immediate</option>
        <option value="1month">Less than 1 month</option>
        <option value="30days">30 days</option>
        <option value="60days">60 days</option>
        <option value="90days">90 days</option>
      </select></div>
    <div><label for="src_sel">How did you find this job?</label>
      <select id="src_sel">
        <option value="">-- Please select --</option>
        <option value="linkedin">LinkedIn</option>
        <option value="indeed">Indeed</option>
        <option value="ref">Referral</option>
        <option value="other">Other</option>
      </select></div>
  </form></body></html>`);

  await fillDropdowns(page, profile);

  const ddResults = await page.evaluate(() => ({
    exp: document.getElementById('exp_sel').value,
    country: document.getElementById('country_sel').value,
    notice: document.getElementById('notice_sel').value,
    src: document.getElementById('src_sel').value,
  }));

  // Profile has 3 years experience → should pick "2-4"
  if (ddResults.exp === '2-4') ok(`Experience dropdown: ${ddResults.exp} (correct range for ${profile.totalExperience}yr)`);
  else fail(`Experience dropdown: "${ddResults.exp}" (expected "2-4" for ${profile.totalExperience}yr)`);

  if (ddResults.country === 'in') ok('Country dropdown: India');
  else fail(`Country dropdown: "${ddResults.country}" (expected "in")`);

  if (['30days', '1month', 'immediate'].includes(ddResults.notice)) ok(`Notice dropdown: ${ddResults.notice}`);
  else fail(`Notice dropdown: "${ddResults.notice}"`);

  if (ddResults.src === 'linkedin') ok('Source dropdown: LinkedIn');
  else fail(`Source dropdown: "${ddResults.src}"`);

  // ─── 7. Validation Error Recovery ──────────────────────────────────────────
  console.log('\n--- Validation Error Recovery ---');

  await page.setContent(`<html><body><form>
    <input id="salary" placeholder="Expected CTC" type="number" value="12">
    <div class="error" role="alert">Enter a whole number larger than 100000</div>
    <input id="score" placeholder="Score" type="number" value="150">
    <div class="error" role="alert">Enter a whole number between 0 and 100</div>
    <select id="sel"><option value="">Select checkbox</option><option value="a">Option A</option></select>
    <div class="error" role="alert">Please make a selection</div>
  </form></body></html>`);

  await fixValidationErrors(page, profile);

  const valResults = await page.evaluate(() => ({
    salary: document.getElementById('salary').value,
    score: document.getElementById('score').value,
    sel: document.getElementById('sel').value,
  }));

  if (parseInt(valResults.salary) > 100000) ok(`Validation fix: salary corrected to ${valResults.salary}`);
  else fail(`Validation fix: salary still ${valResults.salary}`);

  if (parseInt(valResults.score) >= 0 && parseInt(valResults.score) <= 100) ok(`Validation fix: score corrected to ${valResults.score}`);
  else fail(`Validation fix: score still ${valResults.score}`);

  if (valResults.sel && valResults.sel !== '') ok(`Validation fix: dropdown selected = ${valResults.sel}`);
  else fail('Validation fix: dropdown not selected');

  // ─── 8. Success Page Detection ─────────────────────────────────────────────
  console.log('\n--- Success Page Detection ---');

  const successTexts = [
    'Thank you for applying! We will review your application.',
    'Your application has been submitted successfully.',
    'We have received your application and will be in touch.',
    'Application complete! Your resume is under review.',
    "Congratulations! You've applied successfully.",
    "We've received your resume. We'll be in touch!",
    'Your application is being reviewed by our team.',
  ];

  const nonSuccessTexts = [
    'Please fill in all required fields to continue.',
    'Error: Your session has expired. Please try again.',
    'Upload your resume to apply for this position.',
    'Step 2 of 4: Work Experience',
  ];

  for (const text of successTexts) {
    await page.setContent(`<html><body><div>${text}</div></body></html>`);
    const result = await isApplicationSuccess(page);
    if (result) ok(`Success detected: "${text.substring(0, 50)}..."`);
    else fail(`Missed success: "${text.substring(0, 50)}..."`);
  }

  for (const text of nonSuccessTexts) {
    await page.setContent(`<html><body><div>${text}</div></body></html>`);
    const result = await isApplicationSuccess(page);
    if (!result) ok(`Non-success correct: "${text.substring(0, 50)}..."`);
    else fail(`False success: "${text.substring(0, 50)}..."`);
  }

  // ─── 9. iCIMS-Style Form (Complex Nesting) ───────────────────────────────
  console.log('\n--- iCIMS Complex Nested Form ---');

  await page.setContent(`<html><body>
    <div class="iCIMS_MainWrapper">
      <div class="iCIMS_InfoMsg_Job">Software Engineer - Node.js</div>
      <div class="iCIMS_Forms">
        <div class="field" data-field-type="name">
          <label for="icims_fn" class="iCIMS_InfoMsg">First Name <span class="required">*</span></label>
          <input id="icims_fn" name="firstname" type="text" aria-required="true">
        </div>
        <div class="field" data-field-type="name">
          <label for="icims_ln" class="iCIMS_InfoMsg">Last Name <span class="required">*</span></label>
          <input id="icims_ln" name="lastname" type="text" aria-required="true">
        </div>
        <div class="field" data-field-type="email">
          <label for="icims_em" class="iCIMS_InfoMsg">Email <span class="required">*</span></label>
          <input id="icims_em" name="email" type="email" aria-required="true">
        </div>
        <div class="field">
          <label for="icims_ph" class="iCIMS_InfoMsg">Phone</label>
          <input id="icims_ph" name="phone" type="tel">
        </div>
        <div class="field">
          <label for="icims_exp" class="iCIMS_InfoMsg">Years of relevant experience *</label>
          <input id="icims_exp" type="number" aria-required="true">
        </div>
        <div class="field">
          <label for="icims_ctc" class="iCIMS_InfoMsg">Expected Annual Salary (INR)</label>
          <input id="icims_ctc" type="text">
        </div>
        <div class="field">
          <legend class="iCIMS_InfoMsg">Are you legally authorized to work in India?</legend>
          <label><input type="radio" name="auth" value="Yes"> Yes</label>
          <label><input type="radio" name="auth" value="No"> No</label>
        </div>
        <div class="field">
          <legend class="iCIMS_InfoMsg">Will you now or in the future require sponsorship?</legend>
          <label><input type="radio" name="visa" value="Yes"> Yes</label>
          <label><input type="radio" name="visa" value="No"> No</label>
        </div>
        <div class="field">
          <label><input type="checkbox" name="agree" required> I certify that the information provided is accurate</label>
        </div>
      </div>
    </div>
  </body></html>`);

  await fillAllFields(page, profile);

  const icResults = await page.evaluate(() => ({
    fn: document.getElementById('icims_fn').value,
    ln: document.getElementById('icims_ln').value,
    em: document.getElementById('icims_em').value,
    ph: document.getElementById('icims_ph').value,
    exp: document.getElementById('icims_exp').value,
    ctc: document.getElementById('icims_ctc').value,
    auth: document.querySelector('input[name="auth"]:checked')?.value || '',
    visa: document.querySelector('input[name="visa"]:checked')?.value || '',
    agree: document.querySelector('input[name="agree"]').checked,
  }));

  if (icResults.fn === profile.firstName) ok(`iCIMS: First name = ${icResults.fn}`);
  else fail(`iCIMS: First name = "${icResults.fn}"`);

  if (icResults.em === profile.email) ok(`iCIMS: Email = ${icResults.em}`);
  else fail(`iCIMS: Email = "${icResults.em}"`);

  if (icResults.exp) ok(`iCIMS: Experience = ${icResults.exp}`);
  else fail('iCIMS: Experience empty');

  if (icResults.auth === 'Yes') ok('iCIMS: Work auth = Yes');
  else fail(`iCIMS: Work auth = "${icResults.auth}"`);

  if (icResults.visa === 'No') ok('iCIMS: Visa sponsorship = No');
  else fail(`iCIMS: Visa = "${icResults.visa}"`);

  if (icResults.agree) ok('iCIMS: Certification checked');
  else fail('iCIMS: Certification not checked');

  // ─── 10. SmartRecruiters Multi-Checkbox Groups ────────────────────────────
  console.log('\n--- Multi-Checkbox & Edge Cases ---');

  await page.setContent(`<html><body><form>
    <fieldset>
      <legend>Select your skills (check all that apply)</legend>
      <label><input type="checkbox" name="skills" value="js"> JavaScript</label>
      <label><input type="checkbox" name="skills" value="py"> Python</label>
      <label><input type="checkbox" name="skills" value="node"> Node.js</label>
      <label><input type="checkbox" name="skills" value="react"> React</label>
      <label><input type="checkbox" name="skills" value="other"> Others</label>
    </fieldset>
    <fieldset>
      <legend>I agree to the privacy policy and terms of use</legend>
      <label><input type="checkbox" name="privacy"> I accept</label>
    </fieldset>
    <!-- Empty form that should not crash -->
    <div></div>
    <!-- Input with no context at all -->
    <input type="text" id="mystery" required>
  </form></body></html>`);

  await fillAllFields(page, profile);

  const cbResults = await page.evaluate(() => {
    const skills = Array.from(document.querySelectorAll('input[name="skills"]'));
    const checked = skills.filter(s => s.checked).map(s => s.value);
    return {
      skillsChecked: checked,
      privacy: document.querySelector('input[name="privacy"]').checked,
      mystery: document.getElementById('mystery').value,
    };
  });

  if (cbResults.skillsChecked.length > 0) ok(`Skills checkbox: ${cbResults.skillsChecked.join(', ')} checked`);
  else fail('Skills checkbox: none checked');

  if (cbResults.privacy) ok('Privacy/terms: checked');
  else fail('Privacy/terms: not checked');

  if (cbResults.mystery) ok(`Mystery required field: filled with "${cbResults.mystery}"`);
  else fail('Mystery required field: empty (should have fallback)');

  // ─── Summary ───────────────────────────────────────────────────────────────
  await browser.close();

  console.log('\n=============================');
  console.log(`\x1b[32m  Passed:  ${passed}\x1b[0m`);
  console.log(`\x1b[31m  Failed:  ${failed}\x1b[0m`);
  console.log(`\x1b[33m  Warnings: ${warnings}\x1b[0m`);
  console.log('=============================');

  if (BUGS.length > 0) {
    console.log('\n BUGS TO FIX:');
    BUGS.forEach((b, i) => console.log(`  ${i + 1}. ${b}`));
  }
})();
