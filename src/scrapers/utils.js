const fs = require('fs');
const path = require('path');

const COOKIES_DIR = path.join(__dirname, '../../cookies');

function randomDelay(minMs, maxMs) {
  const ms = Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
  return new Promise(resolve => setTimeout(resolve, ms));
}

function humanDelay() {
  const min = parseInt(process.env.MIN_DELAY_MS || '600');
  const max = parseInt(process.env.MAX_DELAY_MS || '1200');
  return randomDelay(min, max);
}

function fastDelay() {
  return randomDelay(150, 300);
}

function saveCookies(name, cookies) {
  if (!fs.existsSync(COOKIES_DIR)) fs.mkdirSync(COOKIES_DIR, { recursive: true });
  fs.writeFileSync(path.join(COOKIES_DIR, `${name}.json`), JSON.stringify(cookies, null, 2));
  console.log(`[cookies] Saved ${cookies.length} cookies for ${name}`);
}

function loadCookies(name) {
  const file = path.join(COOKIES_DIR, `${name}.json`);
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

// Parse salary strings like "₹30L - ₹45L PA", "30,00,000 - 45,00,000", etc.
function parseSalaryLPA(raw) {
  if (!raw) return { min: null, max: null };

  const cleaned = raw.replace(/[₹,\s]/g, '').toLowerCase();

  // Match patterns like 30l, 30lpa, 3000000
  const lpaPattern = /(\d+(?:\.\d+)?)l/g;
  const matches = [...cleaned.matchAll(lpaPattern)].map(m => parseFloat(m[1]));

  if (matches.length >= 2) return { min: matches[0], max: matches[1] };
  if (matches.length === 1) return { min: matches[0], max: matches[0] };

  // Try raw numbers (assume rupees, convert to LPA)
  const numPattern = /(\d{6,8})/g;
  const nums = [...cleaned.matchAll(numPattern)].map(m => Math.round(parseInt(m[1]) / 100000) / 10);
  if (nums.length >= 2) return { min: nums[0], max: nums[1] };
  if (nums.length === 1) return { min: nums[0], max: nums[0] };

  return { min: null, max: null };
}

function parsePostedAt(text) {
  if (!text) return null;
  const now = new Date();
  const t = text.toLowerCase();

  if (t.includes('just now') || t.includes('today') || t.includes('few seconds')) {
    return now.toISOString();
  }
  const hoursMatch = t.match(/(\d+)\s*hour/);
  if (hoursMatch) {
    now.setHours(now.getHours() - parseInt(hoursMatch[1]));
    return now.toISOString();
  }
  const daysMatch = t.match(/(\d+)\s*day/);
  if (daysMatch) {
    now.setDate(now.getDate() - parseInt(daysMatch[1]));
    return now.toISOString();
  }
  const weekMatch = t.match(/(\d+)\s*week/);
  if (weekMatch) {
    now.setDate(now.getDate() - parseInt(weekMatch[1]) * 7);
    return now.toISOString();
  }
  return null;
}

module.exports = { humanDelay, fastDelay, saveCookies, loadCookies, parseSalaryLPA, parsePostedAt };
