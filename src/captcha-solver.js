/**
 * Universal CAPTCHA Solver — handles every CAPTCHA type automatically
 *
 * Supported:
 *  - reCAPTCHA v2 (checkbox + image challenge)
 *  - reCAPTCHA v3 (invisible, score-based — handled by stealth)
 *  - hCaptcha
 *  - Cloudflare Turnstile
 *  - FunCaptcha / Arkose Labs
 *  - Slider / drag-to-verify CAPTCHAs
 *  - Text / math CAPTCHAs (OCR via Claude AI Vision)
 *  - Audio CAPTCHAs (fallback)
 *  - Simple "I'm not a robot" checkboxes
 *
 * Solving strategies (in priority order):
 *  1. Third-party solver API (2Captcha, CapSolver) — most reliable
 *  2. Claude AI Vision — for image/text CAPTCHAs
 *  3. Built-in heuristics — checkboxes, sliders, simple math
 *  4. Audio fallback — for reCAPTCHA/hCaptcha audio challenges
 *  5. Human fallback — pause and wait for user (last resort)
 */
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const Anthropic = require('@anthropic-ai/sdk');
const { humanDelay, humanClick } = require('./stealth');
const https = require('https');
const http = require('http');

// ─── Config ──────────────────────────────────────────────────────────────────

const SOLVER_API_KEY = process.env.CAPTCHA_API_KEY || process.env.TWOCAPTCHA_KEY || process.env.CAPSOLVER_KEY || '';
const SOLVER_SERVICE = process.env.CAPTCHA_SERVICE || 'auto'; // '2captcha', 'capsolver', 'auto'
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY || '';
const MAX_SOLVE_TIME = parseInt(process.env.CAPTCHA_TIMEOUT || '120000'); // 2 min max
const ENABLE_AI_VISION = process.env.CAPTCHA_AI_VISION !== 'false'; // default on

// ─── CAPTCHA Detection ──────────────────────────────────────────────────────

/**
 * Detect what type of CAPTCHA is on the page.
 * Returns { type, sitekey, pageUrl, iframe, element } or null
 */
