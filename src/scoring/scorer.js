require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const { getAllJobs, updateJobScore } = require('../db/database');

// ─── Profile ────────────────────────────────────────────────────────────────

const PROFILE_SKILLS = (process.env.PROFILE_SKILLS || 'Node.js,TypeScript,JavaScript,Python,Express.js,React.js,AWS,GCP,Kafka,Microservices')
  .split(',')
  .map(s => s.trim().toLowerCase());

const EXPECTED_CTC_LPA = parseFloat(process.env.EXPECTED_CTC_LPA || '30');

// Companies/patterns known to be product-first or AI-focused (higher tier)
const PRODUCT_AI_PATTERNS = [
  'google', 'microsoft', 'amazon', 'meta', 'apple', 'netflix', 'uber', 'airbnb',
  'flipkart', 'swiggy', 'zomato', 'meesho', 'razorpay', 'freshworks', 'zoho',
  'phonepe', 'cred', 'groww', 'zerodha', 'slice', 'niyo', 'chargebee', 'browserstack',
  'postman', 'hasura', 'sarvam', 'krutrim', 'openai', 'anthropic', 'cohere',
  'hugging face', 'databricks', 'scale ai', 'nvidia', 'qualcomm', 'intuit',
  'adobe', 'salesforce', 'atlassian', 'gitlab', 'github', 'stripe', 'shopify',
  'moengage', 'clevertap', 'unacademy', 'byju', 'vedantu', 'upstox', 'smallcase',
  'leadsquared', 'sprinklr', 'mindtickle', 'darwinbox', 'helpshift',
  'weekday', 'deel', 'remote', 'cloudlabs', 'vercel', 'netlify', 'grafana',
  'confluent', 'elastic', 'mongodb', 'datadog', 'twilio', 'figma', 'notion',
];

// Service/outsourcing companies (lower tier)
const SERVICE_PATTERNS = [
  'tcs', 'infosys', 'wipro', 'hcl', 'cognizant', 'capgemini', 'accenture',
  'tech mahindra', 'mphasis', 'hexaware', 'ltimindtree', 'l&t', 'niit',
  'mastech', 'cyient', 'zensar', 'sonata', 'birlasoft', 'persistent',
  'coforge', 'mtar', 'kellton', 'sasken',
];

// ─── Weights ─────────────────────────────────────────────────────────────────
// Remote/Hybrid preferred — on-site only jobs are penalised

const WEIGHTS = {
  skillMatch:  0.30,
  salaryMatch: 0.20,
  companyTier: 0.10,
  recency:     0.10,
  titleMatch:  0.10,
  remoteScore: 0.20,  // 20% weight — remote/hybrid is a hard preference
};

// ─── Scoring Functions ───────────────────────────────────────────────────────

// Primary skills get double weight — these are the core differentiators on this resume
const PRIMARY_SKILLS = ['node.js', 'nodejs', 'typescript', 'node js', 'cognigy', 'kore.ai', 'kore ai', 'llm', 'genai', 'generative ai', 'conversational ai', 'chatbot', 'ivr'];

function scoreSkillMatch(job) {
  const text = `${job.title} ${job.description || ''}`.toLowerCase();
  if (!text.trim()) return 0;

  let matched = 0;
  let totalWeight = 0;
  for (const skill of PROFILE_SKILLS) {
    const weight = PRIMARY_SKILLS.some(p => skill.includes(p)) ? 2 : 1;
    const pattern = new RegExp(`\\b${skill.replace(/\./g, '\\.')}\\b`, 'i');
    if (pattern.test(text)) matched += weight;
    totalWeight += weight;
  }

  return matched / totalWeight;
}

