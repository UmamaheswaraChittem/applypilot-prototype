/**
 * Multi-User Parallel Runner
 * Runs job applications for multiple users simultaneously with isolated browser contexts
 */
const path = require('path');
const fs = require('fs');
const { launchStealthBrowser } = require('./stealth');
const { loadProfile } = require('./profile');
const { saveCookies, loadCookies } = require('./scrapers/utils');

/**
 * Load user configs from users/ directory
 * Each user has a JSON file: users/user1.json, users/user2.json, etc.
 */
function loadUserConfigs() {
  const usersDir = path.join(__dirname, '../users');
  if (!fs.existsSync(usersDir)) {
    fs.mkdirSync(usersDir, { recursive: true });
    // Create example config
    const example = {
      name: 'example_user',
      enabled: false,
      linkedinEmail: 'user@gmail.com',
      linkedinPassword: 'password',
      naukriEmail: '',
      naukriPassword: '',
      firstName: 'John',
      lastName: 'Doe',
      phone: '+919876543210',
      city: 'Hyderabad',
      country: 'India',
      state: 'Telangana',
      pincode: '500081',
      totalExperience: 3,
      expectedCtcLPA: 12,
      currentCtcLPA: 10,
      noticeDays: 30,
      skills: 'Node.js,JavaScript,React',
      currentCompany: 'Acme Corp',
      currentTitle: 'Software Developer',
      degree: "Bachelor's",
      university: '',
      linkedinUrl: '',
      githubUrl: '',
      portfolioUrl: '',
      resumePath: '',
      coverLetter: '',
      experienceMap: { 'node': 3, 'react': 2, 'javascript': 3 },
      authorizedToWork: true,
      requiresSponsorship: false,
      willingToRelocate: true,
      searchQueries: ['Node.js developer', 'JavaScript developer'],
      maxApplyPerRun: 30,
    };
    fs.writeFileSync(path.join(usersDir, 'example.json'), JSON.stringify(example, null, 2));
    console.log(`[multi-user] Created example config at users/example.json`);
    return [];
  }

  const configs = [];
  for (const file of fs.readdirSync(usersDir)) {
    if (!file.endsWith('.json')) continue;
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(usersDir, file), 'utf8'));
      if (raw.enabled === false) continue;
      raw._file = file;
      configs.push(raw);
    } catch (err) {
      console.error(`[multi-user] Error loading ${file}: ${err.message}`);
    }
  }
  return configs;
}

/**
 * Run a task for a single user with isolated browser
 * @param {Object} userConfig - User configuration object
 * @param {Function} taskFn - async function(browser, context, page, profile) to execute
 */
async function runForUser(userConfig, taskFn) {
  const profile = loadProfile(userConfig);
  const userName = `${profile.firstName} ${profile.lastName}`;
  console.log(`\n[${userName}] Starting...`);

  const { browser, context, page } = await launchStealthBrowser({
    headless: process.env.HEADLESS !== 'false' ? true : false,
  });

  // Load saved cookies
  const cookieKey = `linkedin_${profile.firstName.toLowerCase()}_${profile.lastName.toLowerCase()}`;
  const cookies = loadCookies(cookieKey);
  if (cookies) {
    await context.addCookies(cookies);
    console.log(`[${userName}] Loaded saved session`);
  }

  try {
    const result = await taskFn(browser, context, page, profile);
    // Save cookies after run
    const allCookies = await context.cookies();
    saveCookies(cookieKey, allCookies);
    console.log(`[${userName}] Completed. Result:`, result);
    return { user: userName, success: true, result };
  } catch (err) {
    console.error(`[${userName}] Error: ${err.message}`);
    return { user: userName, success: false, error: err.message };
  } finally {
    await browser.close().catch(() => {});
  }
}

/**
 * Run tasks for ALL enabled users in parallel
 * @param {Function} taskFn - async function(browser, context, page, profile) to execute per user
 * @param {Object} opts - { maxParallel: 3 }
 */
async function runAllUsersParallel(taskFn, opts = {}) {
  const maxParallel = opts.maxParallel || 3;
  const configs = loadUserConfigs();

  if (configs.length === 0) {
    // Fall back to .env user
    console.log('[multi-user] No user configs found, using .env profile');
    const profile = loadProfile();
    const { browser, context, page } = await launchStealthBrowser({
      headless: process.env.HEADLESS !== 'false' ? true : false,
    });
    const cookies = loadCookies('linkedin');
    if (cookies) await context.addCookies(cookies);

    try {
      const result = await taskFn(browser, context, page, profile);
      saveCookies('linkedin', await context.cookies());
      return [{ user: profile.fullName, success: true, result }];
    } catch (err) {
      return [{ user: profile.fullName, success: false, error: err.message }];
    } finally {
      await browser.close().catch(() => {});
    }
  }

  console.log(`[multi-user] Running for ${configs.length} users (max ${maxParallel} parallel)`);
  const results = [];
  const queue = [...configs];

  // Process in batches
  while (queue.length > 0) {
    const batch = queue.splice(0, maxParallel);
    const batchResults = await Promise.allSettled(
      batch.map(config => runForUser(config, taskFn))
    );
    for (const r of batchResults) {
      results.push(r.status === 'fulfilled' ? r.value : { success: false, error: r.reason?.message });
    }
  }

  // Print summary
  console.log('\n' + '='.repeat(60));
  console.log('MULTI-USER RESULTS');
  console.log('='.repeat(60));
  for (const r of results) {
    console.log(`  ${r.success ? '✓' : '✗'} ${r.user}: ${r.success ? JSON.stringify(r.result) : r.error}`);
  }
  return results;
}

module.exports = { loadUserConfigs, runForUser, runAllUsersParallel, loadProfile };
