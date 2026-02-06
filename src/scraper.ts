import { chromium, type Browser, type Page } from 'playwright';
import path from 'path';
import { scraper as scraperConfig, selectors, paths } from './config.js';
import { log } from './logger.js';
import { solveCaptcha, getCaptchaInjectionScript } from './captcha.js';
import type { Filing } from './database.js';

// ---------------------------------------------------------------------------
// Browser management
// ---------------------------------------------------------------------------

let browser: Browser | null = null;

export async function launchBrowser(): Promise<Page> {
  log.step(0, 'Launching browser...');

  browser = await chromium.launch({
    headless: scraperConfig.headless,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
    ],
  });

  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  });

  const page = await context.newPage();
  page.setDefaultTimeout(scraperConfig.pageTimeout);

  log.success('Browser launched');
  return page;
}

export async function closeBrowser(): Promise<void> {
  if (browser) {
    await browser.close();
    browser = null;
    log.info('Browser closed');
  }
}

// ---------------------------------------------------------------------------
// Screenshot helpers
// ---------------------------------------------------------------------------

async function screenshot(page: Page, name: string): Promise<string> {
  const filename = `${name}-${Date.now()}.png`;
  const filepath = path.join(paths.screenshots, filename);
  await page.screenshot({ path: filepath, fullPage: true });
  log.info(`Screenshot saved: ${filename}`);
  return filepath;
}

async function errorScreenshot(page: Page, name: string): Promise<string> {
  const filename = `error-${name}-${Date.now()}.png`;
  const filepath = path.join(paths.errors, filename);
  await page.screenshot({ path: filepath, fullPage: true });
  log.error(`Error screenshot saved: ${filename}`);
  return filepath;
}

// ---------------------------------------------------------------------------
// Delay helper — be polite to the county website
// ---------------------------------------------------------------------------

function delay(ms?: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms ?? scraperConfig.actionDelay));
}

// ---------------------------------------------------------------------------
// Step 1: Navigate to disclaimer page and handle CAPTCHA
// ---------------------------------------------------------------------------

async function navigateAndAcceptDisclaimer(page: Page): Promise<void> {
  log.step(1, 'Navigating to Orange County Comptroller portal...');

  await page.goto(scraperConfig.startUrl, { waitUntil: 'networkidle' });
  await screenshot(page, '01-disclaimer-page');

  // --- Solve reCAPTCHA ---
  log.step(1, 'Looking for reCAPTCHA...');

  // Try to find the reCAPTCHA site key
  // NOTE: The selector below is a placeholder — update after site inspection
  const siteKey = await page.evaluate(() => {
    const el = document.querySelector('[data-sitekey]');
    return el?.getAttribute('data-sitekey') || null;
  });

  if (siteKey) {
    log.info('reCAPTCHA found, solving...');
    const result = await solveCaptcha(siteKey, scraperConfig.startUrl);

    // Inject the solved token
    await page.evaluate(getCaptchaInjectionScript(result.token));
    log.success(`CAPTCHA solved (cost: $${result.costUsd})`);
    await delay();
  } else {
    log.warn('No reCAPTCHA found on page — it may have changed or may not be present today');
  }

  // --- Click "I Accept" ---
  log.step(1, 'Clicking "I Accept" button...');

  // TODO: Replace this selector after site inspection
  // Try multiple possible selectors for the accept button
  const acceptButton = await page.locator(
    // Common patterns for accept/disclaimer buttons:
    'button:has-text("I Accept"), button:has-text("Accept"), input[value*="Accept"], a:has-text("I Accept")'
  ).first();

  await acceptButton.click();
  await page.waitForLoadState('networkidle');
  await screenshot(page, '02-after-accept');
  await delay();

  log.success('Disclaimer accepted');
}

// ---------------------------------------------------------------------------
// Step 2: Navigate to Basic Official Records Search
// ---------------------------------------------------------------------------

async function navigateToSearch(page: Page): Promise<void> {
  log.step(2, 'Navigating to Basic Official Records Search...');

  // TODO: Replace this selector after site inspection
  const searchLink = await page.locator(
    'a:has-text("Official Records"), button:has-text("Official Records"), a:has-text("Basic Search")'
  ).first();

  await searchLink.click();
  await page.waitForLoadState('networkidle');
  await screenshot(page, '03-search-page');
  await delay();

  log.success('Search page loaded');
}

