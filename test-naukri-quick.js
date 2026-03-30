/**
 * Quick Naukri test — login + direct job URL in headed mode
 */
require('dotenv').config();
const { launchStealthBrowser, smartGoto, waitForPageStable, smartWaitForElement } = require('./src/stealth');
const { loadProfile } = require('./src/profile');

async function main() {
  const p = loadProfile();
  console.log(`Profile: ${p.fullName} | ${p.totalExperience}yr | ${p.naukriEmail}`);

  // Launch in headed mode (like real usage)
  const { browser, context, page } = await launchStealthBrowser({
    headless: false,
    locale: 'en-IN',
  });

  try {
    // 1. Login
    console.log('\n1. Logging into Naukri...');
    await smartGoto(page, 'https://www.naukri.com/nlogin/login', { maxWait: 30000 });

    const emailInput = await smartWaitForElement(page, [
      'input[type="text"][placeholder*="Email" i]', 'input[type="email"]',
      'input[id*="email" i]', 'input[placeholder*="ID" i]',
    ], { maxWait: 10000 });

    if (emailInput) {
      await emailInput.fill(p.naukriEmail);
      console.log('  Email filled');
    }

    const pwdInput = await page.$('input[type="password"]');
    if (pwdInput) {
      await pwdInput.fill(p.naukriPassword);
      console.log('  Password filled');
    }

    const loginBtn = await page.$('button[type="submit"], button:has-text("Login")');
    if (loginBtn) {
      await loginBtn.click();
      console.log('  Login clicked, waiting...');
    }

    // Wait for login to complete
    await waitForPageStable(page, { maxWait: 10000, stableCount: 4 });
    console.log(`  URL: ${page.url()}`);

    // 2. Go to search page
    console.log('\n2. Navigating to job search...');
    await smartGoto(page, 'https://www.naukri.com/node-js-developer-jobs?experience=3', { maxWait: 60000 });

    // Extra scroll + wait for SPA rendering
    for (let i = 0; i < 3; i++) {
      await page.evaluate(() => window.scrollBy(0, 400));
      await waitForPageStable(page, { maxWait: 3000 });
    }

    // Debug: dump page state
    const state = await page.evaluate(() => {
      const allEls = document.querySelectorAll('*');
      const classList = new Set();
      for (const el of allEls) {
        if (el.className && typeof el.className === 'string') {
          el.className.split(/\s+/).forEach(c => {
            if (/job|tuple|listing|card|srp|search/i.test(c)) classList.add(c);
          });
        }
      }
      return {
        url: window.location.href,
        title: document.title,
        bodyLen: (document.body.innerText || '').length,
        jobClasses: [...classList].slice(0, 20),
        allLinks: [...document.querySelectorAll('a[href]')].length,
        h1: (document.querySelector('h1') || {}).innerText || '',
        h2s: [...document.querySelectorAll('h2')].map(h => h.innerText.trim().substring(0, 50)),
        bodySnippet: (document.body.innerText || '').substring(0, 800),
      };
    }).catch(() => ({}));

    console.log(`  URL: ${state.url}`);
    console.log(`  Title: ${state.title}`);
    console.log(`  Body: ${state.bodyLen} chars`);
    console.log(`  H1: ${state.h1}`);
    console.log(`  Job-related classes: ${state.jobClasses?.join(', ')}`);
    console.log(`  Total links: ${state.allLinks}`);
    console.log(`  Body snippet:\n${state.bodySnippet?.substring(0, 400)}`);

    // 3. Try a direct job URL
    console.log('\n3. Testing direct job page...');
    // Use Naukri's API to get a job URL
    const jobPage = await context.newPage();
    await smartGoto(jobPage, 'https://www.naukri.com/job-listings-node-js-developer-hyderabad-3-to-5-years-280326?src=jobsearchDe498_1', { maxWait: 45000 });
    await waitForPageStable(jobPage, { maxWait: 8000 });

    const jpState = await jobPage.evaluate(() => ({
      url: window.location.href,
      title: document.title,
      bodyLen: (document.body.innerText || '').length,
      hasApply: !!(document.querySelector('#apply-button, [class*="apply-button"], button[class*="apply"]')),
      buttons: [...document.querySelectorAll('button, a')].filter(b => /apply|interested/i.test(b.innerText)).map(b => b.innerText.trim().substring(0, 30)),
    })).catch(() => ({}));

    console.log(`  Job URL: ${jpState.url}`);
    console.log(`  Title: ${jpState.title}`);
    console.log(`  Body: ${jpState.bodyLen} chars`);
    console.log(`  Has apply: ${jpState.hasApply}`);
    console.log(`  Apply buttons: ${jpState.buttons?.join(', ') || 'none'}`);

    await jobPage.close().catch(() => {});

    // 4. Keep browser open for 5s to verify visually
    console.log('\n4. Browser staying open for visual verification...');
    await page.waitForTimeout(5000);

  } catch (err) {
    console.error(`Error: ${err.message}`);
  } finally {
    await browser.close().catch(() => {});
  }

  console.log('\nDone.');
}

main().catch(console.error);