async function detectCaptcha(page) {
  try {
    const result = await page.evaluate(() => {
      const info = { type: null, sitekey: null, pageUrl: window.location.href, action: null };

      // 1. reCAPTCHA v2 (visible checkbox or challenge)
      const recaptchaV2 = document.querySelector('.g-recaptcha, [data-sitekey][class*="recaptcha"]');
      if (recaptchaV2) {
        info.type = 'recaptcha_v2';
        info.sitekey = recaptchaV2.getAttribute('data-sitekey') || '';
        return info;
      }

      // reCAPTCHA v2 in iframe
      const recapIframe = document.querySelector('iframe[src*="recaptcha/api2"], iframe[src*="recaptcha/enterprise"], iframe[title*="reCAPTCHA"]');
      if (recapIframe) {
        const src = recapIframe.src || '';
        const keyMatch = src.match(/[?&]k=([^&]+)/);
        info.type = 'recaptcha_v2';
        info.sitekey = keyMatch ? keyMatch[1] : '';
        return info;
      }

      // 2. reCAPTCHA v3 (invisible)
      const recapV3Script = document.querySelector('script[src*="recaptcha/api.js?render="], script[src*="recaptcha/enterprise.js?render="]');
      if (recapV3Script) {
        const src = recapV3Script.src || '';
        const renderMatch = src.match(/render=([^&]+)/);
        info.type = 'recaptcha_v3';
        info.sitekey = renderMatch ? renderMatch[1] : '';
        // Try to find action from grecaptcha.execute calls
        const scripts = document.querySelectorAll('script');
        for (const s of scripts) {
          const actionMatch = (s.textContent || '').match(/grecaptcha\.execute\([^,]+,\s*\{action:\s*['"]([^'"]+)['"]\}/);
          if (actionMatch) { info.action = actionMatch[1]; break; }
        }
        return info;
      }

      // 3. hCaptcha (check BEFORE grecaptcha fallback to avoid false positives)
      const hcaptcha = document.querySelector('.h-captcha, [data-sitekey][class*="hcaptcha"], iframe[src*="hcaptcha.com"]');
      if (hcaptcha) {
        info.type = 'hcaptcha';
        info.sitekey = hcaptcha.getAttribute('data-sitekey') || '';
        if (!info.sitekey) {
          const hcIframe = document.querySelector('iframe[src*="hcaptcha.com"]');
          const hcSrc = hcIframe?.src || '';
          const hcKey = hcSrc.match(/sitekey=([^&]+)/);
          info.sitekey = hcKey ? hcKey[1] : '';
        }
        return info;
      }

      // 4. Cloudflare Turnstile
      const turnstile = document.querySelector('.cf-turnstile, [data-sitekey][class*="turnstile"], iframe[src*="challenges.cloudflare.com"]');
      if (turnstile) {
        info.type = 'turnstile';
        info.sitekey = turnstile.getAttribute('data-sitekey') || '';
        return info;
      }

      // 5. FunCaptcha / Arkose Labs
      const funcaptcha = document.querySelector('#funcaptcha, [data-pkey], iframe[src*="funcaptcha.com"], iframe[src*="arkoselabs.com"]');
      if (funcaptcha) {
        info.type = 'funcaptcha';
        info.sitekey = funcaptcha.getAttribute('data-pkey') || '';
        return info;
      }

      // 6. Slider CAPTCHA
      const slider = document.querySelector(
        '[class*="slider-captcha"], [class*="slide-verify"], [class*="geetest"], ' +
        '.captcha-slider, [class*="drag"][class*="verify"], [class*="slide"][class*="captcha"], ' +
        '[class*="puzzle"][class*="captcha"], [class*="jigsaw"]'
      );
      if (slider) {
        info.type = 'slider';
        return info;
      }

      // 7. Image CAPTCHA (simple text in image)
      const imgCaptcha = document.querySelector(
        'img[src*="captcha"], img[alt*="captcha" i], img[class*="captcha"], ' +
        'img[id*="captcha"], [class*="captcha"] img, #captchaImage, .captcha-image'
      );
      if (imgCaptcha) {
        info.type = 'image';
        info.imageUrl = imgCaptcha.src || '';
        return info;
      }

      // 8. Text/Math CAPTCHA
      const mathCaptcha = document.querySelector(
        '[class*="captcha"][class*="text"], [class*="captcha"][class*="math"], ' +
        '[id*="captcha-question"], .math-captcha'
      );
      if (mathCaptcha) {
        info.type = 'math';
        info.question = (mathCaptcha.innerText || '').trim();
        return info;
      }

      // 9. Generic "verify you are human" page
      const bodyText = (document.body.innerText || '').substring(0, 2000).toLowerCase();
      if (/verify you are human|prove you.*not.*robot|complete.*captcha|security check/i.test(bodyText)) {
        // Try to find any captcha-like element
        const generic = document.querySelector('[class*="captcha"], [id*="captcha"], [class*="challenge"]');
        if (generic) {
          info.type = 'generic';
          return info;
        }
      }

      // 10. Simple checkbox "I'm not a robot"
      const robotCheck = document.querySelector(
        'input[type="checkbox"][class*="captcha"], input[type="checkbox"][id*="captcha"], ' +
        '[class*="recaptcha-checkbox"], .rc-anchor-checkbox'
      );
      if (robotCheck) {
        info.type = 'checkbox';
        return info;
      }

      // 11. reCAPTCHA v3 via grecaptcha object (LAST — only if no other CAPTCHA found)
      // Careful: some stealth scripts or CDNs inject grecaptcha-like objects
      if (typeof window.grecaptcha !== 'undefined' && window.grecaptcha && typeof window.grecaptcha.execute === 'function') {
        const skEl = document.querySelector('[data-sitekey]');
        if (skEl) {
          info.type = 'recaptcha_v3';
          info.sitekey = skEl.getAttribute('data-sitekey') || '';
          return info;
        }
      }

      return null;
    });

    if (result) {
      console.log(`  [captcha] Detected: ${result.type}${result.sitekey ? ` (sitekey: ${result.sitekey.substring(0, 20)}...)` : ''}`);
    }
    return result;
  } catch (err) {
    console.log(`  [captcha] Detection error: ${err.message.substring(0, 50)}`);
    return null;
  }
}

// ─── Third-Party Solver APIs ────────────────────────────────────────────────

function httpPost(url, data) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const mod = urlObj.protocol === 'https:' ? https : http;
    const postData = typeof data === 'string' ? data : JSON.stringify(data);
    const options = {
      hostname: urlObj.hostname,
      port: urlObj.port,
      path: urlObj.pathname + urlObj.search,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(postData) },
    };
    const req = mod.request(options, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(body)); } catch { resolve(body); }
      });
    });
    req.on('error', reject);
    req.write(postData);
    req.end();
  });
}

function httpGet(url) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const mod = urlObj.protocol === 'https:' ? https : http;
    mod.get(url, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(body)); } catch { resolve(body); }
      });
    }).on('error', reject);
  });
}

/**
 * Solve via 2Captcha API
 */
