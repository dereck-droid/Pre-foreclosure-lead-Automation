import 'dotenv/config';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');

// ---------------------------------------------------------------------------
// Environment helpers
// ---------------------------------------------------------------------------
function requireEnv(key: string): string {
  const value = process.env[key];
  if (!value) {
    throw new Error(
      `Missing required environment variable: ${key}\n` +
      `Make sure you have a .env file in the project root.\n` +
      `See .env.example for reference.`
    );
  }
  return value;
}

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
// CSS Selectors — UPDATE THESE after inspecting the county website
// ---------------------------------------------------------------------------
// These are placeholders. You MUST replace them with real selectors from the
// Orange County Comptroller's website. See SITE_INSPECTION_GUIDE.md for
// step-by-step instructions on how to find these.
// ---------------------------------------------------------------------------
export const selectors = {
  // Step 1: Disclaimer / CAPTCHA page
  recaptcha: '[TODO] .g-recaptcha, #recaptcha, iframe[src*="recaptcha"]',
  recaptchaSiteKey: '[TODO] data-sitekey attribute from the reCAPTCHA div',
  acceptButton: '[TODO] #acceptButton, button containing "I Accept"',

  // Step 2: Search type selection
  basicSearchButton: '[TODO] button or link for "Basic Official Records Search"',

  // Step 3: Search form
  startDateField: '[TODO] input for start date',
  endDateField: '[TODO] input for end date',
  setDateButton: '[TODO] button to confirm date selection',
  documentTypeField: '[TODO] input or dropdown for document type',
  documentTypeOption: '[TODO] dropdown option containing "LIS PENDENS"',
  searchButton: '[TODO] button to submit the search',

  // Step 4: Results
  resultsTable: '[TODO] the results table element',
  resultRows: '[TODO] selector for each data row in the table',
  nextPageButton: '[TODO] button to go to next page of results',

  // Column selectors within each row (adjust indices after inspection)
  columns: {
    documentNumber: '[TODO] cell or element containing the document number',
    documentType: '[TODO] cell or element containing the document type',
    recordingDate: '[TODO] cell or element containing the recording date',
    granteeName: '[TODO] cell or element containing the grantee/owner name',
    propertyAddress: '[TODO] cell or element containing the property address',
  },
};

// ---------------------------------------------------------------------------
// 2Captcha
// ---------------------------------------------------------------------------
export const captcha = {
  apiKey: optionalEnv('TWOCAPTCHA_API_KEY'),
  submitUrl: 'https://2captcha.com/in.php',
  resultUrl: 'https://2captcha.com/res.php',
  pollIntervalMs: 5_000,
  maxWaitMs: 90_000,
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
