/**
 * Debug Naukri rendering issue — check what's actually loading
 */
require('dotenv').config();
const { launchStealthBrowser, waitForPageStable } = require('./src/stealth');
const { loadProfile } = require('./src/profile');

async function main() {
  const p = loadProfile();
  const { browser, context, page } = await launchStealthBrowser({
    headless: false,
    locale: 'en-IN',
  });

  try {
    // Login
    await page.goto('https://www.naukri.com/nlogin/login', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(2000);
    await page.$('input[type="text"][placeholder*="Email" i], input[type="email"]').then(el => el?.fill(p.naukriEmail));
    await page.$('input[type="password"]').then(el => el?.fill(p.naukriPassword));
    await page.$('button[type="submit"]').then(el => el?.click());
    await page.waitForTimeout(5000);
    console.log('Logged in:', page.url());

    // Try job search with full page.goto
    console.log('\nNavigating to search...');
    await page.goto('https://www.naukri.com/node-js-developer-jobs?experience=3', { waitUntil: 'load', timeout: 60000 }).catch(() => {});

    // Wait longer for SPA to render
    console.log('Waiting for SPA render...');
    await page.waitForTimeout(8000);

    // Scroll aggressively
    for (let i = 0; i < 10; i++) {
      await page.evaluate(() => window.scrollBy(0, 300));
      await page.waitForTimeout(500);
    }
    await page.waitForTimeout(3000);

    // Check full body
    const bodyText = await page.evaluate(() => document.body.innerText).catch(() => '');
    console.log(`Body length: ${bodyText.length}`);
    console.log(`Body (first 1500 chars):\n${bodyText.substring(0, 1500)}`);

    // Check for any iframes (Naukri sometimes uses iframes for job lists)
    const iframes = await page.$$('iframe');
    console.log(`\nIframes: ${iframes.length}`);
    for (const iframe of iframes) {
      const src = await iframe.getAttribute('src').catch(() => '');
      console.log(`  iframe src: ${src}`);
    }

    // Check network requests
    console.log('\nChecking if job API calls are blocked...');
    const interceptedUrls = [];
    context.on('response', response => {
      const url = response.url();
      if (/job|search|listing|srp|tuple/i.test(url)) {
        interceptedUrls.push(`${response.status()} ${url.substring(0, 100)}`);
      }
    });

    // Reload to see network
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(10000);

    console.log('\nJob-related network requests:');
    interceptedUrls.forEach(u => console.log(`  ${u}`));

    // Check if body text has job titles
    const bodyText2 = await page.evaluate(() => document.body.innerText).catch(() => '');
    console.log(`\nFull body length: ${bodyText2.length}`);
    // Look for job-related text after the filters
    const lines = bodyText2.split('\n').filter(l => l.trim().length > 10);
    const jobLines = lines.filter(l => /developer|engineer|node|react|backend|frontend|lead|senior|manager/i.test(l));
    console.log(`Lines with job titles: ${jobLines.length}`);
    jobLines.slice(0, 10).forEach(l => console.log(`  "${l.trim().substring(0, 80)}"`));

    // Find elements containing job title text
    const jobElements = await page.evaluate(() => {
      const titles = ['Node JS', 'Fullstack Developer', 'Full Stack', 'Software Engineer', 'Backend', 'Frontend'];
      const results = [];
      const allEls = document.querySelectorAll('a, div, span, h1, h2, h3, h4, p');
      for (const el of allEls) {
        const text = (el.innerText || '').trim();
        if (text.length > 10 && text.length < 100) {
          if (titles.some(t => text.includes(t))) {
            const link = el.closest('a') || el.querySelector('a');
            results.push({
              tag: el.tagName,
              text: text.substring(0, 60),
              href: (link?.href || el.getAttribute('href') || '').substring(0, 100),
              class: (el.className || '').substring(0, 60),
              parent: (el.parentElement?.className || '').substring(0, 60),
              dataAttrs: [...el.attributes].filter(a => a.name.startsWith('data-')).map(a => `${a.name}="${a.value}"`).join(', ').substring(0, 100),
            });
          }
        }
      }
      return results.slice(0, 10);
    }).catch(() => []);
    console.log(`\nJob elements found: ${jobElements.length}`);
    jobElements.forEach(e => console.log(`  <${e.tag} class="${e.class}"> "${e.text}" href="${e.href}" data=[${e.dataAttrs}] parent="${e.parent}"`));

    // Find the job card containers and their click handlers
    const jobCards = await page.evaluate(() => {
      const titleDivs = [...document.querySelectorAll('div')].filter(d => {
        const cls = d.className || '';
        const text = (d.innerText || '').trim();
        return cls.includes('text-ellipsis') && cls.includes('whitespace-nowrap') && text.length > 10 && text.length < 80 &&
          /developer|engineer|node|react|frontend|backend|full\s?stack|lead|senior/i.test(text);
      });

      return titleDivs.slice(0, 5).map(d => {
        // Walk up to find the clickable parent
        let parent = d;
        let clickable = null;
        for (let i = 0; i < 10 && parent; i++) {
          if (parent.onclick || parent.getAttribute('role') === 'button' || parent.tagName === 'A' ||
              (parent.className || '').includes('cursor-pointer') || parent.style?.cursor === 'pointer') {
            clickable = parent;
            break;
          }
          parent = parent.parentElement;
        }

        // Also check for data attributes on parents
        parent = d;
        let jobId = '';
        for (let i = 0; i < 10 && parent; i++) {
          for (const attr of parent.attributes || []) {
            if (attr.name.startsWith('data-') && attr.value) {
              if (/job|id|jd/i.test(attr.name)) {
                jobId = `${attr.name}="${attr.value}"`;
                break;
              }
            }
          }
          if (jobId) break;
          parent = parent.parentElement;
        }

        return {
          title: (d.innerText || '').trim().substring(0, 60),
          className: (d.className || '').substring(0, 80),
          parentClasses: [...new Set([
            d.parentElement?.className,
            d.parentElement?.parentElement?.className,
            d.parentElement?.parentElement?.parentElement?.className,
          ].filter(Boolean).map(c => c.substring(0, 80)))],
          clickable: clickable ? {
            tag: clickable.tagName,
            class: (clickable.className || '').substring(0, 60),
            href: clickable.href || '',
            role: clickable.getAttribute('role') || '',
          } : null,
          jobId,
        };
      });
    }).catch(() => []);

    console.log(`\nJob card analysis: ${jobCards.length}`);
    jobCards.forEach(c => {
      console.log(`  "${c.title}"`);
      console.log(`    class: ${c.className}`);
      console.log(`    parents: ${c.parentClasses.join(' → ')}`);
      console.log(`    clickable: ${JSON.stringify(c.clickable)}`);
      console.log(`    jobId: ${c.jobId}`);
    });

    // Try clicking the first job title to see what happens
    if (jobCards.length > 0) {
      console.log('\nClicking first job card...');
      const firstTitle = await page.$(`div.text-ellipsis.whitespace-nowrap >> text="${jobCards[0].title.substring(0, 30)}"`).catch(() => null) ||
        await page.locator(`text="${jobCards[0].title.substring(0, 30)}"`).first().elementHandle().catch(() => null);
      if (firstTitle) {
        const [popup] = await Promise.all([
          context.waitForEvent('page', { timeout: 5000 }).catch(() => null),
          firstTitle.click(),
        ]);
        await page.waitForTimeout(2000);
        const newUrl = popup ? popup.url() : page.url();
        console.log(`  After click URL: ${newUrl}`);
        if (popup) await popup.close().catch(() => {});
      } else {
        console.log('  Could not find first title element for click');
      }
    }

    // Keep open for visual check
    await page.waitForTimeout(5000);

  } finally {
    await browser.close().catch(() => {});
  }
}

main().catch(console.error);