async function solve2Captcha(captchaInfo) {
  const apiKey = SOLVER_API_KEY;
  if (!apiKey) return null;

  console.log(`  [captcha] Sending to 2Captcha (${captchaInfo.type})...`);

  let taskPayload;
  if (captchaInfo.type === 'recaptcha_v2') {
    taskPayload = {
      key: apiKey, method: 'userrecaptcha',
      googlekey: captchaInfo.sitekey, pageurl: captchaInfo.pageUrl, json: 1,
    };
  } else if (captchaInfo.type === 'recaptcha_v3') {
    taskPayload = {
      key: apiKey, method: 'userrecaptcha', version: 'v3',
      googlekey: captchaInfo.sitekey, pageurl: captchaInfo.pageUrl,
      action: captchaInfo.action || 'verify', min_score: 0.7, json: 1,
    };
  } else if (captchaInfo.type === 'hcaptcha') {
    taskPayload = {
      key: apiKey, method: 'hcaptcha',
      sitekey: captchaInfo.sitekey, pageurl: captchaInfo.pageUrl, json: 1,
    };
  } else if (captchaInfo.type === 'turnstile') {
    taskPayload = {
      key: apiKey, method: 'turnstile',
      sitekey: captchaInfo.sitekey, pageurl: captchaInfo.pageUrl, json: 1,
    };
  } else if (captchaInfo.type === 'funcaptcha') {
    taskPayload = {
      key: apiKey, method: 'funcaptcha',
      publickey: captchaInfo.sitekey, pageurl: captchaInfo.pageUrl, json: 1,
    };
  } else if (captchaInfo.type === 'image' && captchaInfo.imageUrl) {
    // For image captchas, send the image
    taskPayload = {
      key: apiKey, method: 'base64', json: 1,
      body: captchaInfo.imageBase64 || '',
    };
  } else {
    return null;
  }

  try {
    // Submit task
    const params = new URLSearchParams(taskPayload).toString();
    const submit = await httpGet(`https://2captcha.com/in.php?${params}`);
    if (!submit || submit.status !== 1) {
      console.log(`  [captcha] 2Captcha submit failed: ${JSON.stringify(submit).substring(0, 80)}`);
      return null;
    }

    const taskId = submit.request;
    console.log(`  [captcha] 2Captcha task: ${taskId}`);

    // Poll for result (max 120s)
    const deadline = Date.now() + MAX_SOLVE_TIME;
    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 5000));
      const result = await httpGet(`https://2captcha.com/res.php?key=${apiKey}&action=get&id=${taskId}&json=1`);
      if (result && result.status === 1) {
        console.log(`  [captcha] 2Captcha solved!`);
        return result.request; // The token
      }
      if (result && result.request !== 'CAPCHA_NOT_READY') {
        console.log(`  [captcha] 2Captcha error: ${result.request}`);
        return null;
      }
    }
    console.log(`  [captcha] 2Captcha timeout`);
    return null;
  } catch (err) {
    console.log(`  [captcha] 2Captcha error: ${err.message.substring(0, 50)}`);
    return null;
  }
}

/**
 * Solve via CapSolver API
 */
async function solveCapSolver(captchaInfo) {
  const apiKey = SOLVER_API_KEY;
  if (!apiKey) return null;

  console.log(`  [captcha] Sending to CapSolver (${captchaInfo.type})...`);

  let task;
  if (captchaInfo.type === 'recaptcha_v2') {
    task = {
      type: 'ReCaptchaV2TaskProxyLess',
      websiteURL: captchaInfo.pageUrl,
      websiteKey: captchaInfo.sitekey,
    };
  } else if (captchaInfo.type === 'recaptcha_v3') {
    task = {
      type: 'ReCaptchaV3TaskProxyLess',
      websiteURL: captchaInfo.pageUrl,
      websiteKey: captchaInfo.sitekey,
      pageAction: captchaInfo.action || 'verify',
      minScore: 0.7,
    };
  } else if (captchaInfo.type === 'hcaptcha') {
    task = {
      type: 'HCaptchaTaskProxyLess',
      websiteURL: captchaInfo.pageUrl,
      websiteKey: captchaInfo.sitekey,
    };
  } else if (captchaInfo.type === 'turnstile') {
    task = {
      type: 'AntiTurnstileTaskProxyLess',
      websiteURL: captchaInfo.pageUrl,
      websiteKey: captchaInfo.sitekey,
    };
  } else if (captchaInfo.type === 'funcaptcha') {
    task = {
      type: 'FunCaptchaTaskProxyLess',
      websiteURL: captchaInfo.pageUrl,
      websitePublicKey: captchaInfo.sitekey,
    };
  } else {
    return null;
  }

  try {
    const submit = await httpPost('https://api.capsolver.com/createTask', {
      appId: '9E0DE436-1B0D-4E83-B037-A70574EB83F1',
      clientKey: apiKey,
      task,
    });

    if (!submit || submit.errorId) {
      console.log(`  [captcha] CapSolver error: ${submit?.errorDescription || 'unknown'}`);
      return null;
    }

    const taskId = submit.taskId;
    console.log(`  [captcha] CapSolver task: ${taskId}`);

    const deadline = Date.now() + MAX_SOLVE_TIME;
    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 3000));
      const result = await httpPost('https://api.capsolver.com/getTaskResult', {
        clientKey: apiKey,
        taskId,
      });
      if (result && result.status === 'ready') {
        console.log(`  [captcha] CapSolver solved!`);
        return result.solution?.gRecaptchaResponse || result.solution?.token || result.solution?.text || null;
      }
      if (result && result.errorId) {
        console.log(`  [captcha] CapSolver error: ${result.errorDescription}`);
        return null;
      }
    }
    return null;
  } catch (err) {
    console.log(`  [captcha] CapSolver error: ${err.message.substring(0, 50)}`);
    return null;
  }
}

// ─── Claude AI Vision Solver ────────────────────────────────────────────────

/**
 * Solve image/text CAPTCHAs using Claude AI Vision
 */
