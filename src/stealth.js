/**
 * Stealth Browser Launcher — Anti-bot evasion for all platforms
 * Prevents detection by LinkedIn, Workday, Greenhouse, Lever, SmartRecruiters, etc.
 */
const { chromium } = require('playwright');

// Realistic Chrome user agents (rotate per session)
const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
];

const VIEWPORTS = [
  { width: 1366, height: 768 },
  { width: 1440, height: 900 },
  { width: 1536, height: 864 },
  { width: 1920, height: 1080 },
  { width: 1280, height: 720 },
];

const WEBGL_VENDORS = ['Intel Inc.', 'Google Inc. (Intel)', 'Google Inc. (NVIDIA)'];
const WEBGL_RENDERERS = [
  'Intel Iris OpenGL Engine',
  'ANGLE (Intel, Intel(R) UHD Graphics 620 Direct3D11 vs_5_0 ps_5_0, D3D11)',
  'ANGLE (NVIDIA, NVIDIA GeForce GTX 1650 Direct3D11 vs_5_0 ps_5_0, D3D11)',
];

function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

// Stealth scripts injected into every page
const STEALTH_SCRIPTS = [
  // 1. Hide webdriver flag — must be on prototype (Navigator.prototype), not navigator itself
  // Real browsers have webdriver as a getter on the prototype, not an own property
  `(function() {
    const proto = Object.getPrototypeOf(navigator);
    // Remove any existing definition
    delete proto.webdriver;
    // Also remove from navigator itself (Playwright may set it directly)
    if (navigator.hasOwnProperty('webdriver')) {
      delete navigator.webdriver;
    }
    // Redefine on the PROTOTYPE (like a real browser) — not on navigator
    Object.defineProperty(proto, 'webdriver', {
      get: () => false,
      configurable: true,
      enumerable: true,
    });
  })();`,

  // 2. Fake plugins array as proper PluginArray
  `(function() {
    function FakePlugin(name, filename, description) {
      this.name = name; this.filename = filename; this.description = description; this.length = 0;
    }
    FakePlugin.prototype[Symbol.toStringTag] = 'Plugin';
    const plugins = [
      new FakePlugin('Chrome PDF Plugin', 'internal-pdf-viewer', 'Portable Document Format'),
      new FakePlugin('Chrome PDF Viewer', 'mhjfbmdgcfjbbpaeojofohoefgiehjai', ''),
      new FakePlugin('Native Client', 'internal-nacl-plugin', ''),
    ];
    const fakePluginArray = Object.create(PluginArray.prototype);
    for (let i = 0; i < plugins.length; i++) fakePluginArray[i] = plugins[i];
    Object.defineProperty(fakePluginArray, 'length', { get: () => 3 });
    fakePluginArray.item = i => plugins[i] || null;
    fakePluginArray.namedItem = n => plugins.find(x => x.name === n) || null;
    fakePluginArray.refresh = () => {};
    Object.defineProperty(navigator, 'plugins', { get: () => fakePluginArray });
  })();`,

  // 3. Fake languages
  `Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });`,

  // 4. Fix chrome object
  `window.chrome = {
    runtime: { onMessage: { addListener: () => {}, removeListener: () => {} }, sendMessage: () => {}, connect: () => ({ onMessage: { addListener: () => {} }, postMessage: () => {} }) },
    loadTimes: () => ({ requestTime: Date.now() / 1000, startLoadTime: Date.now() / 1000, commitLoadTime: Date.now() / 1000, finishDocumentLoadTime: Date.now() / 1000, finishLoadTime: Date.now() / 1000 }),
    csi: () => ({ pageT: Date.now(), startE: Date.now(), onloadT: Date.now() }),
    app: { isInstalled: false, InstallState: { INSTALLED: 'installed', NOT_INSTALLED: 'not_installed' }, RunningState: { CANNOT_RUN: 'cannot_run', READY_TO_RUN: 'ready_to_run', RUNNING: 'running' } },
  };`,

  // 5. Fix permissions API
  `const origQuery = window.navigator.permissions?.query?.bind(window.navigator.permissions);
  if (origQuery) {
    window.navigator.permissions.query = (params) => {
      if (params.name === 'notifications') return Promise.resolve({ state: Notification.permission });
      return origQuery(params);
    };
  }`,

  // 6. Prevent iframe detection — but DON'T break cross-origin iframes
  // (reCAPTCHA, hCaptcha, Turnstile use iframes and need real contentWindow)
  // Only intercept when detection scripts try to check for automation via iframes
  `(function() {
    const origContentWindow = Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype, 'contentWindow');
    Object.defineProperty(HTMLIFrameElement.prototype, 'contentWindow', {
      get: function() {
        const win = origContentWindow.get.call(this);
        // Only spoof for same-origin iframes used for detection (not cross-origin ones like CAPTCHA)
        try {
          // If we can access the iframe's document, it's same-origin — safe to spoof
          if (win && win.document) {
            // Patch the iframe's navigator.webdriver too
            try { Object.defineProperty(win.navigator, 'webdriver', { get: () => false }); } catch {}
          }
        } catch {
          // Cross-origin iframe — don't touch it (CAPTCHA, OAuth, etc.)
        }
        return win;
      }
    });
  })();`,

  // 7. Fix toString for overridden functions
  `const nativeToString = Function.prototype.toString;
  const overrides = new Map();
  const handler = { apply: function(target, ctx, args) { return overrides.has(ctx) ? overrides.get(ctx) : nativeToString.call(ctx); } };
  Function.prototype.toString = new Proxy(nativeToString, handler);
  overrides.set(Function.prototype.toString, 'function toString() { [native code] }');`,

  // 8. Canvas fingerprint noise (subtle random pixel shifts)
  `const origGetContext = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function(type, attrs) {
    const ctx = origGetContext.call(this, type, attrs);
    if (type === '2d' && ctx) {
      const origGetImageData = ctx.getImageData.bind(ctx);
      ctx.getImageData = function(x, y, w, h) {
        const data = origGetImageData(x, y, w, h);
        for (let i = 0; i < Math.min(data.data.length, 20); i += 4) {
          data.data[i] = data.data[i] ^ (Math.random() > 0.5 ? 1 : 0);
        }
        return data;
      };
    }
    return ctx;
  };`,

  // 9. WebGL vendor/renderer spoofing
  `const getParameter = WebGLRenderingContext.prototype.getParameter;
  WebGLRenderingContext.prototype.getParameter = function(param) {
    if (param === 37445) return '${pick(WEBGL_VENDORS)}';
    if (param === 37446) return '${pick(WEBGL_RENDERERS)}';
    return getParameter.call(this, param);
  };
  if (typeof WebGL2RenderingContext !== 'undefined') {
    const getParameter2 = WebGL2RenderingContext.prototype.getParameter;
    WebGL2RenderingContext.prototype.getParameter = function(param) {
      if (param === 37445) return '${pick(WEBGL_VENDORS)}';
      if (param === 37446) return '${pick(WEBGL_RENDERERS)}';
      return getParameter2.call(this, param);
    };
  }`,

  // 10. Fake connection info
  `Object.defineProperty(navigator, 'connection', {
    get: () => ({ effectiveType: '4g', rtt: 50, downlink: 10, saveData: false })
  });`,

  // 11. Fake battery API
  `navigator.getBattery = () => Promise.resolve({ charging: true, chargingTime: 0, dischargingTime: Infinity, level: 0.97 });`,

  // 12. Hide automation flags in window
  `delete window.__playwright; delete window.__pw_manual; delete window.__PW_inspect;`,
];

