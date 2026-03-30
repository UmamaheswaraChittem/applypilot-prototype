/**
 * Fix LinkedIn language to English.
 * This is a one-time fix — changes persist on the account.
 */
require('dotenv').config();
const { chromium } = require('playwright');
const { loginLinkedIn } = require('./src/scrapers/linkedin');
const { loadCookies, saveCookies } = require('./src/scrapers/utils');

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

  console.log('Current language:', await page.evaluate(() => document.documentElement.lang));

  // Try the LinkedIn API to change language
  console.log('\nAttempting to change language via LinkedIn API...');

  // Method 1: Use the settings API endpoint
  const csrfToken = await page.evaluate(() => {
    // LinkedIn stores CSRF token in a meta tag or cookie
    const meta = document.querySelector('meta[name="csrf-token"]');
    if (meta) return meta.content;
    const cookies = document.cookie.split(';');
    for (const c of cookies) {
      const [k, v] = c.trim().split('=');
      if (k === 'JSESSIONID') return v.replace(/"/g, '');
    }
    return null;
  });
  console.log('CSRF token:', csrfToken ? csrfToken.substring(0, 20) + '...' : 'NOT FOUND');

  if (csrfToken) {
    // Try the API call to change language
    const result = await page.evaluate(async (token) => {
      try {
        const res = await fetch('https://www.linkedin.com/psettings/select-language', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'csrf-token': token,
          },
          body: 'defaultLanguage=en_US&_csrf=' + encodeURIComponent(token),
          credentials: 'include',
        });
        return { status: res.status, url: res.url, ok: res.ok };
      } catch (e) {
        return { error: e.message };
      }
    }, csrfToken);
    console.log('API result:', JSON.stringify(result));
  }

  // Method 2: Navigate to language settings
  console.log('\nTrying settings pages...');
  const settingsUrls = [
    'https://www.linkedin.com/psettings/select-language',
    'https://www.linkedin.com/mypreferences/d/categories/language',
    'https://www.linkedin.com/psettings/',
    'https://www.linkedin.com/mypreferences/d/settings',
  ];

  for (const url of settingsUrls) {
    console.log(`\nTrying: ${url}`);
    await page.goto(url, { waitUntil: 'networkidle', timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(2000);
    const finalUrl = page.url();
    const title = await page.title();
    console.log(`  → ${finalUrl.substring(0, 80)} | "${title.substring(0, 50)}"`);

    if (!finalUrl.includes('not-found') && !finalUrl.includes('404')) {
      // Look for language dropdown or settings
      const langElements = await page.evaluate(() => {
        const all = [...document.querySelectorAll('select, input[type="radio"], button, a')];
        return all
          .filter(e => {
            const txt = (e.innerText || e.getAttribute('aria-label') || '').toLowerCase();
            return txt.includes('english') || txt.includes('language') || txt.includes('لغة') || txt.includes('إنجليزي');
          })
          .slice(0, 5)
          .map(e => ({
            tag: e.tagName,
            text: (e.innerText || '').trim().substring(0, 50),
            class: (e.className || '').toString().substring(0, 40),
            href: e.href || '',
          }));
      }).catch(() => []);

      if (langElements.length > 0) {
        console.log('  Found language elements:');
        for (const el of langElements) {
          console.log(`    <${el.tag}> "${el.text}" class="${el.class}" href="${el.href.substring(0, 50)}"`);
        }
      }

      // Look for any element mentioning English
      const hasEnglish = await page.evaluate(() => {
        return (document.body.innerText || '').includes('English') || (document.body.innerText || '').includes('إنجليزي');
      }).catch(() => false);
      if (hasEnglish) {
        console.log('  → Page mentions English!');

        // Try clicking on English option
        const englishBtn = await page.$('text=English') || await page.$('text=إنجليزي');
        if (englishBtn) {
          console.log('  → Clicking English option...');
          await englishBtn.click().catch(() => {});
          await page.waitForTimeout(2000);

          // Look for save button
          const saveBtn = await page.$('button[type="submit"], button:has-text("Save"), button:has-text("حفظ")');
          if (saveBtn) {
            console.log('  → Clicking Save...');
            await saveBtn.click().catch(() => {});
            await page.waitForTimeout(3000);
          }
        }
      }
    }
  }

  // Check final language
  await page.goto('https://www.linkedin.com/feed/', { waitUntil: 'networkidle', timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(3000);
  const finalLang = await page.evaluate(() => document.documentElement.lang);
  console.log(`\nFinal language: ${finalLang}`);

  if (finalLang === 'ar') {
    console.log('\n⚠ Language is STILL Arabic.');
    console.log('Please change it manually:');
    console.log('1. Go to linkedin.com in your browser');
    console.log('2. Click your profile picture → Settings');
    console.log('3. Under "Account preferences" → "Site preferences" → "Language"');
    console.log('4. Change to English');
    console.log('\nThis is a one-time change that will fix the automation.');
  } else {
    console.log('\n✓ Language changed to English!');
  }

  saveCookies('linkedin', await context.cookies());
  await browser.close();
})();