async function solveWithClaudeVision(page, captchaInfo) {
  if (!ANTHROPIC_KEY || !ENABLE_AI_VISION) return null;

  console.log(`  [captcha] Using Claude AI Vision for ${captchaInfo.type}...`);

  try {
    let imageBase64 = null;
    let question = '';

    if (captchaInfo.type === 'image') {
      // Screenshot the captcha image element
      const imgEl = await page.$('img[src*="captcha"], img[alt*="captcha" i], img[class*="captcha"], #captchaImage, .captcha-image').catch(() => null);
      if (imgEl) {
        const imgBuffer = await imgEl.screenshot().catch(() => null);
        if (imgBuffer) imageBase64 = imgBuffer.toString('base64');
      }
    } else if (captchaInfo.type === 'math') {
      question = captchaInfo.question || '';
      // Also screenshot for visual context
      const captchaArea = await page.$('[class*="captcha"], [id*="captcha"]').catch(() => null);
      if (captchaArea) {
        const buf = await captchaArea.screenshot().catch(() => null);
        if (buf) imageBase64 = buf.toString('base64');
      }
    } else if (captchaInfo.type === 'generic' || captchaInfo.type === 'slider') {
      // Screenshot the entire captcha area
      const captchaArea = await page.$('[class*="captcha"], [id*="captcha"], [class*="challenge"], [class*="verify"]').catch(() => null);
      if (captchaArea) {
        const buf = await captchaArea.screenshot().catch(() => null);
        if (buf) imageBase64 = buf.toString('base64');
      }
    }

    if (!imageBase64 && !question) {
      // Fallback: screenshot the full page
      const buf = await page.screenshot({ fullPage: false }).catch(() => null);
      if (buf) imageBase64 = buf.toString('base64');
      else return null;
    }

    const client = new Anthropic({ apiKey: ANTHROPIC_KEY });
    const messages = [{
      role: 'user',
      content: [],
    }];

    if (imageBase64) {
      messages[0].content.push({
        type: 'image',
        source: { type: 'base64', media_type: 'image/png', data: imageBase64 },
      });
    }

    messages[0].content.push({
      type: 'text',
      text: question
        ? `This is a CAPTCHA challenge. The question is: "${question}". What is the answer? Return ONLY the answer text, nothing else.`
        : `This is a CAPTCHA image. Read the text/numbers shown in this CAPTCHA image and return ONLY the characters you see. No explanation, just the characters. If it's a math problem, return only the numeric answer. If it shows distorted text, return your best reading of the text.`,
    });

    const response = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 100,
      messages,
    });

    const answer = (response.content[0]?.text || '').trim();
    if (answer) {
      console.log(`  [captcha] Claude Vision answer: "${answer}"`);
      return answer;
    }
    return null;
  } catch (err) {
    console.log(`  [captcha] Claude Vision error: ${err.message.substring(0, 50)}`);
    return null;
  }
}

// ─── Built-in Heuristic Solvers ─────────────────────────────────────────────

/**
 * Solve simple checkbox CAPTCHAs ("I'm not a robot")
 */
async function solveCheckboxCaptcha(page) {
  console.log(`  [captcha] Attempting checkbox CAPTCHA...`);

  try {
    // Method 1: Click the reCAPTCHA checkbox inside iframe
    const recapFrame = await page.$('iframe[src*="recaptcha"], iframe[title*="reCAPTCHA"]').catch(() => null);
    if (recapFrame) {
      const frame = await recapFrame.contentFrame().catch(() => null);
      if (frame) {
        const checkbox = await frame.$('.recaptcha-checkbox-border, #recaptcha-anchor, [role="checkbox"]').catch(() => null);
        if (checkbox) {
          await humanDelay(500, 1500);
          await humanClick(page, checkbox).catch(() => checkbox.click());
          await humanDelay(1000, 3000);

          // Check if solved (no image challenge appeared)
          const checked = await frame.$('.recaptcha-checkbox-checked, [aria-checked="true"]').catch(() => null);
          if (checked) {
            console.log(`  [captcha] Checkbox solved!`);
            return true;
          }
          // Image challenge appeared — need more advanced solving
          console.log(`  [captcha] Checkbox clicked but image challenge appeared`);
          return false;
        }
      }
    }

    // Method 2: Direct checkbox click
    const checkbox = await page.$('[class*="recaptcha-checkbox"], .rc-anchor-checkbox, input[type="checkbox"][class*="captcha"]').catch(() => null);
    if (checkbox) {
      await humanDelay(300, 800);
      await checkbox.click();
      await humanDelay(1000, 2000);
      return true;
    }

    return false;
  } catch (err) {
    console.log(`  [captcha] Checkbox error: ${err.message.substring(0, 50)}`);
    return false;
  }
}

/**
 * Solve slider CAPTCHAs by dragging the slider
 */
