# ApplyPilot AI

Automated job application bot that scrapes, scores, and applies to jobs on **LinkedIn** and **Naukri** using browser automation.

## Features

- **Multi-Platform Scraping** — Collects jobs from LinkedIn Easy Apply and Naukri across multiple search queries
- **Smart Scoring** — Ranks jobs by skill match, experience fit, and location preference
- **LinkedIn Easy Apply Automation** — Fills multi-step forms including:
  - Contact info (phone, email, city with typeahead)
  - Experience fields (detects specific tech skills and maps to years)
  - Salary/CTC (auto-detects INR vs LPA format)
  - Radio buttons (Yes/No questions with context-aware answers)
  - Dropdowns (experience ranges, selections)
  - Required checkbox groups (citizenship, tools, skills)
  - Resume upload
  - Cover letter / textarea
  - Validation error recovery (smart fix for "larger than X", "between X and Y")
- **Naukri Auto-Apply** — Parallel application with profile matching
- **External Apply Detection** — Identifies and handles external ATS redirects
- **Session Persistence** — Saves/loads cookies to avoid repeated logins
- **Daily Limit Detection** — Stops gracefully when LinkedIn's daily Easy Apply limit is reached
- **AI Brain (Optional)** — Claude API integration for intelligent page analysis

## Architecture

```
src/
├── index.js              # CLI entry point (scrape → score → apply pipeline)
├── scrapers/
│   ├── linkedin.js       # LinkedIn job scraper
│   ├── naukri.js         # Naukri job scraper
│   └── utils.js          # Cookie management, delays, helpers
├── scoring/
│   └── scorer.js         # Job-candidate match scoring
├── apply/
│   ├── linkedin.js       # LinkedIn Easy Apply automation
│   ├── naukri.js         # Naukri apply automation
│   ├── external.js       # External job site apply handler
│   └── ai-brain.js       # Claude API integration for form analysis
└── db/
    └── database.js       # SQLite database for job tracking

stress-test-apply.js      # Stress test: applies to 50+ jobs with detailed reporting
test-easy-apply-5.js      # Quick test: applies to 5 jobs
debug-form-steps.js       # Debug: walks through form steps logging all inputs
```

## Setup

### Prerequisites

- **Node.js** 18+
- **Playwright** (Chromium browser)

### Installation

```bash
# Clone the repository
git clone https://github.com/umamaheswar-chittem/applypilot-prototype.git
cd applypilot-prototype

# Install dependencies
npm install

# Install Playwright browser
npx playwright install chromium

# Configure environment
cp .env.example .env
# Edit .env with your credentials and profile
```

### Configuration

Edit `.env` with your details:

| Variable | Description | Example |
|----------|-------------|---------|
| `LINKEDIN_EMAIL` | LinkedIn login email | `user@gmail.com` |
| `LINKEDIN_PASSWORD` | LinkedIn password | `your_password` |
| `FIRST_NAME` | Your first name | `John` |
| `LAST_NAME` | Your last name | `Doe` |
| `PHONE` | Phone with country code | `+919876543210` |
| `CITY` | Preferred city | `Hyderabad` |
| `EXPECTED_CTC_LPA` | Expected CTC in LPA | `12` |
| `TOTAL_EXPERIENCE` | Years of experience | `3` |
| `RESUME_PATH` | Absolute path to resume PDF | `C:\path\to\resume.pdf` |
| `PROFILE_SKILLS` | Comma-separated skills | `Node.js,React,MongoDB` |

## Usage

### Full Pipeline (Scrape + Score + Apply)

```bash
npm start
# or
node src/index.js
```

### Individual Commands

```bash
# Scrape jobs only
node src/index.js linkedin    # LinkedIn only
node src/index.js naukri      # Naukri only

# Score scraped jobs
node src/index.js score

# Apply to scored jobs
node src/index.js apply              # Both platforms
node src/index.js apply:linkedin     # LinkedIn only
node src/index.js apply:naukri       # Naukri only

# View stats
node src/index.js stats

# Retry failed applications
node src/index.js retry
```

### Stress Testing

```bash
# Run comprehensive stress test (50+ jobs)
node stress-test-apply.js

# Quick test (5 jobs)
node test-easy-apply-5.js

# Debug form steps for a specific job
node debug-form-steps.js
```

## How It Works

### LinkedIn Easy Apply Flow

1. **Login** — Authenticates via saved cookies or fresh login
2. **Job Collection** — Searches multiple queries, collects Easy Apply job IDs
3. **Modal Opening** — 4-strategy click: mouse → Playwright → JS dispatch → direct SDUI URL
4. **Form Walking** — Steps through multi-page forms:
   - Detects input type via label text, placeholder, aria-label, parent context
   - Fills fields with profile data (phone, city, experience, salary, etc.)
   - Handles typeahead dropdowns (city/location)
   - Selects radio buttons with context-aware logic (Yes for most, No for visa/disability)
   - Checks required checkbox groups (picks "India" for citizenship, "Others" for tools)
   - Uploads resume
   - Recovers from validation errors with smart fixes
5. **Submission** — Clicks Submit, verifies "Application submitted" confirmation
6. **Stuck Detection** — Detects same-button loops, modal closures, daily limits

### Scoring Algorithm

Jobs are scored 0–1 based on:
- Skill keyword overlap with candidate profile
- Experience level match
- Location preference
- Job title relevance

## Tech Stack

- **[Playwright](https://playwright.dev/)** — Browser automation (pierces Shadow DOM)
- **[better-sqlite3](https://github.com/WiseLibs/better-sqlite3)** — Local job database
- **[dotenv](https://github.com/motdotla/dotenv)** — Environment configuration
- **[Claude API](https://docs.anthropic.com/)** — Optional AI-powered form analysis

## Limitations

- LinkedIn has a daily Easy Apply limit (~100-200 applications/day)
- Some jobs redirect to external ATS (Workday, Greenhouse, etc.) — detected and skipped
- CAPTCHA/security challenges may require manual intervention
- Form fields with highly unusual labels may need manual handling

## License

MIT
