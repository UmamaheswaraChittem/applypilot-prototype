require('dotenv').config();
const { chromium } = require('playwright');
const { loginLinkedIn } = require('./src/scrapers/linkedin');
const { loadCookies, saveCookies } = require('./src/scrapers/utils');
const path = require('path');
const DIR = path.join(__dirname, 'debug-screenshots');

(async () => {
  const browser = await chromium.launch({ headless: false, args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'] });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    viewport: { width: 1366, height: 768 },
    locale: 'en-US',
    extraHTTPHeaders: { 'Accept-Language': 'en-US,en;q=0.9' },
  });
  const cookies = loadCookies('linkedin');
  if (cookies) await context.addCookies(cookies);
  const page = await context.newPage();
  await loginLinkedIn(page);

  // Navigate to an Easy Apply job
  await page.goto('https://www.linkedin.com/jobs/view/4289906464/', { waitUntil: 'domcontentloaded', timeout: 15000 });
  await page.waitForTimeout(3000);

  // Click Easy Apply
  const eaBtn = await page.$('a:has-text("Easy Apply"), button:has-text("Easy Apply")');
  if (!eaBtn) { console.log('No Easy Apply button'); await browser.close(); return; }
  const box = await eaBtn.boundingBox();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);

  // Wait for modal
  await page.waitForSelector('button[aria-label*="Continue"], button[aria-label*="Next"], button[aria-label*="Submit"]', {
    timeout: 5000, state: 'visible'
  }).catch(() => null);
  await page.waitForTimeout(500);

  // Screenshot step 0
  await page.screenshot({ path: path.join(DIR, 'step0.png') });
  console.log('Step 0 screenshot saved');

  // Log all visible elements in the modal
  const step0Info = await page.evaluate(() => {
    const info = {};
    // Find the close/dismiss button
    const closeBtns = [...document.querySelectorAll('button')].filter(b => {
      const aria = (b.getAttribute('aria-label') || '').toLowerCase();
      const text = (b.innerText || '').trim();
      return aria.includes('dismiss') || aria.includes('close') || text === '×' || text === '✕';
    });
    info.closeButtons = closeBtns.map(b => ({
      aria: b.getAttribute('aria-label'),
      text: (b.innerText || '').trim().substring(0, 10),
      visible: b.offsetParent !== null,
    }));

    // Find all form elements
    info.inputs = [...document.querySelectorAll('input, select, textarea')]
      .filter(el => el.offsetParent !== null)
      .map(el => ({
        tag: el.tagName,
        type: el.getAttribute('type') || '',
        id: (el.getAttribute('id') || '').substring(0, 30),
        name: (el.getAttribute('name') || '').substring(0, 30),
        placeholder: (el.getAttribute('placeholder') || '').substring(0, 30),
        aria: (el.getAttribute('aria-label') || '').substring(0, 30),
        value: el.tagName === 'SELECT' ? el.value : (el.value || '').substring(0, 30),
      }));

    // Find all buttons
    info.buttons = [...document.querySelectorAll('button')]
      .filter(b => b.offsetParent !== null)
      .map(b => ({
        text: (b.innerText || '').trim().substring(0, 30),
        aria: (b.getAttribute('aria-label') || '').substring(0, 40),
      }))
      .filter(b => b.text || b.aria);

    return info;
  });
  console.log('\nStep 0 Close buttons:', JSON.stringify(step0Info.closeButtons, null, 2));
  console.log('Step 0 Inputs:', JSON.stringify(step0Info.inputs, null, 2));
  console.log('Step 0 Buttons:', JSON.stringify(step0Info.buttons, null, 2));

  // Click Next
  const nextBtn = await page.$('button[aria-label="Continue to next step"], button:has-text("Next")');
  if (nextBtn) {
    console.log('\nClicking Next...');
    await nextBtn.click();
    await page.waitForTimeout(2000);

    // Screenshot step 1
    await page.screenshot({ path: path.join(DIR, 'step1.png') });
    console.log('Step 1 screenshot saved');

    const step1Info = await page.evaluate(() => {
      const info = {};
      info.inputs = [...document.querySelectorAll('input, select, textarea')]
        .filter(el => el.offsetParent !== null)
        .map(el => ({
          tag: el.tagName,
          type: el.getAttribute('type') || '',
          id: (el.getAttribute('id') || '').substring(0, 40),
          name: (el.getAttribute('name') || '').substring(0, 40),
          placeholder: (el.getAttribute('placeholder') || '').substring(0, 40),
          aria: (el.getAttribute('aria-label') || '').substring(0, 40),
          value: el.tagName === 'SELECT' ? el.value : (el.value || '').substring(0, 30),
          required: el.hasAttribute('required'),
        }));
      info.buttons = [...document.querySelectorAll('button')]
        .filter(b => b.offsetParent !== null)
        .map(b => ({
          text: (b.innerText || '').trim().substring(0, 30),
          aria: (b.getAttribute('aria-label') || '').substring(0, 40),
        }))
        .filter(b => b.text || b.aria);
      // Labels and questions
      info.labels = [...document.querySelectorAll('label, legend, h3, h4')]
        .filter(el => el.offsetParent !== null)
        .map(el => (el.innerText || '').trim().substring(0, 60))
        .filter(t => t);
      // Error messages
      info.errors = [...document.querySelectorAll('[class*="error"], [role="alert"]')]
        .filter(el => el.offsetParent !== null)
        .map(el => (el.innerText || '').trim().substring(0, 60));
      return info;
    });
    console.log('\nStep 1 Inputs:', JSON.stringify(step1Info.inputs, null, 2));
    console.log('Step 1 Buttons:', JSON.stringify(step1Info.buttons, null, 2));
    console.log('Step 1 Labels:', step1Info.labels);
    console.log('Step 1 Errors:', step1Info.errors);
  }

  // Dismiss modal
  const dismissBtn = await page.$('button[aria-label="Dismiss"], button[aria-label="Close"]');
  if (dismissBtn) {
    await dismissBtn.click();
    await page.waitForTimeout(500);
    const discardBtn = await page.$('button:has-text("Discard"), button:has-text("Yes, discard")');
    if (discardBtn) await discardBtn.click();
  }

  saveCookies('linkedin', await context.cookies());
  await browser.close();
  console.log('\nDone');
})();