async function solveSliderCaptcha(page) {
  console.log(`  [captcha] Attempting slider CAPTCHA...`);

  try {
    // Find the slider handle
    const sliderSelectors = [
      '[class*="slider"] [class*="handle"]', '[class*="slider"] [class*="btn"]',
      '[class*="slide"] [class*="handle"]', '[class*="drag"][class*="btn"]',
      '.geetest_slider_button', '.geetest_btn', '[class*="slider-button"]',
      '[class*="captcha"] [class*="slider"]', '[class*="puzzle"] [class*="slider"]',
      '[class*="verify"] [class*="drag"]', '[class*="slide-bar"] button',
      '[class*="slider"][draggable]', '[class*="drag-handle"]',
    ];

    let handle = null;
    for (const sel of sliderSelectors) {
      handle = await page.$(sel).catch(() => null);
      if (handle && await handle.isVisible().catch(() => false)) break;
      handle = null;
    }

    if (!handle) {
      console.log(`  [captcha] Slider handle not found`);
      return false;
    }

    const box = await handle.boundingBox();
    if (!box) return false;

    // Find the slider track to know how far to drag
    const trackSelectors = [
      '[class*="slider"][class*="track"]', '[class*="slider"][class*="bar"]',
      '[class*="slide-bar"]', '[class*="slider-bg"]', '[class*="geetest_slider"]',
      '[class*="captcha"][class*="slider"]',
    ];
    let trackWidth = 260; // default
    for (const sel of trackSelectors) {
      const track = await page.$(sel).catch(() => null);
      if (track) {
        const trackBox = await track.boundingBox().catch(() => null);
        if (trackBox) { trackWidth = trackBox.width - box.width; break; }
      }
    }

    // Human-like drag: start from handle center
    const startX = box.x + box.width / 2;
    const startY = box.y + box.height / 2;

    // Move to handle
    await page.mouse.move(startX, startY, { steps: 5 });
    await humanDelay(100, 300);
    await page.mouse.down();
    await humanDelay(50, 150);

    // Drag with human-like acceleration/deceleration + slight y wobble
    const totalSteps = 20 + Math.floor(Math.random() * 15);
    const targetX = startX + trackWidth * (0.85 + Math.random() * 0.1);

    for (let i = 1; i <= totalSteps; i++) {
      const progress = i / totalSteps;
      // Ease-in-out curve
      const ease = progress < 0.5
        ? 2 * progress * progress
        : 1 - Math.pow(-2 * progress + 2, 2) / 2;

      const x = startX + (targetX - startX) * ease;
      const y = startY + (Math.random() - 0.5) * 3; // slight vertical wobble
      await page.mouse.move(x, y);
      await new Promise(r => setTimeout(r, 10 + Math.random() * 25));
    }

    // Small overshoot then correct (human behavior)
    await page.mouse.move(targetX + 5 + Math.random() * 8, startY + (Math.random() - 0.5) * 2);
    await new Promise(r => setTimeout(r, 50 + Math.random() * 100));
    await page.mouse.move(targetX, startY);
    await humanDelay(50, 150);
    await page.mouse.up();

    await humanDelay(1000, 2000);
    console.log(`  [captcha] Slider drag completed`);
    return true;
  } catch (err) {
    console.log(`  [captcha] Slider error: ${err.message.substring(0, 50)}`);
    return false;
  }
}

/**
 * Solve math/text CAPTCHA by reading and computing
 */
async function solveMathCaptcha(page, captchaInfo) {
  console.log(`  [captcha] Attempting math/text CAPTCHA...`);

  try {
    let answer = null;
    const question = captchaInfo.question || '';

    // Try to solve math directly
    const mathMatch = question.match(/(\d+)\s*([+\-*/×÷])\s*(\d+)/);
    if (mathMatch) {
      const a = parseInt(mathMatch[1]);
      const op = mathMatch[2];
      const b = parseInt(mathMatch[3]);
      if (op === '+') answer = String(a + b);
      else if (op === '-' || op === '−') answer = String(a - b);
      else if (op === '*' || op === '×') answer = String(a * b);
      else if (op === '/' || op === '÷') answer = String(Math.floor(a / b));
      console.log(`  [captcha] Math: ${a} ${op} ${b} = ${answer}`);
    }

    // If math didn't work, try Claude Vision
    if (!answer) {
      answer = await solveWithClaudeVision(page, captchaInfo);
    }

    if (!answer) return false;

    // Find the input field and fill it
    const inputSelectors = [
      'input[class*="captcha"], input[id*="captcha"], input[name*="captcha"]',
      'input[placeholder*="captcha" i], input[placeholder*="answer" i]',
      'input[placeholder*="code" i], input[placeholder*="text" i]',
      '[class*="captcha"] input[type="text"]', '[id*="captcha"] input',
    ];

    for (const sel of inputSelectors) {
      const input = await page.$(sel).catch(() => null);
      if (input && await input.isVisible().catch(() => false)) {
        await input.fill('');
        await input.fill(answer);
        console.log(`  [captcha] Filled answer: "${answer}"`);
        return true;
      }
    }

    console.log(`  [captcha] Could not find input for answer`);
    return false;
  } catch (err) {
    console.log(`  [captcha] Math/text error: ${err.message.substring(0, 50)}`);
    return false;
  }
}

/**
 * Inject solved token into the page (for reCAPTCHA, hCaptcha, Turnstile)
 */