/**
 * Human-like random delay
 */
function humanDelay(minMs = 400, maxMs = 1200) {
  const base = Math.random() * (maxMs - minMs) + minMs;
  // Occasionally add extra "thinking" pause (10% chance)
  const extra = Math.random() < 0.1 ? Math.random() * 2000 : 0;
  return new Promise(r => setTimeout(r, Math.floor(base + extra)));
}

/**
 * Human-like typing with variable speed
 */
async function humanType(element, text, opts = {}) {
  const { minDelay = 30, maxDelay = 120 } = opts;
  await element.click().catch(() => {});
  for (const char of text) {
    await element.type(char, { delay: 0 });
    const d = Math.random() * (maxDelay - minDelay) + minDelay;
    // Occasional pause between words
    const pause = char === ' ' ? Math.random() * 200 : 0;
    await new Promise(r => setTimeout(r, d + pause));
  }
}

/**
 * Human-like mouse movement to element before clicking
 */
async function humanClick(page, element) {
  if (!element) return false;
  try {
    await element.scrollIntoViewIfNeeded().catch(() => {});
    const box = await element.boundingBox();
    if (!box) { await element.click({ force: true }).catch(() => {}); return true; }
    // Move to random point within element (not dead center)
    const x = box.x + box.width * (0.3 + Math.random() * 0.4);
    const y = box.y + box.height * (0.3 + Math.random() * 0.4);
    // Slow mouse movement
    await page.mouse.move(x, y, { steps: Math.floor(Math.random() * 10) + 5 });
    await new Promise(r => setTimeout(r, Math.random() * 150 + 50));
    await page.mouse.click(x, y);
    return true;
  } catch {
    try { await element.click({ force: true }); return true; } catch { return false; }
  }
}

/**
 * Random scroll to simulate human browsing
 */
async function humanScroll(page) {
  const scrollAmount = Math.floor(Math.random() * 400) + 100;
  await page.mouse.wheel(0, scrollAmount);
  await humanDelay(200, 600);
}

