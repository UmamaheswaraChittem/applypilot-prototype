/**
 * Debug: What happens when clicking Easy Apply?
 */
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

  // Search Easy Apply jobs
  await page.goto('https://www.linkedin.com/jobs/search/?keywords=Node.js&f_AL=true&f_WT=2&sortBy=DD&geoId=102713980', {
    waitUntil: 'domcontentloaded', timeout: 30000
  });
  await page.waitForTimeout(3000);

  // Click first job card
  const firstJob = await page.$('a[href*="/jobs/view/"]');
  if (!firstJob) { console.log('No jobs found'); await browser.close(); return; }
  const jobUrl = await firstJob.getAttribute('href');
  console.log('Job URL:', jobUrl);

  await page.goto('https://www.linkedin.com' + jobUrl.split('?')[0], { waitUntil: 'domcontentloaded', timeout: 20000 });
  await page.waitForTimeout(3000);

  // Screenshot before click
  await page.screenshot({ path: path.join(DIR, 'ea-1-before-click.png') });

  // Find Easy Apply button — log EVERYTHING about it
  const eaInfo = await page.evaluate(() => {
    const all = [...document.querySelectorAll('button, a[role="button"], a[href]')];
    const btns = all.filter(el => {
      const txt = (el.innerText || '').trim();
      return /easy\s*apply/i.test(txt) || /easy\s*apply/i.test(el.getAttribute('aria-label') || '');
    });
    return btns.map(b => ({
      tag: b.tagName,
      text: (b.innerText || '').trim().substring(0, 30),
      aria: (b.getAttribute('aria-label') || '').substring(0, 50),
      href: (b.getAttribute('href') || '').substring(0, 80),
      cls: (b.className || '').toString().substring(0, 80),
      id: b.id || '',
      type: b.getAttribute('type') || '',
      role: b.getAttribute('role') || '',
      onclick: b.getAttribute('onclick') || '',
      rect: b.getBoundingClientRect ? {
        x: Math.round(b.getBoundingClientRect().x),
        y: Math.round(b.getBoundingClientRect().y),
        w: Math.round(b.getBoundingClientRect().width),
        h: Math.round(b.getBoundingClientRect().height),
      } : null,
    }));
  });
  console.log('\nEasy Apply buttons found:', JSON.stringify(eaInfo, null, 2));

  // Count all [role="dialog"] elements on page BEFORE clicking
  const dialogsBefore = await page.evaluate(() => {
    return [...document.querySelectorAll('[role="dialog"]')].map(d => ({
      id: d.id || '',
      cls: (d.className || '').toString().substring(0, 60),
      text: (d.innerText || '').substring(0, 100),
      visible: d.offsetParent !== null || window.getComputedStyle(d).display !== 'none',
      rect: {
        x: Math.round(d.getBoundingClientRect().x),
        y: Math.round(d.getBoundingClientRect().y),
        w: Math.round(d.getBoundingClientRect().width),
        h: Math.round(d.getBoundingClientRect().height),
      },
    }));
  });
  console.log('\nDialogs BEFORE click:', JSON.stringify(dialogsBefore, null, 2));

  // Try clicking via multiple methods
  const eaBtn = await page.$('button:has-text("Easy Apply"), a:has-text("Easy Apply")');
  if (!eaBtn) { console.log('No Easy Apply button found'); await browser.close(); return; }

  console.log('\n--- Method 1: Playwright click ---');
  await eaBtn.click({ timeout: 5000 }).catch(e => console.log('Click error:', e.message.substring(0, 80)));
  await page.waitForTimeout(2000);

  // Screenshot after click
  await page.screenshot({ path: path.join(DIR, 'ea-2-after-click.png') });

  // Check URL change
  console.log('URL after click:', page.url().substring(0, 80));

  // Count dialogs AFTER clicking
  const dialogsAfter = await page.evaluate(() => {
    return [...document.querySelectorAll('[role="dialog"]')].map(d => ({
      id: d.id || '',
      cls: (d.className || '').toString().substring(0, 60),
      text: (d.innerText || '').substring(0, 200).replace(/\n/g, ' | '),
      visible: d.offsetParent !== null || window.getComputedStyle(d).display !== 'none',
      hasForm: !!d.querySelector('form, input, select, textarea'),
      hasButtons: [...d.querySelectorAll('button')].filter(b => b.offsetParent !== null).map(b => ({
        text: b.innerText.trim().substring(0, 30),
        aria: (b.getAttribute('aria-label') || '').substring(0, 40),
      })),
    }));
  });
  console.log('\nDialogs AFTER click:', JSON.stringify(dialogsAfter, null, 2));

  // Check if we navigated to SDUI
  if (page.url().includes('/apply/')) {
    console.log('\n→ SDUI flow detected!');
    await page.screenshot({ path: path.join(DIR, 'ea-3-sdui.png') });
    // Check for form elements
    const formInfo = await page.evaluate(() => ({
      inputs: document.querySelectorAll('input, select, textarea').length,
      buttons: [...document.querySelectorAll('button')].filter(b => b.offsetParent !== null)
        .map(b => ({ text: b.innerText.trim().substring(0, 30), aria: (b.getAttribute('aria-label') || '').substring(0, 40) })),
    }));
    console.log('Form info:', JSON.stringify(formInfo, null, 2));
  }

  // If no modal found, try Method 2: keyboard
  if (!page.url().includes('/apply/') && dialogsAfter.filter(d => d.hasForm).length === 0) {
    console.log('\n--- Method 2: Focus + Enter ---');
    // Navigate back if needed
    if (!page.url().includes('/jobs/view/')) {
      await page.goto('https://www.linkedin.com' + jobUrl.split('?')[0], { waitUntil: 'domcontentloaded', timeout: 20000 });
      await page.waitForTimeout(2000);
    }
    const eaBtn2 = await page.$('button:has-text("Easy Apply"), a:has-text("Easy Apply")');
    if (eaBtn2) {
      await eaBtn2.focus();
      await page.keyboard.press('Enter');
      await page.waitForTimeout(2000);
      await page.screenshot({ path: path.join(DIR, 'ea-4-after-enter.png') });
      console.log('URL after Enter:', page.url().substring(0, 80));
    }
  }

  // Method 3: Mouse click at coordinates
  if (!page.url().includes('/apply/')) {
    console.log('\n--- Method 3: Mouse click at coordinates ---');
    const eaBtn3 = await page.$('button:has-text("Easy Apply"), a:has-text("Easy Apply")');
    if (eaBtn3) {
      const box = await eaBtn3.boundingBox();
      if (box) {
        console.log(`Clicking at (${box.x + box.width/2}, ${box.y + box.height/2})`);
        await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
        await page.waitForTimeout(2000);
        await page.screenshot({ path: path.join(DIR, 'ea-5-after-mouse.png') });
        console.log('URL after mouse click:', page.url().substring(0, 80));

        const dialogsAfterMouse = await page.evaluate(() => {
          return [...document.querySelectorAll('[role="dialog"]')].map(d => ({
            cls: (d.className || '').toString().substring(0, 60),
            text: (d.innerText || '').substring(0, 200).replace(/\n/g, ' | '),
            hasForm: !!d.querySelector('form, input, select, textarea'),
          }));
        });
        console.log('Dialogs after mouse:', JSON.stringify(dialogsAfterMouse, null, 2));
      }
    }
  }

  saveCookies('linkedin', await context.cookies());
  await browser.close();
  console.log('\nDone');
})();