function scoreSalaryMatch(job) {
  const { salary_min_lpa: min, salary_max_lpa: max } = job;

  // Remote global jobs often show USD — treat unknown salary on remote jobs as potentially high
  const isRemote = /remote/i.test(job.location || '');
  if (!min && !max) return isRemote ? 0.65 : 0.5;

  const midpoint = max ? (min + max) / 2 : min;

  if (midpoint >= EXPECTED_CTC_LPA * 1.5) return 1.0;    // 50%+ above → premium job
  if (midpoint >= EXPECTED_CTC_LPA * 1.2) return 0.95;   // 20%+ above expected
  if (midpoint >= EXPECTED_CTC_LPA) return 0.85;          // at or above expected
  if (midpoint >= EXPECTED_CTC_LPA * 0.85) return 0.6;   // within 15% below
  if (midpoint >= EXPECTED_CTC_LPA * 0.7) return 0.3;    // within 30% below
  return 0.1;                                              // far below
}

function scoreRemoteScore(job) {
  const location = (job.location || '').toLowerCase();
  const title    = (job.title || '').toLowerCase();
  const desc     = (job.description || '').toLowerCase();
  const combined = location + ' ' + desc;

  // Full remote (best)
  if (/\bremote\b/.test(location) || /\bremote\b/.test(title)) return 1.0;

  // Hybrid — explicitly mentioned
  if (/\bhybrid\b/.test(combined)) return 0.80;

  // Flexible / work from anywhere / distributed
  if (/work from anywhere|wfa|flexible work|distributed team/i.test(combined)) return 0.85;

  // Global remote-friendly companies based in India offices
  const globalCompanies = [
    'stripe', 'shopify', 'gitlab', 'github', 'atlassian', 'hashicorp',
    'cloudflare', 'datadog', 'twilio', 'figma', 'notion', 'linear',
    'vercel', 'netlify', 'mongodb', 'elastic', 'confluent', 'grafana',
  ];
  const company = (job.company || '').toLowerCase();
  if (globalCompanies.some(g => company.includes(g))) return 0.75;

  // Description mentions remote/hybrid options
  if (/remote.{0,30}option|option.{0,30}remote|hybrid.{0,30}option/i.test(desc)) return 0.65;

  // Unknown / not specified — give slight benefit of doubt
  if (!location || location === 'india') return 0.40;

  // Purely on-site — penalise heavily
  return 0.10;
}

function scoreCompanyTier(job) {
  const name = (job.company || '').toLowerCase();

  // Check service companies first (penalise)
  for (const pattern of SERVICE_PATTERNS) {
    if (name.includes(pattern)) return 0.2;
  }

  // Check product/AI companies
  for (const pattern of PRODUCT_AI_PATTERNS) {
    if (name.includes(pattern)) return 1.0;
  }

  // Heuristics: company with AI/Labs in name (specific, not generic)
  if (/\b(ai labs|ml labs|deepmind|openai|llm|genai)\b/i.test(name)) return 0.85;
  if (/\b(cloud|platform)\b/i.test(name)) return 0.65;

  return 0.5; // Unknown — neutral
}

function scoreRecency(job) {
  if (!job.posted_at) return 0.5; // Unknown — neutral

  const postedDate = new Date(job.posted_at);
  const now = new Date();
  const diffDays = (now - postedDate) / (1000 * 60 * 60 * 24);

  if (diffDays <= 1) return 1.0;
  if (diffDays <= 3) return 0.85;
  if (diffDays <= 7) return 0.65;
  if (diffDays <= 14) return 0.35;
  return 0.1;
}