async function injectToken(page, captchaInfo, token) {
  if (!token) return false;

  console.log(`  [captcha] Injecting token for ${captchaInfo.type}...`);

  try {
    await page.evaluate(({ type, token }) => {
      // Set the token in hidden textarea (standard for reCAPTCHA/hCaptcha)
      const textareas = [
        'textarea[name="g-recaptcha-response"]',
        'textarea[id="g-recaptcha-response"]',
        'textarea[name="h-captcha-response"]',
        'textarea[id="h-captcha-response"]',
        '[name="cf-turnstile-response"]',
        'input[name="cf-turnstile-response"]',
      ];

      for (const sel of textareas) {
        const el = document.querySelector(sel);
        if (el) {
          el.value = token;
          el.style.display = 'block'; // Make visible briefly for event dispatch
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
          el.style.display = 'none';
        }
      }

      // Also set via hidden inputs
      const hiddenInputs = document.querySelectorAll('input[type="hidden"]');
      for (const input of hiddenInputs) {
        const name = (input.name || '').toLowerCase();
        if (name.includes('recaptcha') || name.includes('captcha') || name.includes('token') || name.includes('turnstile')) {
          input.value = token;
        }
      }

      // Try to trigger callbacks
      if (type === 'recaptcha_v2' || type === 'recaptcha_v3') {
        try {
          // Find and call the callback function
          if (window.grecaptcha) {
            const widgetId = 0;
            if (typeof window.___grecaptcha_cfg !== 'undefined') {
              const clients = window.___grecaptcha_cfg.clients;
              if (clients) {
                for (const [, client] of Object.entries(clients)) {
                  const findCallback = (obj, depth = 0) => {
                    if (depth > 5 || !obj) return null;
                    for (const [, val] of Object.entries(obj)) {
                      if (typeof val === 'function') return val;
                      if (typeof val === 'object' && val !== null) {
                        const found = findCallback(val, depth + 1);
                        if (found) return found;
                      }
                    }
                    return null;
                  };
                  const cb = findCallback(client);
                  if (cb) { cb(token); break; }
                }
              }
            }
          }
        } catch {}
      }

      if (type === 'hcaptcha') {
        try {
          if (window.hcaptcha) {
            // Try to find the callback
            const widgetIds = document.querySelectorAll('.h-captcha');
            for (const widget of widgetIds) {
              const cbName = widget.getAttribute('data-callback');
              if (cbName && typeof window[cbName] === 'function') {
                window[cbName](token);
              }
            }
          }
        } catch {}
      }

      if (type === 'turnstile') {
        try {
          if (window.turnstile) {
            const widgets = document.querySelectorAll('.cf-turnstile');
            for (const widget of widgets) {
              const cbName = widget.getAttribute('data-callback');
              if (cbName && typeof window[cbName] === 'function') {
                window[cbName](token);
              }
            }
          }
        } catch {}
      }
    }, { type: captchaInfo.type, token });

    console.log(`  [captcha] Token injected`);
    return true;
  } catch (err) {
    console.log(`  [captcha] Token injection error: ${err.message.substring(0, 50)}`);
    return false;
  }
}

/**
 * Solve reCAPTCHA v2 image challenges using Claude Vision
 */
async function solveRecaptchaImageChallenge(page) {
  if (!ANTHROPIC_KEY || !ENABLE_AI_VISION) return false;

  console.log(`  [captcha] Attempting reCAPTCHA image challenge with AI Vision...`);

  try {
    // Find the challenge iframe
    const challengeFrame = await page.$('iframe[src*="recaptcha/api2/bframe"], iframe[title*="recaptcha challenge"]').catch(() => null);
    if (!challengeFrame) return false;

    const frame = await challengeFrame.contentFrame().catch(() => null);
    if (!frame) return false;

    // Max 5 attempts (reCAPTCHA sometimes gives multiple rounds)
    for (let attempt = 0; attempt < 5; attempt++) {
      await humanDelay(1000, 2000);

      // Get the instruction text
      const instruction = await frame.$eval('.rc-imageselect-desc-wrapper, .rc-imageselect-instructions', el => el.innerText.trim()).catch(() => '');
      if (!instruction) break;

      console.log(`  [captcha] Challenge: "${instruction.substring(0, 60)}"`);

      // Screenshot the image grid
      const imageGrid = await frame.$('.rc-imageselect-challenge, .rc-image-tile-wrapper, table.rc-imageselect-table').catch(() => null);
      if (!imageGrid) break;

      const gridBuf = await imageGrid.screenshot().catch(() => null);
      if (!gridBuf) break;

      const imageBase64 = gridBuf.toString('base64');

      // Ask Claude to identify which tiles match
      const client = new Anthropic({ apiKey: ANTHROPIC_KEY });
      const response = await client.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 200,
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: imageBase64 } },
            { type: 'text', text: `This is a reCAPTCHA image grid challenge. The instruction says: "${instruction}"

The grid is a 3x3 or 4x4 image grid. Identify which tile positions match the instruction.
Return ONLY a JSON array of tile positions (1-based, reading left-to-right, top-to-bottom).
Example: [1, 3, 7] means tiles 1, 3, and 7 match.
If no tiles match, return [].
Return ONLY the JSON array, nothing else.` },
          ],
        }],
      });

      const answer = (response.content[0]?.text || '').trim();
      const tileMatch = answer.match(/\[[\d,\s]*\]/);
      if (!tileMatch) break;

      const tiles = JSON.parse(tileMatch[0]);
      console.log(`  [captcha] AI selected tiles: ${tiles.join(', ')}`);

      if (tiles.length === 0) {
        // Click "Skip" if available
        const skipBtn = await frame.$('#recaptcha-verify-button, .rc-button-default').catch(() => null);
        if (skipBtn) await skipBtn.click();
        break;
      }

      // Click the identified tiles
      const allTiles = await frame.$$('.rc-imageselect-tile, td.rc-imageselect-tile, .rc-image-tile-target');
      for (const tileIdx of tiles) {
        if (tileIdx >= 1 && tileIdx <= allTiles.length) {
          await humanDelay(200, 600);
          await allTiles[tileIdx - 1].click().catch(() => {});
        }
      }

      await humanDelay(500, 1000);

      // Click verify
      const verifyBtn = await frame.$('#recaptcha-verify-button, .rc-button-default:has-text("Verify"), button:has-text("VERIFY")').catch(() => null);
      if (verifyBtn) {
        await humanDelay(300, 800);
        await verifyBtn.click();
        await humanDelay(2000, 3000);
      }

      // Check if solved
      const mainFrame = await page.$('iframe[src*="recaptcha/api2/anchor"]').catch(() => null);
      if (mainFrame) {
        const mf = await mainFrame.contentFrame().catch(() => null);
        if (mf) {
          const checked = await mf.$('.recaptcha-checkbox-checked, [aria-checked="true"]').catch(() => null);
          if (checked) {
            console.log(`  [captcha] reCAPTCHA image challenge SOLVED!`);
            return true;
          }
        }
      }
    }

    return false;
  } catch (err) {
    console.log(`  [captcha] Image challenge error: ${err.message.substring(0, 50)}`);
    return false;
  }
}

