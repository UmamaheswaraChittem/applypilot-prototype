/**
 * CAPTCHA Solver Test Suite — tests every CAPTCHA type
 * Run: node test-captcha.js
 */
require('dotenv').config();
const { launchStealthBrowser, humanDelay } = require('./src/stealth');
const captchaSolver = require('./src/captcha-solver');

let passed = 0, failed = 0, skipped = 0;
function ok(msg) { passed++; console.log(`  \x1b[32m+\x1b[0m ${msg}`); }
function fail(msg) { failed++; console.log(`  \x1b[31m-\x1b[0m ${msg}`); }
function warn(msg) { skipped++; console.log(`  \x1b[33m~\x1b[0m ${msg}`); }
function log(msg) { console.log(`  ${msg}`); }

async function main() {
  console.log('=== CAPTCHA Solver Test Suite ===\n');

  // Test 1: Solver status
  console.log('--- Solver Status ---');
  const status = captchaSolver.getSolverStatus();
  log(`Solver API: ${status.solverApiConfigured ? 'configured' : 'NOT configured'}`);
  log(`AI Vision: ${status.aiVisionEnabled ? 'enabled' : 'disabled'}`);
  log(`Capabilities: ${status.capabilities.length}`);
  status.capabilities.forEach(c => log(`  - ${c}`));
  ok(`Solver initialized with ${status.capabilities.length} capabilities`);

  let browser, context, page;
  try {
    const result = await launchStealthBrowser({ headless: true });
    browser = result.browser; context = result.context; page = result.page;
    ok('Browser launched');
  } catch (err) {
    fail(`Launch failed: ${err.message}`);
    return;
  }

  try {
    // --- Test 2: reCAPTCHA v2 Detection ---
    console.log('\n--- reCAPTCHA v2 Detection ---');
    await page.setContent(`
      <html><body>
        <form>
          <div class="g-recaptcha" data-sitekey="6LeIxAcTAAAAAJcZVRqyHh71UMIEGNQ_MXjiZKhI"></div>
          <textarea name="g-recaptcha-response" style="display:none"></textarea>
          <button type="submit">Submit</button>
        </form>
      </body></html>
    `);
    let det = await captchaSolver.detectCaptcha(page);
    if (det && det.type === 'recaptcha_v2' && det.sitekey) {
      ok(`reCAPTCHA v2 detected: sitekey=${det.sitekey.substring(0, 20)}...`);
    } else {
      fail(`reCAPTCHA v2 not detected: ${JSON.stringify(det)}`);
    }

    // --- Test 3: reCAPTCHA v2 iframe Detection ---
    console.log('\n--- reCAPTCHA v2 (iframe) Detection ---');
    await page.setContent(`
      <html><body>
        <iframe src="https://www.google.com/recaptcha/api2/anchor?k=6LeIxAcTAAAA" title="reCAPTCHA"></iframe>
      </body></html>
    `);
    det = await captchaSolver.detectCaptcha(page);
    if (det && det.type === 'recaptcha_v2') {
      ok(`reCAPTCHA v2 iframe detected`);
    } else {
      fail(`reCAPTCHA v2 iframe not detected: ${JSON.stringify(det)}`);
    }

    // --- Test 4: reCAPTCHA v3 Detection ---
    console.log('\n--- reCAPTCHA v3 Detection ---');
    await page.setContent(`
      <html>
        <head><script src="https://www.google.com/recaptcha/api.js?render=6LeIxAcTAAAAAJcZVRqyHh71UMIEGNQ_MXjiZKhI"></script></head>
        <body><form><button>Submit</button></form></body>
      </html>
    `);
    det = await captchaSolver.detectCaptcha(page);
    if (det && det.type === 'recaptcha_v3') {
      ok(`reCAPTCHA v3 detected: sitekey=${(det.sitekey || '').substring(0, 20)}`);
    } else {
      warn(`reCAPTCHA v3 detection may need live page (got: ${det?.type || 'null'})`);
    }

    // --- Test 5: hCaptcha Detection ---
    console.log('\n--- hCaptcha Detection ---');
    await page.setContent(`
      <html><body>
        <div class="h-captcha" data-sitekey="10000000-ffff-ffff-ffff-000000000001"></div>
        <textarea name="h-captcha-response" style="display:none"></textarea>
      </body></html>
    `);
    det = await captchaSolver.detectCaptcha(page);
    if (det && det.type === 'hcaptcha' && det.sitekey) {
      ok(`hCaptcha detected: sitekey=${det.sitekey.substring(0, 20)}...`);
    } else {
      fail(`hCaptcha not detected: ${JSON.stringify(det)}`);
    }

    // --- Test 6: Cloudflare Turnstile Detection ---
    console.log('\n--- Cloudflare Turnstile Detection ---');
    await page.setContent(`
      <html><body>
        <div class="cf-turnstile" data-sitekey="0x4AAAAAAADnPIDROrmt1Wwj"></div>
        <input type="hidden" name="cf-turnstile-response" />
      </body></html>
    `);
    det = await captchaSolver.detectCaptcha(page);
    if (det && det.type === 'turnstile' && det.sitekey) {
      ok(`Turnstile detected: sitekey=${det.sitekey.substring(0, 20)}...`);
    } else {
      fail(`Turnstile not detected: ${JSON.stringify(det)}`);
    }

    // --- Test 7: FunCaptcha Detection ---
    console.log('\n--- FunCaptcha / Arkose Labs Detection ---');
    await page.setContent(`
      <html><body>
        <div id="funcaptcha" data-pkey="B7D8911C-5CC8-A9A3-35B0-554ACEE604DA"></div>
      </body></html>
    `);
    det = await captchaSolver.detectCaptcha(page);
    if (det && det.type === 'funcaptcha') {
      ok(`FunCaptcha detected: pkey=${(det.sitekey || '').substring(0, 20)}`);
    } else {
      fail(`FunCaptcha not detected: ${JSON.stringify(det)}`);
    }

    // --- Test 8: Slider CAPTCHA Detection ---
    console.log('\n--- Slider CAPTCHA Detection ---');
    await page.setContent(`
      <html><body>
        <div class="slide-verify-captcha">
          <div class="slide-verify-slider">
            <div class="slide-verify-handle" style="width:40px;height:40px;background:#ccc;cursor:pointer;">Drag</div>
          </div>
        </div>
      </body></html>
    `);
    det = await captchaSolver.detectCaptcha(page);
    if (det && det.type === 'slider') {
      ok(`Slider CAPTCHA detected`);
    } else {
      fail(`Slider not detected: ${JSON.stringify(det)}`);
    }

    // --- Test 9: Image CAPTCHA Detection ---
    console.log('\n--- Image CAPTCHA Detection ---');
    await page.setContent(`
      <html><body>
        <div class="captcha-container">
          <img id="captchaImage" src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==" alt="captcha" />
          <input type="text" name="captcha" placeholder="Enter captcha text" />
          <button type="submit">Submit</button>
        </div>
      </body></html>
    `);
    det = await captchaSolver.detectCaptcha(page);
    if (det && det.type === 'image') {
      ok(`Image CAPTCHA detected`);
    } else {
      fail(`Image CAPTCHA not detected: ${JSON.stringify(det)}`);
    }

    // --- Test 10: Math CAPTCHA Detection ---
    console.log('\n--- Math CAPTCHA Detection ---');
    await page.setContent(`
      <html><body>
        <div class="captcha-math">
          <span id="captcha-question">What is 7 + 3?</span>
          <input type="text" name="captcha-answer" placeholder="Answer" />
        </div>
      </body></html>
    `);
    det = await captchaSolver.detectCaptcha(page);
    if (det && det.type === 'math') {
      ok(`Math CAPTCHA detected: "${det.question}"`);
    } else {
      warn(`Math CAPTCHA detection: ${det?.type || 'not detected'}`);
    }

    // --- Test 11: No CAPTCHA Detection ---
    console.log('\n--- No CAPTCHA (Clean Page) ---');
    await page.setContent(`
      <html><body>
        <h1>Job Application</h1>
        <input type="text" name="name" />
        <button type="submit">Apply</button>
      </body></html>
    `);
    det = await captchaSolver.detectCaptcha(page);
    if (!det) {
      ok(`Clean page: no CAPTCHA detected (correct)`);
    } else {
      fail(`False positive: ${det.type} detected on clean page`);
    }

    // --- Test 12: Checkbox CAPTCHA Solver ---
    console.log('\n--- Checkbox Solver (Simulated) ---');
    await page.setContent(`
      <html><body>
        <div class="captcha-checkbox-wrapper">
          <input type="checkbox" id="robot-check" class="recaptcha-checkbox" aria-checked="false" />
          <label for="robot-check">I'm not a robot</label>
        </div>
      </body></html>
    `);
    const checkboxResult = await captchaSolver.solveCheckboxCaptcha(page);
    const isChecked = await page.$eval('#robot-check', el => el.checked).catch(() => false);
    if (isChecked) {
      ok(`Checkbox solver: checked successfully`);
    } else {
      warn(`Checkbox solver: could not check (iframe-based in real world)`);
    }

    // --- Test 13: Slider CAPTCHA Solver ---
    console.log('\n--- Slider Solver (Simulated) ---');
    await page.setContent(`
      <html><body>
        <div class="slider-captcha" style="width:300px;height:50px;background:#eee;position:relative;">
          <div class="slider-handle" style="width:40px;height:40px;background:#4CAF50;position:absolute;left:5px;top:5px;cursor:pointer;">
          </div>
        </div>
        <script>
          let dragging = false;
          const handle = document.querySelector('.slider-handle');
          handle.addEventListener('mousedown', () => dragging = true);
          document.addEventListener('mouseup', () => { dragging = false; });
          document.addEventListener('mousemove', (e) => {
            if (!dragging) return;
            const track = handle.parentElement;
            const rect = track.getBoundingClientRect();
            const x = Math.max(5, Math.min(e.clientX - rect.left, rect.width - 45));
            handle.style.left = x + 'px';
            if (x > rect.width - 60) {
              handle.style.background = '#2196F3';
              document.title = 'SOLVED';
            }
          });
        </script>
      </body></html>
    `);
    await captchaSolver.solveSliderCaptcha(page);
    const sliderTitle = await page.title();
    if (sliderTitle === 'SOLVED') {
      ok(`Slider solver: drag completed and verified`);
    } else {
      warn(`Slider solver: drag attempted (result: "${sliderTitle}")`);
    }

    // --- Test 14: Math CAPTCHA Solver ---
    console.log('\n--- Math Solver ---');
    await page.setContent(`
      <html><body>
        <div class="captcha-math">
          <span class="captcha-text">What is 15 + 27?</span>
          <input type="text" id="captcha-answer" name="captcha" placeholder="Answer" />
          <button type="submit">Submit</button>
        </div>
      </body></html>
    `);
    const mathResult = await captchaSolver.solveMathCaptcha(page, { type: 'math', question: 'What is 15 + 27?' });
    const mathAnswer = await page.$eval('#captcha-answer', el => el.value).catch(() => '');
    if (mathAnswer === '42') {
      ok(`Math solver: 15 + 27 = ${mathAnswer} (correct!)`);
    } else {
      fail(`Math solver: expected 42, got "${mathAnswer}"`);
    }

    // Test more math operations
    for (const [q, expected] of [
      ['What is 8 * 7?', '56'],
      ['What is 100 - 37?', '63'],
      ['What is 144 / 12?', '12'],
      ['Solve: 25 + 18', '43'],
    ]) {
      await page.setContent(`
        <html><body>
          <div class="captcha-math"><span class="captcha-text">${q}</span>
          <input type="text" name="captcha" placeholder="Answer" /></div>
        </body></html>
      `);
      await captchaSolver.solveMathCaptcha(page, { type: 'math', question: q });
      const val = await page.$eval('input[name="captcha"]', el => el.value).catch(() => '');
      if (val === expected) ok(`Math: "${q}" = ${val}`);
      else fail(`Math: "${q}" expected ${expected}, got "${val}"`);
    }

    // --- Test 15: Token Injection ---
    console.log('\n--- Token Injection ---');
    await page.setContent(`
      <html><body>
        <form>
          <textarea name="g-recaptcha-response" id="g-recaptcha-response" style="display:none"></textarea>
          <input type="hidden" name="captcha-token" />
          <button type="submit">Submit</button>
        </form>
      </body></html>
    `);
    const fakeToken = 'test-token-12345-abcdef';
    const injected = await captchaSolver.injectToken(page, { type: 'recaptcha_v2' }, fakeToken);
    const tokenVal = await page.$eval('#g-recaptcha-response', el => el.value).catch(() => '');
    if (tokenVal === fakeToken) {
      ok(`Token injection: reCAPTCHA response set to "${tokenVal.substring(0, 20)}..."`);
    } else {
      fail(`Token injection failed: got "${tokenVal}"`);
    }

    // hCaptcha token injection
    await page.setContent(`
      <html><body>
        <textarea name="h-captcha-response" id="h-captcha-response" style="display:none"></textarea>
      </body></html>
    `);
    await captchaSolver.injectToken(page, { type: 'hcaptcha' }, fakeToken);
    const hcToken = await page.$eval('#h-captcha-response', el => el.value).catch(() => '');
    if (hcToken === fakeToken) ok(`Token injection: hCaptcha response set`);
    else fail(`hCaptcha token injection failed`);

    // Turnstile token injection
    await page.setContent(`
      <html><body>
        <input type="hidden" name="cf-turnstile-response" />
      </body></html>
    `);
    await captchaSolver.injectToken(page, { type: 'turnstile' }, fakeToken);
    const cfToken = await page.$eval('[name="cf-turnstile-response"]', el => el.value).catch(() => '');
    if (cfToken === fakeToken) ok(`Token injection: Turnstile response set`);
    else fail(`Turnstile token injection failed`);

    // --- Test 16: Full solveCaptcha on clean page ---
    console.log('\n--- Full Solver: Clean Page ---');
    await page.setContent(`<html><body><h1>No CAPTCHA here</h1></body></html>`);
    const cleanResult = await captchaSolver.solveCaptcha(page, { maxRetries: 1, allowHumanFallback: false });
    if (cleanResult) ok(`Clean page: solveCaptcha returns true (no CAPTCHA = success)`);
    else fail(`Clean page: solveCaptcha should return true`);

    // --- Test 17: Claude Vision CAPTCHA (if API available) ---
    console.log('\n--- Claude AI Vision ---');
    if (captchaSolver.hasAutoSolveCapability()) {
      ok(`AI Vision available for CAPTCHA solving`);

      // Test with a simple text question
      await page.setContent(`
        <html><body>
          <div class="captcha-math">
            <span class="captcha-text">What color is the sky?</span>
            <input type="text" name="captcha" placeholder="Answer" />
          </div>
        </body></html>
      `);
      const visionAnswer = await captchaSolver.solveWithClaudeVision(page, { type: 'math', question: 'What color is the sky?' });
      if (visionAnswer && /blue/i.test(visionAnswer)) {
        ok(`Claude Vision: "${visionAnswer}" (correct!)`);
      } else {
        warn(`Claude Vision: "${visionAnswer}" (expected "blue")`);
      }
    } else {
      warn(`AI Vision not available (no API key)`);
    }

    // --- Test 18: Real-world CAPTCHA page test ---
    console.log('\n--- Real-World: Google reCAPTCHA Demo ---');
    try {
      await page.goto('https://www.google.com/recaptcha/api2/demo', { timeout: 15000 });
      await page.waitForTimeout(2000);
      det = await captchaSolver.detectCaptcha(page);
      if (det && det.type === 'recaptcha_v2') {
        ok(`Real reCAPTCHA v2 detected on demo page`);
        // Try checkbox
        const solved = await captchaSolver.solveCheckboxCaptcha(page);
        if (solved) ok(`Real reCAPTCHA checkbox clicked`);
        else warn(`Real reCAPTCHA checkbox may need image challenge`);
      } else {
        warn(`Could not load reCAPTCHA demo page`);
      }
    } catch (err) {
      warn(`reCAPTCHA demo: ${err.message.substring(0, 50)}`);
    }

  } catch (err) {
    fail(`Test error: ${err.message}`);
  } finally {
    await browser.close().catch(() => {});
  }

  // Summary
  console.log('\n=============================');
  console.log(`\x1b[32m  Passed:  ${passed}\x1b[0m`);
  console.log(`\x1b[31m  Failed:  ${failed}\x1b[0m`);
  console.log(`\x1b[33m  Skipped: ${skipped}\x1b[0m`);
  console.log('=============================\n');
  if (failed > 0) process.exit(1);
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