/**
 * Launch a stealth browser instance
 * @param {Object} opts - { headless, proxy, userDataDir }
 * @returns {{ browser, context, page }}
 */
async function launchStealthBrowser(opts = {}) {
  const headless = opts.headless ?? (process.env.HEADLESS !== 'false');
  const ua = opts.userAgent || pick(USER_AGENTS);
  const vp = opts.viewport || pick(VIEWPORTS);

  const launchArgs = [
    '--no-sandbox',
    '--disable-blink-features=AutomationControlled',
    '--disable-features=IsolateOrigins,site-per-process',
    '--disable-dev-shm-usage',
    '--disable-accelerated-2d-canvas',
    '--disable-gpu-sandbox',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--disable-extensions',
    '--disable-sync',
    '--metrics-recording-only',
    '--no-zygote',
    '--disable-infobars',
    '--window-size=' + vp.width + ',' + vp.height,
    '--disable-web-security',
    '--allow-running-insecure-content',
  ];

  if (opts.proxy) {
    launchArgs.push(`--proxy-server=${opts.proxy}`);
  }

  const launchOpts = {
    headless,
    args: launchArgs,
    ignoreDefaultArgs: ['--enable-automation'],
  };

  // Prefer system Chrome if available (much better at evading detection)
  if (opts.channel) {
    launchOpts.channel = opts.channel; // 'chrome', 'msedge', etc.
  }

  const browser = await chromium.launch(launchOpts);

  const context = await browser.newContext({
    userAgent: ua,
    viewport: vp,
    locale: opts.locale || 'en-US',
    timezoneId: 'Asia/Kolkata',
    geolocation: { latitude: 17.385, longitude: 78.4867 }, // Hyderabad
    permissions: ['geolocation'],
    extraHTTPHeaders: {
      'Accept-Language': 'en-US,en;q=0.9',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
      'Accept-Encoding': 'gzip, deflate, br',
      'Sec-CH-UA': '"Chromium";v="131", "Not_A Brand";v="24"',
      'Sec-CH-UA-Mobile': '?0',
      'Sec-CH-UA-Platform': '"Windows"',
      'Sec-Fetch-Dest': 'document',
      'Sec-Fetch-Mode': 'navigate',
      'Sec-Fetch-Site': 'none',
      'Sec-Fetch-User': '?1',
      'Upgrade-Insecure-Requests': '1',
    },
    bypassCSP: true,
    javaScriptEnabled: true,
    ignoreHTTPSErrors: true,
  });

  // Inject stealth scripts into every page/frame
  await context.addInitScript(STEALTH_SCRIPTS.join('\n'));

  // Block known bot-detection scripts to reduce fingerprinting
  await context.route('**/*', (route) => {
    const url = route.request().url();
    // Block common bot detection services
    if (/datadome|perimeterx|distil|kasada|arkose|funcaptcha|imperva|shape\.com|device.*fingerprint/i.test(url)) {
      return route.abort().catch(() => route.continue().catch(() => {}));
    }
    // Block heavy tracking that slows down and fingerprints
    if (/google-analytics|googletagmanager|hotjar|fullstory|mouseflow|clarity\.ms/i.test(url)) {
      return route.abort().catch(() => route.continue().catch(() => {}));
    }
    return route.continue().catch(() => {});
  });

  const page = await context.newPage();

  return { browser, context, page };
}

/**
 * Create a new page in existing context with stealth
 */
async function newStealthPage(context) {
  const page = await context.newPage();
  return page;
}

/**
 * Smart page navigation — waits for page to be truly ready, not just a timeout.
 * Works on slow connections by dynamically checking DOM stability.
 * @param {Page} page - Playwright page
 * @param {string} url - URL to navigate to
 * @param {Object} opts - { maxWait: 60000, checkInterval: 300, stableCount: 3 }
 */
async function smartGoto(page, url, opts = {}) {
  const maxWait = opts.maxWait || 60000;
  const checkInterval = opts.checkInterval || 300;
  const stableCount = opts.stableCount || 3;

  // First, try navigation with domcontentloaded (fast, reliable)
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: maxWait }).catch(() => {});

  // Then wait for the page to become stable (no more DOM mutations)
  await waitForPageStable(page, { maxWait: Math.min(maxWait, 15000), checkInterval, stableCount });

  // Check for device verification / Cloudflare challenge pages and wait through them
  await waitThroughVerification(page, { maxWait: Math.min(maxWait, 20000) });
}

/**
 * Detect and wait through Cloudflare / device verification pages.
 * These auto-resolve after a few seconds — we just need to wait.
 */
