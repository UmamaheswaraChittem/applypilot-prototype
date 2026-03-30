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
  });
  const cookies = loadCookies('linkedin');
  if (cookies) await context.addCookies(cookies);
  const page = await context.newPage();
  await loginLinkedIn(page);

  // Go directly to language settings
  console.log('Opening language settings...');
  await page.goto('https://www.linkedin.com/mypreferences/d/settings/language', { waitUntil: 'networkidle', timeout: 20000 });
  await page.waitForTimeout(2000);

  // Find the language dropdown
  const select = await page.$('select');
  if (!select) { console.log('No select dropdown found!'); await browser.close(); return; }

  // Get current value and all options
  const info = await select.evaluate(el => ({
    current: el.value,
    options: [...el.options].map(o => ({ value: o.value, text: o.text.trim() })),
  }));
  console.log(`Current: ${info.current}`);
  const englishOpt = info.options.find(o => o.value === 'en_US' || o.value.startsWith('en'));
  console.log(`English option: ${JSON.stringify(englishOpt)}`);

  if (!englishOpt) {
    console.log('English option not found! Available:', info.options.slice(0, 5).map(o => o.value).join(', '));
    await browser.close();
    return;
  }

  // Select English
  console.log(`Selecting: ${englishOpt.value}`);
  await select.selectOption(englishOpt.value);
  await page.waitForTimeout(1000);

  // Find and click Save button
  const saveBtn = await page.$('button[type="submit"]') ||
    await page.$('button:has-text("Save")') ||
    await page.$('button:has-text("حفظ")') ||
    await page.$('button:has-text("Apply")');

  if (saveBtn) {
    const saveTxt = await saveBtn.innerText().catch(() => '');
    console.log(`Clicking save: "${saveTxt.trim()}"`);
    await saveBtn.click();
    await page.waitForTimeout(3000);
  } else {
    // Try form submit
    console.log('No save button — trying form submit...');
    await page.evaluate(() => {
      const form = document.querySelector('form');
      if (form) form.submit();
    });
    await page.waitForTimeout(3000);
  }

  // Verify
  await page.goto('https://www.linkedin.com/feed/', { waitUntil: 'networkidle', timeout: 20000 });
  await page.waitForTimeout(3000);
  const lang = await page.evaluate(() => document.documentElement.lang);
  const navText = await page.evaluate(() => {
    const btns = [...document.querySelectorAll('button, a')].slice(0, 5).map(e => e.innerText?.trim()?.substring(0, 20));
    return btns.join(', ');
  });
  console.log(`\nResult: lang="${lang}" nav="${navText}"`);
  console.log(lang === 'en' ? '✓ SUCCESS — Language changed to English!' : `⚠ Still ${lang}`);

  saveCookies('linkedin', await context.cookies());
  await browser.close();
})();