/**
 * Attempt reCAPTCHA audio challenge fallback
 */
async function solveRecaptchaAudio(page) {
  console.log(`  [captcha] Attempting reCAPTCHA audio challenge...`);

  try {
    // Find challenge iframe
    const challengeFrame = await page.$('iframe[src*="recaptcha/api2/bframe"], iframe[title*="recaptcha challenge"]').catch(() => null);
    if (!challengeFrame) return false;

    const frame = await challengeFrame.contentFrame().catch(() => null);
    if (!frame) return false;

    // Click "Get an audio challenge" button
    const audioBtn = await frame.$('#recaptcha-audio-button, .rc-button-audio, button[title*="audio"]').catch(() => null);
    if (!audioBtn) return false;

    await humanDelay(300, 800);
    await audioBtn.click();
    await humanDelay(2000, 4000);

    // Get the audio source URL
    const audioSrc = await frame.$eval('#audio-source, audio source, .rc-audiochallenge-play-button + audio source', el => el.src).catch(() => '');
    if (!audioSrc) {
      console.log(`  [captcha] Audio source not found`);
      return false;
    }

    // Use Claude to analyze the audio instruction text (since we can't play audio in headless)
    // Check if there's a download link
    const downloadLink = await frame.$('a[href*=".mp3"], a.rc-audiochallenge-download-link').catch(() => null);

    if (ANTHROPIC_KEY) {
      // Screenshot the audio challenge for context
      const screenshotBuf = await frame.$('.rc-audiochallenge-control, .rc-audiochallenge').then(el => el?.screenshot()).catch(() => null);
      if (screenshotBuf) {
        console.log(`  [captcha] Audio challenge detected but requires speech-to-text service`);
        // For now, this requires a speech-to-text API (like Google/Azure STT)
        // The token approach via 2Captcha/CapSolver is much more reliable for audio
      }
    }

    return false;
  } catch (err) {
    console.log(`  [captcha] Audio error: ${err.message.substring(0, 50)}`);
    return false;
  }
}

// ─── Main CAPTCHA Solver ────────────────────────────────────────────────────

/**
 * Automatically detect and solve any CAPTCHA on the page.
 * Returns true if CAPTCHA was solved, false otherwise.
 *
 * @param {Page} page - Playwright page
 * @param {Object} opts - { maxRetries, allowHumanFallback }
 */
