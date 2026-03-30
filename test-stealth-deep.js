/**
 * Deep Stealth Audit — Tests our stealth module against real bot detection pages
 * and checks for every known fingerprint leak.
 * Think: 100,000 security testers trying to catch us.
 */
require('dotenv').config();
const { launchStealthBrowser, humanDelay, smartGoto, waitForPageStable } = require('./src/stealth');

let passed = 0, failed = 0, warnings = 0;
const BUGS = [];

function ok(msg) { console.log(`  \x1b[32m+\x1b[0m ${msg}`); passed++; }
function fail(msg) { console.log(`  \x1b[31m✗\x1b[0m ${msg}`); failed++; BUGS.push(msg); }
function warn(msg) { console.log(`  \x1b[33m~\x1b[0m ${msg}`); warnings++; }

(async () => {
  console.log('=== Deep Stealth Audit ===\n');
  const { browser, context, page } = await launchStealthBrowser({ headless: true });

  // ─── 1. Navigator Properties ────────────────────────────────────────────────
  console.log('--- Navigator Properties ---');

  const navChecks = await page.evaluate(() => {
    const results = {};

    // webdriver — MUST be false (not undefined)
    results.webdriver = navigator.webdriver;
    results.webdriverType = typeof navigator.webdriver;

    // webdriver on prototype
    results.webdriverOnProto = 'webdriver' in Object.getPrototypeOf(navigator);

    // plugins
    results.pluginsLength = navigator.plugins.length;
    results.pluginsType = Object.prototype.toString.call(navigator.plugins);
    results.pluginsInstanceOf = navigator.plugins instanceof PluginArray;
    results.plugin0Type = navigator.plugins[0] ? Object.prototype.toString.call(navigator.plugins[0]) : 'none';
    results.pluginItem = navigator.plugins.item ? typeof navigator.plugins.item : 'missing';
    results.pluginNamedItem = navigator.plugins.namedItem ? typeof navigator.plugins.namedItem : 'missing';

    // languages
    results.languages = navigator.languages;
    results.language = navigator.language;

    // chrome object
    results.hasChrome = typeof window.chrome !== 'undefined';
    results.chromeRuntime = typeof window.chrome?.runtime;
    results.chromeApp = typeof window.chrome?.app;
    results.chromeLoadTimes = typeof window.chrome?.loadTimes;

    // Permissions
    results.hasPermissions = !!navigator.permissions;

    // Connection
    results.connectionType = navigator.connection?.effectiveType;

    // Platform consistency
    results.platform = navigator.platform;
    results.userAgent = navigator.userAgent;
    results.vendor = navigator.vendor;

    // Automation flags
    results.playwright = typeof window.__playwright;
    results.pwManual = typeof window.__pw_manual;
    results.pwInspect = typeof window.__PW_inspect;
    results.selenium = typeof window._selenium;
    results.webdriverCalledVia = typeof window.callSelenium;
    results.driverEval = typeof window.__driver_evaluate;
    results.driverUnwrapped = typeof window.__driver_unwrapped;
    results.nightmareJs = typeof window.__nightmare;
    results.cdc = typeof window.cdc_adoQpoasnfa76pfcZLmcfl_Array;

    return results;
  });

  // webdriver checks
  if (navChecks.webdriver === false) ok('navigator.webdriver = false');
  else fail(`navigator.webdriver = ${navChecks.webdriver} (should be false)`);

  // plugins checks
  if (navChecks.pluginsLength >= 3) ok(`navigator.plugins.length = ${navChecks.pluginsLength}`);
  else fail(`navigator.plugins.length = ${navChecks.pluginsLength} (too few)`);

  if (navChecks.pluginsInstanceOf) ok('navigator.plugins instanceof PluginArray');
  else fail('navigator.plugins NOT instanceof PluginArray');

  if (navChecks.pluginItem === 'function') ok('plugins.item() exists');
  else fail(`plugins.item is ${navChecks.pluginItem}`);

  if (navChecks.pluginNamedItem === 'function') ok('plugins.namedItem() exists');
  else fail(`plugins.namedItem is ${navChecks.pluginNamedItem}`);

  // Chrome object
  if (navChecks.hasChrome) ok('window.chrome exists');
  else fail('window.chrome missing');

  if (navChecks.chromeRuntime === 'object') ok('chrome.runtime exists');
  else fail(`chrome.runtime: ${navChecks.chromeRuntime}`);

  if (navChecks.chromeApp === 'object') ok('chrome.app exists');
  else fail(`chrome.app: ${navChecks.chromeApp}`);

  // languages
  if (navChecks.languages && navChecks.languages.length >= 2) ok(`languages: ${navChecks.languages.join(', ')}`);
  else fail(`languages: ${JSON.stringify(navChecks.languages)}`);

  // Connection
  if (navChecks.connectionType === '4g') ok('navigator.connection.effectiveType = 4g');
  else warn(`connection type: ${navChecks.connectionType}`);

  // Automation flags
  const autoFlags = ['playwright', 'pwManual', 'pwInspect', 'selenium', 'webdriverCalledVia', 'driverEval', 'driverUnwrapped', 'nightmareJs', 'cdc'];
  let autoClean = true;
  for (const flag of autoFlags) {
    if (navChecks[flag] !== 'undefined') {
      fail(`Automation flag leaked: ${flag} = ${navChecks[flag]}`);
      autoClean = false;
    }
  }
  if (autoClean) ok('All automation flags clean (9 checked)');

  // Platform/UA consistency
  if (navChecks.vendor === 'Google Inc.') ok('navigator.vendor = "Google Inc."');
  else warn(`vendor: ${navChecks.vendor}`);

  if (navChecks.userAgent.includes('Chrome/')) ok('User agent contains Chrome');
  else fail('User agent missing Chrome identifier');

  // ─── 2. Function.toString Integrity ─────────────────────────────────────────
  console.log('\n--- Function.toString Integrity ---');

  const toStringChecks = await page.evaluate(() => {
    const results = {};

    // navigator.webdriver getter toString
    const desc = Object.getOwnPropertyDescriptor(navigator, 'webdriver');
    results.webdriverGetterToString = desc?.get?.toString?.() || 'no getter';

    // Check if Function.prototype.toString looks native
    results.toStringStr = Function.prototype.toString.toString();

    // Check various native functions
    results.evalToString = eval.toString();

    // Chrome-specific checks
    results.chromeLoadTimesToString = window.chrome?.loadTimes?.toString?.() || 'missing';

    return results;
  });

  if (toStringChecks.toStringStr.includes('[native code]')) ok('Function.prototype.toString looks native');
  else fail('Function.prototype.toString exposed as non-native');

  // ─── 3. WebGL Fingerprint ───────────────────────────────────────────────────
  console.log('\n--- WebGL Fingerprint ---');

  const webglChecks = await page.evaluate(() => {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl');
    if (!gl) return { error: 'no webgl' };

    const debugExt = gl.getExtension('WEBGL_debug_renderer_info');
    return {
      vendor: debugExt ? gl.getParameter(debugExt.UNMASKED_VENDOR_WEBGL) : 'no ext',
      renderer: debugExt ? gl.getParameter(debugExt.UNMASKED_RENDERER_WEBGL) : 'no ext',
    };
  });

  if (webglChecks.vendor && webglChecks.vendor !== 'Brian Paul' && !webglChecks.vendor.includes('Mesa')) {
    ok(`WebGL vendor: ${webglChecks.vendor}`);
  } else {
    fail(`WebGL vendor looks fake: ${webglChecks.vendor}`);
  }

  if (webglChecks.renderer && !webglChecks.renderer.includes('llvmpipe') && !webglChecks.renderer.includes('SwiftShader')) {
    ok(`WebGL renderer: ${webglChecks.renderer}`);
  } else {
    warn(`WebGL renderer may be detectable: ${webglChecks.renderer}`);
  }

  // ─── 4. Canvas Fingerprint Noise ────────────────────────────────────────────
  console.log('\n--- Canvas Fingerprint ---');

  const canvasTest = await page.evaluate(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 200; canvas.height = 50;
    const ctx = canvas.getContext('2d');
    ctx.textBaseline = 'top';
    ctx.font = '14px Arial';
    ctx.fillStyle = '#f60';
    ctx.fillRect(125, 1, 62, 20);
    ctx.fillStyle = '#069';
    ctx.fillText('BrowserLeaks', 2, 15);

    // Get hash twice — should differ if noise is applied
    const data1 = canvas.toDataURL();
    const data2 = canvas.toDataURL();

    return { same: data1 === data2, len: data1.length };
  });

  // Canvas noise means consecutive reads might differ (or at minimum the data is non-empty)
  if (canvasTest.len > 100) ok(`Canvas fingerprint generated (${canvasTest.len} chars)`);
  else fail('Canvas fingerprint empty');

  // ─── 5. HTTP Headers Check ──────────────────────────────────────────────────
  console.log('\n--- HTTP Headers ---');

  // Navigate to httpbin to check our headers
  await smartGoto(page, 'https://httpbin.org/headers', { maxWait: 15000 });
  await waitForPageStable(page);

  const headersText = await page.evaluate(() => document.body.innerText).catch(() => '');
  let headersParsed = {};
  try {
    headersParsed = JSON.parse(headersText)?.headers || {};
  } catch {}

  if (headersParsed['User-Agent'] && headersParsed['User-Agent'].includes('Chrome/')) {
    ok(`UA header: ${headersParsed['User-Agent'].substring(0, 60)}...`);
  } else {
    warn('Could not verify UA header via httpbin');
  }

  if (headersParsed['Accept-Language'] && headersParsed['Accept-Language'].includes('en')) {
    ok(`Accept-Language: ${headersParsed['Accept-Language']}`);
  } else {
    warn('Accept-Language header not set');
  }

  if (headersParsed['Sec-Ch-Ua'] || headersParsed['sec-ch-ua']) {
    ok(`Sec-CH-UA header present`);
  } else {
    warn('Sec-CH-UA header missing');
  }

  // ─── 6. Real Bot Detection Page: bot.sannysoft.com ─────────────────────────
  console.log('\n--- Bot Detection: sannysoft.com ---');

  await smartGoto(page, 'https://bot.sannysoft.com/', { maxWait: 20000 });
  await waitForPageStable(page, { maxWait: 5000 });

  const sannyResults = await page.evaluate(() => {
    const rows = document.querySelectorAll('table tr');
    const results = {};
    rows.forEach(row => {
      const cells = row.querySelectorAll('td');
      if (cells.length >= 2) {
        const test = cells[0].innerText.trim();
        const result = cells[1].innerText.trim();
        const passed = cells[1].classList.contains('passed') ||
                       cells[1].style.backgroundColor === 'rgb(144, 238, 144)' ||
                       cells[1].style.backgroundColor === 'lightgreen' ||
                       result.toLowerCase() === 'missing (passed!)' ||
                       result.toLowerCase().includes('passed');
        const failed = cells[1].classList.contains('failed') ||
                       cells[1].style.backgroundColor === 'red' ||
                       cells[1].style.backgroundColor === 'rgb(255, 0, 0)';
        results[test] = { result: result.substring(0, 80), passed, failed };
      }
    });
    return results;
  }).catch(() => ({}));

  const sannyKeys = Object.keys(sannyResults);
  if (sannyKeys.length === 0) {
    warn('Could not parse sannysoft results');
  } else {
    let sannyPassed = 0, sannyFailed = 0;
    for (const [test, data] of Object.entries(sannyResults)) {
      if (data.failed) {
        fail(`sannysoft FAILED: ${test} = ${data.result}`);
        sannyFailed++;
      } else {
        sannyPassed++;
      }
    }
    if (sannyFailed === 0) ok(`sannysoft: ALL ${sannyPassed} tests passed`);
    else warn(`sannysoft: ${sannyPassed} passed, ${sannyFailed} failed`);
  }

  // ─── 7. Headless Detection Checks ──────────────────────────────────────────
  console.log('\n--- Headless Detection ---');

  const headlessChecks = await page.evaluate(() => {
    const results = {};

    // Screen dimensions (headless often has 0x0 or 800x600)
    results.screenWidth = screen.width;
    results.screenHeight = screen.height;
    results.outerWidth = window.outerWidth;
    results.outerHeight = window.outerHeight;
    results.innerWidth = window.innerWidth;
    results.innerHeight = window.innerHeight;

    // Color depth
    results.colorDepth = screen.colorDepth;

    // devicePixelRatio
    results.devicePixelRatio = window.devicePixelRatio;

    // navigator.hardwareConcurrency (headless may have 0 or 1)
    results.hardwareConcurrency = navigator.hardwareConcurrency;

    // navigator.deviceMemory
    results.deviceMemory = navigator.deviceMemory;

    // Touch support (desktop Chrome shouldn't have it)
    results.maxTouchPoints = navigator.maxTouchPoints;

    // WebGL renderer might leak "SwiftShader" or "llvmpipe" in headless
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl');
    if (gl) {
      const debugExt = gl.getExtension('WEBGL_debug_renderer_info');
      results.glRenderer = debugExt ? gl.getParameter(debugExt.UNMASKED_RENDERER_WEBGL) : 'no ext';
    }

    // Notification permission (headless often denies)
    results.notificationPermission = typeof Notification !== 'undefined' ? Notification.permission : 'unavailable';

    // Speech synthesis voices (headless often has 0)
    results.speechVoices = window.speechSynthesis ? window.speechSynthesis.getVoices().length : -1;

    return results;
  });

  if (headlessChecks.screenWidth > 0 && headlessChecks.screenHeight > 0) {
    ok(`Screen: ${headlessChecks.screenWidth}x${headlessChecks.screenHeight}`);
  } else {
    fail(`Screen: ${headlessChecks.screenWidth}x${headlessChecks.screenHeight} (headless leak)`);
  }

  if (headlessChecks.colorDepth >= 24) ok(`Color depth: ${headlessChecks.colorDepth}`);
  else warn(`Color depth: ${headlessChecks.colorDepth} (low — may indicate headless)`);

  if (headlessChecks.hardwareConcurrency >= 2) ok(`Hardware concurrency: ${headlessChecks.hardwareConcurrency}`);
  else warn(`Hardware concurrency: ${headlessChecks.hardwareConcurrency} (low)`);

  if (headlessChecks.glRenderer && !headlessChecks.glRenderer.includes('SwiftShader') && !headlessChecks.glRenderer.includes('llvmpipe')) {
    ok(`WebGL renderer clean: ${headlessChecks.glRenderer.substring(0, 60)}`);
  } else {
    fail(`WebGL renderer leaks headless: ${headlessChecks.glRenderer}`);
  }

  // ─── 8. CDP Detection ──────────────────────────────────────────────────────
  console.log('\n--- CDP / DevTools Detection ---');

  const cdpChecks = await page.evaluate(() => {
    const results = {};

    // Runtime.enable detection
    results.runtimeEnable = typeof window.Runtime !== 'undefined';

    // Check for devtool-specific globals
    results.eruda = typeof window.eruda;
    results.firebug = typeof window.Firebug;

    // Detached iframe trick
    try {
      const iframe = document.createElement('iframe');
      document.body.appendChild(iframe);
      const iframeChrome = iframe.contentWindow.chrome;
      document.body.removeChild(iframe);
      results.iframeChrome = typeof iframeChrome;
    } catch {
      results.iframeChrome = 'error';
    }

    return results;
  });

  if (!cdpChecks.runtimeEnable) ok('No Runtime leak');
  else fail('window.Runtime detected (CDP leak)');

  if (cdpChecks.eruda === 'undefined' && cdpChecks.firebug === 'undefined') ok('No devtools globals leaked');
  else warn('Devtools globals detected');

  // ─── 9. Route Blocking Verification ────────────────────────────────────────
  console.log('\n--- Bot Detection Script Blocking ---');

  const blockTest = await page.evaluate(async () => {
    const urls = [
      'https://cdn.datadome.co/test.js',
      'https://www.google-analytics.com/analytics.js',
    ];
    const results = {};
    for (const url of urls) {
      try {
        const resp = await fetch(url, { mode: 'no-cors' }).catch(() => null);
        results[url] = resp ? 'loaded' : 'blocked';
      } catch {
        results[url] = 'blocked';
      }
    }
    return results;
  }).catch(() => ({}));

  for (const [url, status] of Object.entries(blockTest)) {
    const domain = new URL(url).hostname;
    if (status === 'blocked') ok(`Blocked: ${domain}`);
    else warn(`Not blocked: ${domain} (${status})`);
  }

  // ─── 10. Multiple Page Consistency ─────────────────────────────────────────
  console.log('\n--- Multi-Page Consistency ---');

  const page2 = await context.newPage();
  await smartGoto(page2, 'about:blank');

  const page2Checks = await page2.evaluate(() => ({
    webdriver: navigator.webdriver,
    plugins: navigator.plugins.length,
    chrome: typeof window.chrome,
    languages: navigator.languages,
  }));

  if (page2Checks.webdriver === false) ok('New page: webdriver = false');
  else fail(`New page: webdriver = ${page2Checks.webdriver}`);

  if (page2Checks.plugins >= 3) ok(`New page: plugins = ${page2Checks.plugins}`);
  else fail(`New page: plugins = ${page2Checks.plugins}`);

  if (page2Checks.chrome === 'object') ok('New page: chrome object present');
  else fail(`New page: chrome = ${page2Checks.chrome}`);

  await page2.close();

  // ─── 11. Timing Fingerprint ────────────────────────────────────────────────
  console.log('\n--- Timing & Performance ---');

  const timingChecks = await page.evaluate(() => {
    const results = {};

    // Performance.now resolution (headless sometimes has coarser timing)
    const t1 = performance.now();
    for (let i = 0; i < 1000; i++) {} // busy loop
    const t2 = performance.now();
    results.perfResolution = t2 - t1;

    // Date precision
    results.dateNow = Date.now();

    // Performance timing
    results.hasPerformanceTiming = !!performance.timing;
    results.hasPerformanceNavigation = !!performance.getEntriesByType;

    return results;
  });

  if (timingChecks.hasPerformanceTiming) ok('performance.timing available');
  else warn('performance.timing missing');

  // ─── Summary ───────────────────────────────────────────────────────────────
  await browser.close();

  console.log('\n=============================');
  console.log(`\x1b[32m  Passed:  ${passed}\x1b[0m`);
  console.log(`\x1b[31m  Failed:  ${failed}\x1b[0m`);
  console.log(`\x1b[33m  Warnings: ${warnings}\x1b[0m`);
  console.log('=============================');

  if (BUGS.length > 0) {
    console.log('\n🐛 BUGS TO FIX:');
    BUGS.forEach((b, i) => console.log(`  ${i + 1}. ${b}`));
  }
})();
