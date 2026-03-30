/**
 * Test clicking the external apply button with better popup/modal detection
 */
require('dotenv').config();
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const { loginLinkedIn } = require('./src/scrapers/linkedin');
const { loadCookies, saveCookies } = require('./src/scrapers/utils');

const DIR = path.join(__dirname, 'debug-screenshots');

(async () => {
  const browser = await chromium.launch({
    headless: false,
    args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'],
  });
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
  saveCookies('linkedin', await context.cookies());

  const jobUrl = 'https://www.linkedin.com/jobs/view/4393639520/';
  console.log(`Opening: ${jobUrl}`);
  await page.goto(jobUrl, { waitUntil: 'networkidle', timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(4000);

  // Find the apply button
  const APPLY_TEXT_RE = /^(easy\s*apply|apply(\s+now)?|تقديم|تقدم|التقديم|التقدم|تطبيق|قدّم|تقدّم)/i;
  const allButtons = await page.$$('button, a');
  let applyBtn = null;
  for (const btn of allButtons) {
    try {
      if (!await btn.isVisible().catch(() => false)) continue;
      const txt = (await btn.innerText().catch(() => '')).trim();
      if (APPLY_TEXT_RE.test(txt)) {
        const ariaLabel = await btn.getAttribute('aria-label') || '';
        const tag = await btn.evaluate(e => e.tagName);
        const href = await btn.getAttribute('href') || '';
        console.log(`Found: <${tag}> "${txt}" aria="${ariaLabel}" href="${href.substring(0, 80)}"`);
        applyBtn = btn;
        break;
      }
    } catch {}
  }

  if (!applyBtn) {
    console.log('No apply button found!');
    await browser.close();
    return;
  }

  // Before clicking: set up ALL possible detection
  console.log('\nSetting up detection and clicking...');

  // Listen for new pages
  let popupUrl = null;
  context.on('page', async (newPage) => {
    await newPage.waitForLoadState('domcontentloaded').catch(() => {});
    popupUrl = newPage.url();
    console.log(`  → New tab opened: ${popupUrl}`);
  });

  // Listen for navigation
  let navigatedUrl = null;
  page.on('framenavigated', (frame) => {
    if (frame === page.mainFrame()) {
      navigatedUrl = frame.url();
    }
  });

  // Click using multiple methods
  console.log('Attempt 1: Direct click...');
  await applyBtn.click({ timeout: 3000 }).catch(e => console.log(`  click failed: ${e.message.substring(0, 50)}`));
  await page.waitForTimeout(3000);

  console.log(`After click 1: URL=${page.url().substring(0, 80)} popup=${popupUrl} nav=${navigatedUrl}`);
  await page.screenshot({ path: path.join(DIR, 'after-click-1.png') });

  // Check for modal/overlay
  const modal = await page.evaluate(() => {
    const dialogs = document.querySelectorAll('[role="dialog"], [role="alertdialog"], .modal, [class*="modal"], [class*="overlay"], [class*="popup"]');
    for (const d of dialogs) {
      if (d.offsetParent !== null || d.style.display !== 'none') {
        return {
          text: d.innerText.substring(0, 300),
          links: [...d.querySelectorAll('a[href]')].map(a => ({ text: a.innerText.trim().substring(0, 30), href: a.href.substring(0, 80) })).slice(0, 5),
          buttons: [...d.querySelectorAll('button')].map(b => b.innerText.trim().substring(0, 30)).slice(0, 5),
        };
      }
    }
    return null;
  }).catch(() => null);

  if (modal) {
    console.log('\n  → Modal found:');
    console.log(`    Text: ${modal.text.replace(/\n/g, ' ').substring(0, 200)}`);
    console.log(`    Links: ${JSON.stringify(modal.links)}`);
    console.log(`    Buttons: ${modal.buttons.join(', ')}`);
  } else {
    console.log('  → No modal detected');
  }

  // Attempt 2: JS click
  if (!popupUrl && !navigatedUrl?.includes('http') && page.url() === jobUrl) {
    console.log('\nAttempt 2: JS click...');
    await page.evaluate(() => {
      const btns = [...document.querySelectorAll('button, a')];
      for (const b of btns) {
        const txt = (b.innerText || '').trim();
        if (/^تطبيق|^apply/i.test(txt)) {
          b.click();
          console.log('JS clicked:', txt);
          break;
        }
      }
    });
    await page.waitForTimeout(3000);
    console.log(`After click 2: URL=${page.url().substring(0, 80)} popup=${popupUrl}`);
    await page.screenshot({ path: path.join(DIR, 'after-click-2.png') });

    // Check modal again
    const modal2 = await page.evaluate(() => {
      const all = [...document.querySelectorAll('*')].filter(e => {
        const s = window.getComputedStyle(e);
        return s.position === 'fixed' && s.display !== 'none' && s.visibility !== 'hidden' && e.offsetHeight > 100;
      });
      return all.map(e => ({
        class: (e.className||'').toString().substring(0, 50),
        text: (e.innerText||'').substring(0, 200),
      })).slice(0, 3);
    }).catch(() => []);

    if (modal2.length) {
      console.log('  → Fixed-position overlays:');
      for (const m of modal2) {
        console.log(`    class="${m.class}" text="${m.text.replace(/\n/g,' ').substring(0,100)}"`);
      }
    }
  }

  await page.waitForTimeout(2000);
  await browser.close();
  console.log('\n✓ Done');
})();
