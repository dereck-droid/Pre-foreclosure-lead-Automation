import 'dotenv/config';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

// Also load .env.local — Convex CLI writes CONVEX_URL here by convention.
// `override: false` means .env values take precedence if both files define the same key.
dotenv.config({ path: path.resolve(process.cwd(), '.env.local'), override: false });

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');

// ---------------------------------------------------------------------------
// Environment helpers
// ---------------------------------------------------------------------------
function optionalEnv(key: string, fallback: string = ''): string {
  return process.env[key] || fallback;
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------
export const paths = {
  root: PROJECT_ROOT,
  data: path.join(PROJECT_ROOT, 'data'),
  database: path.join(PROJECT_ROOT, 'data', 'scraper.db'),
  screenshots: path.join(PROJECT_ROOT, 'screenshots'),
  errors: path.join(PROJECT_ROOT, 'errors'),
};

// ---------------------------------------------------------------------------
// Scraper settings
// ---------------------------------------------------------------------------
export const scraper = {
  /** The starting URL for the Orange County comptroller portal */
  startUrl: 'https://selfservice.or.occompt.com/ssweb/user/disclaimer',

  /** The home page URL (after accepting disclaimer) */
  homeUrl: 'https://selfservice.or.occompt.com/ssweb/',

  /** The search form URL */
  searchUrl: 'https://selfservice.or.occompt.com/ssweb/search/DOCSEARCH2950S1',

  /** Run browser with visible window (true) or hidden (false) */
  headless: optionalEnv('HEADLESS', 'false') === 'true',

  /** Maximum results pages to scrape per run */
  maxPages: parseInt(optionalEnv('MAX_PAGES', '50'), 10),

  /** Milliseconds to wait between actions (be polite to the server) */
  actionDelay: 1500,

  /** Milliseconds to wait for page loads */
  pageTimeout: 60_000,
};

// ---------------------------------------------------------------------------
// 2Captcha
// ---------------------------------------------------------------------------
export const captcha = {
  apiKey: optionalEnv('TWOCAPTCHA_API_KEY'),
  submitUrl: 'https://2captcha.com/in.php',
  resultUrl: 'https://2captcha.com/res.php',
  pollIntervalMs: 5_000,
  maxWaitMs: 180_000, // 3 minutes — 2Captcha uses real humans, solve times vary
};

// ---------------------------------------------------------------------------
// HTTP Server (so n8n can trigger scrapes via HTTP Request)
// ---------------------------------------------------------------------------
export const server = {
  port: parseInt(optionalEnv('PORT', '3000'), 10),
};
