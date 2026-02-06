import 'dotenv/config';
import path from 'path';
import { fileURLToPath } from 'url';

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
// Skip Tracing (Tracerfy)
// ---------------------------------------------------------------------------
export const skipTrace = {
  apiKey: optionalEnv('TRACERFY_API_KEY'),
  baseUrl: 'https://www.tracerfy.com/api',
};

// ---------------------------------------------------------------------------
// CRM
// ---------------------------------------------------------------------------
export const crm = {
  mode: optionalEnv('CRM_MODE', 'webhook') as 'webhook' | 'gohighlevel',
  webhookUrl: optionalEnv('CRM_WEBHOOK_URL'),
  ghl: {
    apiKey: optionalEnv('GHL_API_KEY'),
    locationId: optionalEnv('GHL_LOCATION_ID'),
    baseUrl: 'https://services.leadconnectorhq.com',
  },
};

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------
export const notifications = {
  twilio: {
    accountSid: optionalEnv('TWILIO_ACCOUNT_SID'),
    authToken: optionalEnv('TWILIO_AUTH_TOKEN'),
    fromNumber: optionalEnv('TWILIO_FROM_NUMBER'),
  },
  alertPhoneNumbers: optionalEnv('ALERT_PHONE_NUMBERS')
    .split(',')
    .map(n => n.trim())
    .filter(Boolean),
};

// ---------------------------------------------------------------------------
// Schedule
// ---------------------------------------------------------------------------
export const schedule = {
  frequency: optionalEnv('CHECK_FREQUENCY', 'twice') as 'twice' | 'three',
};