async function solveCaptcha(page, opts = {}) {
  const maxRetries = opts.maxRetries || 3;
  const allowHumanFallback = opts.allowHumanFallback !== false;
  const startTime = Date.now();

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    if (Date.now() - startTime > MAX_SOLVE_TIME) {
      console.log(`  [captcha] Overall timeout exceeded`);
      break;
    }

    // Step 1: Detect
    const captchaInfo = await detectCaptcha(page);
    if (!captchaInfo) {
      if (attempt === 0) console.log(`  [captcha] No CAPTCHA detected`);
      return true; // No CAPTCHA = success
    }

    console.log(`  [captcha] Attempt ${attempt + 1}/${maxRetries}: solving ${captchaInfo.type}...`);

    let solved = false;

    // Step 2: Try built-in heuristics first (fast, free)
    if (captchaInfo.type === 'checkbox') {
      solved = await solveCheckboxCaptcha(page);
      if (solved) {
        // Checkbox might trigger an image challenge — re-detect
        await humanDelay(1000, 2000);
        const postCheck = await detectCaptcha(page);
        if (!postCheck) return true;
        captchaInfo.type = postCheck.type;
      }
    }

    if (captchaInfo.type === 'slider') {
      solved = await solveSliderCaptcha(page);
      if (solved) {
        await humanDelay(1000, 2000);
        const postSlide = await detectCaptcha(page);
        if (!postSlide) return true;
      }
    }

    if (captchaInfo.type === 'math') {
      solved = await solveMathCaptcha(page, captchaInfo);
      if (solved) {
        // Click submit after filling
        const submitBtn = await page.$('button[type="submit"], button:has-text("Submit"), button:has-text("Verify"), [class*="captcha"] button').catch(() => null);
        if (submitBtn) await submitBtn.click().catch(() => {});
        await humanDelay(1000, 2000);
        const postMath = await detectCaptcha(page);
        if (!postMath) return true;
      }
    }

    if (captchaInfo.type === 'image') {
      // Try Claude Vision for image CAPTCHAs
      const answer = await solveWithClaudeVision(page, captchaInfo);
      if (answer) {
        // Fill the answer
        const input = await page.$('input[class*="captcha"], input[id*="captcha"], input[name*="captcha"], [class*="captcha"] input[type="text"]').catch(() => null);
        if (input) {
          await input.fill(answer);
          const submitBtn = await page.$('button[type="submit"], button:has-text("Submit"), button:has-text("Verify")').catch(() => null);
          if (submitBtn) await submitBtn.click().catch(() => {});
          await humanDelay(1500, 3000);
          const postImage = await detectCaptcha(page);
          if (!postImage) return true;
        }
      }
    }

    // Step 3: Try third-party solver API
    if (!solved && SOLVER_API_KEY && ['recaptcha_v2', 'recaptcha_v3', 'hcaptcha', 'turnstile', 'funcaptcha'].includes(captchaInfo.type)) {
      let token = null;

      if (SOLVER_SERVICE === '2captcha' || SOLVER_SERVICE === 'auto') {
        token = await solve2Captcha(captchaInfo);
      }

      if (!token && (SOLVER_SERVICE === 'capsolver' || SOLVER_SERVICE === 'auto')) {
        token = await solveCapSolver(captchaInfo);
      }

      if (token) {
        const injected = await injectToken(page, captchaInfo, token);
        if (injected) {
          // Try to submit/continue
          await humanDelay(500, 1000);
          const submitSelectors = [
            'button[type="submit"]', 'button:has-text("Submit")', 'button:has-text("Continue")',
            'button:has-text("Verify")', 'button:has-text("Next")', 'input[type="submit"]',
          ];
          for (const sel of submitSelectors) {
            const btn = await page.$(sel).catch(() => null);
            if (btn && await btn.isVisible().catch(() => false)) {
              await btn.click().catch(() => {});
              break;
            }
          }
          await humanDelay(2000, 3000);
          const postToken = await detectCaptcha(page);
          if (!postToken) return true;
        }
      }
    }

    // Step 4: Try reCAPTCHA image challenge with AI Vision
    if (!solved && captchaInfo.type === 'recaptcha_v2') {
      // First try checkbox
      const checkboxSolved = await solveCheckboxCaptcha(page);
      if (!checkboxSolved) {
        // Try image challenge with Claude Vision
        solved = await solveRecaptchaImageChallenge(page);
        if (solved) return true;

        // Try audio fallback
        solved = await solveRecaptchaAudio(page);
        if (solved) return true;
      } else {
        await humanDelay(1000, 2000);
        const recheck = await detectCaptcha(page);
        if (!recheck) return true;
        // Image challenge appeared after checkbox
        solved = await solveRecaptchaImageChallenge(page);
        if (solved) return true;
      }
    }

    await humanDelay(1000, 2000);
  }

  // Step 5: Human fallback (last resort)
  if (allowHumanFallback) {
    console.log(`  [captcha] Auto-solve failed. Waiting for human intervention...`);
    // Wait up to 60s for human to solve
    const deadline = Date.now() + 60000;
    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 3000));
      const stillCaptcha = await detectCaptcha(page);
      if (!stillCaptcha) {
        console.log(`  [captcha] Human solved it!`);
        return true;
      }
    }
    console.log(`  [captcha] Human timeout — CAPTCHA unsolved`);
  }

  return false;
}

/**
 * Check if CAPTCHA solver has any solving capability beyond human fallback
 */
function hasAutoSolveCapability() {
  return !!(SOLVER_API_KEY || (ANTHROPIC_KEY && ENABLE_AI_VISION));
}

/**
 * Get solver status for diagnostics
 */
function getSolverStatus() {
  return {
    solverApiConfigured: !!SOLVER_API_KEY,
    solverService: SOLVER_SERVICE,
    aiVisionEnabled: !!(ANTHROPIC_KEY && ENABLE_AI_VISION),
    anthropicKey: ANTHROPIC_KEY ? '***configured***' : 'missing',
    maxSolveTime: MAX_SOLVE_TIME,
    capabilities: [
      'checkbox (built-in)',
      'slider (built-in)',
      'math/text (built-in + AI)',
      ...(ANTHROPIC_KEY ? ['image CAPTCHA (Claude Vision)', 'reCAPTCHA image grid (Claude Vision)'] : []),
      ...(SOLVER_API_KEY ? ['reCAPTCHA v2 (API)', 'reCAPTCHA v3 (API)', 'hCaptcha (API)', 'Turnstile (API)', 'FunCaptcha (API)'] : []),
      'human fallback (always)',
    ],
  };
}

module.exports = {
  detectCaptcha,
  solveCaptcha,
  solveCheckboxCaptcha,
  solveSliderCaptcha,
  solveMathCaptcha,
  solveRecaptchaImageChallenge,
  solveRecaptchaAudio,
  solveWithClaudeVision,
  injectToken,
  hasAutoSolveCapability,
  getSolverStatus,
};