async function waitThroughVerification(page, opts = {}) {
  const maxWait = opts.maxWait || 20000;
  const start = Date.now();

  while (Date.now() - start < maxWait) {
    try {
      const isChallenge = await page.evaluate(() => {
        const text = (document.body?.innerText || '').toLowerCase();
        const title = (document.title || '').toLowerCase();
        // Cloudflare / device verification patterns
        return /verifying (the |your )?device|just a moment|checking your browser|attention required|please wait/i.test(text)
          || /cloudflare|challenge|ray id/i.test(text)
          || /please wait|security check/i.test(title);
      }).catch(() => false);

      if (!isChallenge) return; // Page is real content now

      // Still on verification page — wait and check for Turnstile iframe
      const turnstile = await page.$('iframe[src*="challenges.cloudflare.com"], iframe[src*="turnstile"], [class*="cf-turnstile"]').catch(() => null);
      if (turnstile) {
        // Turnstile typically auto-solves. If it has a checkbox, click it.
        try {
          const frame = await turnstile.contentFrame().catch(() => null);
          if (frame) {
            const checkbox = await frame.$('input[type="checkbox"], [role="checkbox"]').catch(() => null);
            if (checkbox) await checkbox.click().catch(() => {});
          }
        } catch {}
      }
    } catch {}

    await new Promise(r => setTimeout(r, 1000));
  }
}

/**
 * Wait for page to be truly stable — DOM stopped changing, network idle, key elements visible.
 * No hardcoded timeouts. Dynamically adapts to connection speed.
 * @param {Page} page
 * @param {Object} opts - { maxWait, checkInterval, stableCount }
 */
async function waitForPageStable(page, opts = {}) {
  const maxWait = opts.maxWait || 15000;
  const checkInterval = opts.checkInterval || 300;
  const stableThreshold = opts.stableCount || 3;
  const start = Date.now();
  let lastHash = '';
  let stableRuns = 0;

  while (Date.now() - start < maxWait) {
    try {
      const hash = await page.evaluate(() => {
        // Hash: body text length + number of interactive elements + mutation check
        const body = document.body;
        if (!body) return '0|0|loading';
        const textLen = (body.innerText || '').length;
        const interactiveCount = document.querySelectorAll('input, select, textarea, button, a[href], [role="button"]').length;
        const readyState = document.readyState;
        // Check for loading spinners/skeletons
        const hasSpinner = !!document.querySelector('.loading, .spinner, [class*="skeleton"], [class*="loading"], [class*="Spinner"], [aria-busy="true"]');
        return `${textLen}|${interactiveCount}|${readyState}|${hasSpinner}`;
      }).catch(() => 'error');

      if (hash === lastHash && !hash.includes('loading') && !hash.endsWith('|true')) {
        stableRuns++;
        if (stableRuns >= stableThreshold) return; // Page is stable
      } else {
        stableRuns = 0;
      }
      lastHash = hash;
    } catch {
      // Page might be navigating, reset stability counter
      stableRuns = 0;
    }

    await new Promise(r => setTimeout(r, checkInterval));
  }
}

/**
 * Wait for a specific condition to become true, with dynamic polling.
 * Replaces waitForTimeout in all cases where we're waiting for something specific.
 * @param {Page} page
 * @param {Function} conditionFn - async function that returns truthy when done
 * @param {Object} opts - { maxWait, checkInterval, description }
 */
async function waitForCondition(page, conditionFn, opts = {}) {
  const maxWait = opts.maxWait || 10000;
  const checkInterval = opts.checkInterval || 200;
  const start = Date.now();

  while (Date.now() - start < maxWait) {
    try {
      const result = await conditionFn();
      if (result) return result;
    } catch {}
    await new Promise(r => setTimeout(r, checkInterval));
  }
  return null; // condition never met
}

/**
 * Smart element wait — finds element with retry, handles dynamic pages.
 * Better than page.waitForSelector because it handles stale elements and re-renders.
 * @param {Page} page
 * @param {string|string[]} selectors - CSS selector(s) to find
 * @param {Object} opts - { maxWait, visible }
 */
async function smartWaitForElement(page, selectors, opts = {}) {
  const selectorList = Array.isArray(selectors) ? selectors : [selectors];
  const maxWait = opts.maxWait || 10000;
  const visible = opts.visible !== false;

  return await waitForCondition(page, async () => {
    for (const sel of selectorList) {
      try {
        const el = await page.$(sel);
        if (!el) continue;
        if (visible && !await el.isVisible().catch(() => false)) continue;
        return el;
      } catch {}
    }
    return null;
  }, { maxWait, checkInterval: 250 });
}

module.exports = {
  launchStealthBrowser,
  newStealthPage,
  humanDelay,
  humanType,
  humanClick,
  humanScroll,
  smartGoto,
  waitForPageStable,
  waitForCondition,
  smartWaitForElement,
  USER_AGENTS,
  VIEWPORTS,
  pick,
};
