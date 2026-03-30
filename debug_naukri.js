require('dotenv').config();
const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ headless: false });
  const page = await browser.newPage({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
  });

  await page.goto('https://www.naukri.com/senior-nodejs-engineer-jobs-in-india?jobAge=7', {
    waitUntil: 'domcontentloaded', timeout: 40000
  });

  await page.waitForTimeout(4000);

  const info = await page.evaluate(() => {
    // Get outer HTML of first 3 job-looking containers
    const allEls = document.querySelectorAll('*');
    const results = [];

    for (const el of allEls) {
      const cls = el.className || '';
      // Look for elements whose class contains job-related keywords
      if (typeof cls === 'string' && (
        cls.includes('tuple') || cls.includes('jobcard') ||
        cls.includes('job-card') || cls.includes('srp') ||
        cls.includes('result') || cls.includes('listing')
      )) {
        const text = el.innerText?.slice(0, 80).replace(/\n/g,' ');
        if (text && text.length > 15) {
          results.push({
            tag: el.tagName,
            cls: cls.slice(0, 120),
            text: text
          });
        }
      }
      if (results.length >= 15) break;
    }

    // Also get all unique top-level class names from the main job list container
    const mainList = document.querySelector('.list, #listContainer, [class*="list"], main');
    const topChildren = mainList ? Array.from(mainList.children).slice(0,5) : [];
    const childInfo = topChildren.map(c => ({
      tag: c.tagName,
      cls: (c.className||'').slice(0,120),
      text: (c.innerText||'').slice(0,80).replace(/\n/g,' ')
    }));

    return { results, childInfo };
  });

  console.log('\n=== Elements with job-related class names ===');
  info.results.forEach((el, i) => {
    console.log(`${i+1}. <${el.tag}> class="${el.cls}"`);
    console.log(`   "${el.text}"\n`);
  });

  console.log('\n=== Top-level children of main list ===');
  info.childInfo.forEach((el, i) => {
    console.log(`${i+1}. <${el.tag}> class="${el.cls}"`);
    console.log(`   "${el.text}"\n`);
  });

  await browser.close();
})();