// ---------------------------------------------------------------------------
// Step 3: Fill out the search form
// ---------------------------------------------------------------------------

async function fillSearchForm(page: Page): Promise<void> {
  log.step(3, 'Filling out search form...');

  // --- Date range ---
  // Default: search today's filings
  const today = new Date();
  const dateString = `${(today.getMonth() + 1).toString().padStart(2, '0')}/${today.getDate().toString().padStart(2, '0')}/${today.getFullYear()}`;

  log.info(`Searching for filings on: ${dateString}`);

  // TODO: Replace these selectors after site inspection
  // Start date
  const startDateInput = page.locator(selectors.startDateField);
  await startDateInput.click();
  await startDateInput.fill(dateString);
  await delay(500);

  // End date
  const endDateInput = page.locator(selectors.endDateField);
  await endDateInput.click();
  await endDateInput.fill(dateString);
  await delay(500);

  // --- Document type: Lis Pendens ---
  log.info('Selecting document type: LIS PENDENS');

  const docTypeInput = page.locator(selectors.documentTypeField);
  await docTypeInput.click();
  // Type slowly to trigger any autocomplete/dropdown
  await docTypeInput.pressSequentially('Lis Pendens', { delay: 100 });
  await delay(2000);

  // Click the matching dropdown option
  // TODO: Replace this selector after site inspection
  const option = page.locator(selectors.documentTypeOption);
  await option.click();
  await delay(500);

  await screenshot(page, '04-form-filled');

  // --- Click Search ---
  log.step(3, 'Submitting search...');
  const searchBtn = page.locator(selectors.searchButton);
  await searchBtn.click();
  await page.waitForLoadState('networkidle');
  await screenshot(page, '05-results');
  await delay();

  log.success('Search submitted');
}

// ---------------------------------------------------------------------------
// Step 4: Scrape results from the table
// ---------------------------------------------------------------------------

async function scrapeResultsPage(page: Page): Promise<Filing[]> {
  const filings: Filing[] = [];

  // TODO: Replace these selectors after site inspection
  const rows = await page.locator(selectors.resultRows).all();

  for (const row of rows) {
    try {
      // TODO: Adjust column extraction based on actual table structure
      // These assume table cells (td) in order — you'll likely need to adjust
      const cells = await row.locator('td').all();

      if (cells.length >= 4) {
        const filing: Filing = {
          document_number: (await cells[0].textContent())?.trim() || '',
          document_type: (await cells[1].textContent())?.trim() || '',
          recording_date: (await cells[2].textContent())?.trim() || '',
          grantee_name: (await cells[3].textContent())?.trim() || '',
          property_address: cells.length >= 5
            ? (await cells[4].textContent())?.trim() || ''
            : '',
        };

        if (filing.document_number) {
          filings.push(filing);
        }
      }
    } catch (err) {
      log.warn('Failed to parse a result row, skipping', err);
    }
  }

  return filings;
}

async function scrapeAllPages(page: Page): Promise<Filing[]> {
  log.step(4, 'Scraping results...');

  const allFilings: Filing[] = [];
  let pageNum = 1;

  while (pageNum <= scraperConfig.maxPages) {
    log.info(`Scraping results page ${pageNum}...`);

    const pageFilings = await scrapeResultsPage(page);
    allFilings.push(...pageFilings);

    log.info(`Page ${pageNum}: found ${pageFilings.length} filings`);

    // Check for next page button
    // TODO: Replace this selector after site inspection
    const nextButton = page.locator(selectors.nextPageButton);
    const hasNext = await nextButton.isVisible().catch(() => false);

    if (!hasNext) {
      log.info('No more pages');
      break;
    }

    await nextButton.click();
    await page.waitForLoadState('networkidle');
    await delay();
    pageNum++;
  }

  log.success(`Scraped ${allFilings.length} total filings across ${pageNum} page(s)`);
  return allFilings;
}

// ---------------------------------------------------------------------------
// Main scrape function — orchestrates the full flow
// ---------------------------------------------------------------------------

export async function scrapeFilings(): Promise<Filing[]> {
  const page = await launchBrowser();

  try {
    await navigateAndAcceptDisclaimer(page);
    await navigateToSearch(page);
    await fillSearchForm(page);
    const filings = await scrapeAllPages(page);
    return filings;
  } catch (error) {
    await errorScreenshot(page, 'scrape-failure');
    throw error;
  } finally {
    await closeBrowser();
  }
}