function scoreTitleMatch(job) {
  const title = (job.title || '').toLowerCase();

  const seniorKeywords = ['senior', 'sr.', 'lead', 'principal', 'staff', 'head of', 'architect', 'technical lead', 'tech lead'];
  const primaryRoles = [
    'node.js', 'nodejs', 'node js', 'typescript',
    'conversational ai', 'chatbot', 'ivr', 'cognigy', 'kore',
    'llm engineer', 'generative ai', 'ai engineer', 'ai platform',
    'backend engineer', 'backend developer',
  ];
  const secondaryRoles = ['fullstack', 'full-stack', 'full stack', 'software engineer', 'ml engineer', 'platform engineer'];
  const avoidKeywords = ['intern', 'junior', 'fresher', 'trainee'];
  // Penalise titles clearly outside this skill set
  const wrongTechKeywords = ['java ', 'spring boot', '.net', 'php', 'ruby', 'golang', 'android', 'ios', 'qa ', 'sdet', 'data engineer', 'data analyst', 'bi developer', 'salesforce developer'];

  if (avoidKeywords.some(k => title.includes(k))) return 0.1;
  if (wrongTechKeywords.some(k => title.includes(k))) return 0.2;

  let score = 0.4;
  if (seniorKeywords.some(k => title.includes(k))) score += 0.25;
  if (primaryRoles.some(k => title.includes(k))) score += 0.35;
  else if (secondaryRoles.some(k => title.includes(k))) score += 0.20;

  return Math.min(score, 1.0);
}

// ─── Main Scorer ─────────────────────────────────────────────────────────────

function scoreJob(job) {
  const components = {
    skillMatch:  scoreSkillMatch(job),
    salaryMatch: scoreSalaryMatch(job),
    companyTier: scoreCompanyTier(job),
    recency:     scoreRecency(job),
    titleMatch:  scoreTitleMatch(job),
    remoteScore: scoreRemoteScore(job),
  };

  const total = Object.entries(WEIGHTS).reduce((sum, [key, weight]) => {
    return sum + (components[key] * weight);
  }, 0);

  return { score: Math.round(total * 100) / 100, breakdown: components };
}

function run() {
  const jobs = getAllJobs();
  console.log(`[scorer] Scoring ${jobs.length} jobs...\n`);

  const results = [];

  for (const job of jobs) {
    const { score, breakdown } = scoreJob(job);
    updateJobScore(job.url, score, breakdown);
    results.push({ ...job, score, breakdown });
  }

  results.sort((a, b) => b.score - a.score);

  console.log('─────────────────────────────────────────────────────');
  console.log('TOP 15 JOBS');
  console.log('─────────────────────────────────────────────────────');

  results.slice(0, 20).forEach((job, i) => {
    const salaryStr  = job.salary_raw ? ` | ${job.salary_raw}` : '';
    const applyStr   = job.apply_type === 'easy_apply' ? ' ⚡' : '';
    const remoteStr  = /remote/i.test(job.location || '') ? ' 🌍 REMOTE' : '';
    const premiumStr = job.salary_min_lpa >= EXPECTED_CTC_LPA * 1.3 ? ' 💰 HIGH PAY' : '';
    console.log(`\n${i + 1}. [${(job.score * 100).toFixed(0)}%]${applyStr}${remoteStr}${premiumStr} ${job.title}`);
    console.log(`   ${job.company} — ${job.location || 'N/A'}${salaryStr}`);
    console.log(`   Skills:${(job.breakdown.skillMatch*100).toFixed(0)}% | Salary:${(job.breakdown.salaryMatch*100).toFixed(0)}% | Co:${(job.breakdown.companyTier*100).toFixed(0)}% | Fresh:${(job.breakdown.recency*100).toFixed(0)}% | Remote:${(job.breakdown.remoteScore*100).toFixed(0)}%`);
    console.log(`   ${job.url}`);
  });

  const remoteJobs  = results.filter(j => /remote/i.test(j.location || ''));
  const highPay     = results.filter(j => j.salary_min_lpa >= EXPECTED_CTC_LPA * 1.3);
  const topMatches  = results.filter(j => j.score >= 0.7);

  console.log('\n─────────────────────────────────────────────────────');
  console.log(`Total scored : ${results.length}`);
  console.log(`High match   : ${topMatches.length}  (≥70%)`);
  console.log(`Remote jobs  : ${remoteJobs.length}`);
  console.log(`High pay     : ${highPay.length}  (≥${Math.round(EXPECTED_CTC_LPA * 1.3)}L+)`);

  return results;
}

if (require.main === module) {
  run();
}

module.exports = { scoreJob, run };
