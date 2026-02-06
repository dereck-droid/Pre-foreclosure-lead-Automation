import { chromium, type Browser, type Page } from 'playwright';
import path from 'path';
import { scraper as scraperConfig, resultsConfig, paths } from './config.js';
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

  // --- Solve reCAPTCHA v2 checkbox ---
  log.step(1, 'Looking for reCAPTCHA...');

  // The site has a reCAPTCHA v2 "I'm not a robot" checkbox.
  // We find the sitekey from the page and send it to 2Captcha.
  const siteKey = await page.evaluate(() => {
    const el = document.querySelector('[data-sitekey]');
    return el?.getAttribute('data-sitekey') || null;
  });

  if (siteKey) {
    log.info('reCAPTCHA found, solving via 2Captcha...');
    const result = await solveCaptcha(siteKey, scraperConfig.startUrl);

    // Inject the solved token into the page
    await page.evaluate(getCaptchaInjectionScript(result.token));
    log.success(`CAPTCHA solved (cost: $${result.costUsd})`);
    await delay();
  } else {
    log.warn('No reCAPTCHA sitekey found — may not be present or page structure changed');
  }

  // --- Click "I Accept" button ---
  log.step(1, 'Clicking "I Accept" button...');

  // From screenshot: it's a clear button with text "I Accept"
  await page.getByRole('button', { name: 'I Accept' }).click();
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

  // From screenshot: the home page has card-style boxes. "Basic Official Records
  // Search" is the first blue card with subtitle "Search by Name, Date or Document Number".
  // The link URL is: ssweb/search/DOCSEARCH2950S1
  await page.getByText('Basic Official Records Search').click();
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

  // --- Recording Date Start ---
  // From screenshots: Click the calendar icon button next to "Recording Date Start"
  // input. The popup defaults to today's date. Then click "Set Date".
  log.info('Setting Recording Date Start to today...');

  // The calendar icons have a tooltip "Open Date Picker" on hover.
  // There are two of them — first for start date, second for end date.
  const datePickerButtons = page.locator(
    'button[title="Open Date Picker"], button:has(mat-icon), button:has(.calendar-icon), ' +
    'button:near(:text("Recording Date Start"), 200)'
  );

  // Try the approach: find the input with placeholder mm/dd/yyyy, then click
  // the button immediately after it. There are exactly two such inputs.
  const dateInputs = page.locator('input[placeholder="mm/dd/yyyy"]');
  const startDateInput = dateInputs.nth(0);
  const endDateInput = dateInputs.nth(1);

  // Strategy A: Click the calendar icon for start date and use the date picker
  // The calendar button is the sibling/adjacent element to the input
  // In Tyler Tech apps, it's typically the next button element after the input
  const startDateContainer = startDateInput.locator('..');
  const startCalendarBtn = startDateContainer.locator('button').first();
  await startCalendarBtn.click();
  await delay(1000);

  // The date picker popup appears with today's date pre-selected
  // Click "Set Date" to confirm
  await page.getByText('Set Date').click();
  await delay(500);

  log.info('Recording Date Start set');

  // --- Recording Date End ---
  log.info('Setting Recording Date End to today...');

  const endDateContainer = endDateInput.locator('..');
  const endCalendarBtn = endDateContainer.locator('button').first();
  await endCalendarBtn.click();
  await delay(1000);

  // Click "Set Date" again for the end date
  await page.getByText('Set Date').click();
  await delay(500);

  log.info('Recording Date End set');

  // --- Document Type: Lis Pendens ---
  log.info('Selecting document type: Lis Pendens');

  // From screenshots: the Document Types field is a searchable input.
  // It has a magnifying glass icon and when you click it shows a dropdown
  // of all document types. When you type "lis" it filters to show "Lis Pendens".
  const docTypeField = page.locator('text=Document Types').locator('..').locator('input');
  await docTypeField.click();
  await docTypeField.pressSequentially('lis', { delay: 100 });
  await delay(1500);

  // From screenshot: the dropdown shows highlighted options, "Lis Pendens" is visible
  // Click the "Lis Pendens" option in the dropdown
  await page.locator('li, .option, [role="option"]').filter({ hasText: 'Lis Pendens' }).first().click();
  await delay(500);

  await screenshot(page, '04-form-filled');

  // Verify "Lis Pendens" chip/tag appeared in the field
  const selectedTag = page.locator('text=Lis Pendens').first();
  if (await selectedTag.isVisible()) {
    log.success('Document type "Lis Pendens" selected');
  } else {
    log.warn('Could not confirm "Lis Pendens" was selected — continuing anyway');
  }

  // --- Click Search ---
  log.step(3, 'Submitting search...');

  // From screenshot: "Search" button with magnifying glass icon, bottom-right of form
  await page.getByRole('button', { name: 'Search' }).click();
  await page.waitForLoadState('networkidle');
  await delay(2000);
  await screenshot(page, '05-results');

  log.success('Search submitted');
}

// ---------------------------------------------------------------------------
// Step 4: Scrape results from the table
// ---------------------------------------------------------------------------

async function scrapeResultsPage(page: Page): Promise<Filing[]> {
  const filings: Filing[] = [];

  // Tyler Technologies apps typically use standard HTML tables or ag-grid.
  // Try multiple selector strategies.
  const rows = await page.locator(resultsConfig.resultRows).all();

  if (rows.length === 0) {
    // Fallback: try to find any table rows
    const fallbackRows = await page.locator('table tbody tr').all();
    if (fallbackRows.length > 0) {
      log.info(`Found ${fallbackRows.length} rows using fallback table selector`);
      rows.push(...fallbackRows);
    }
  }

  for (const row of rows) {
    try {
      const cells = await row.locator('td').all();

      if (cells.length >= 4) {
        const cols = resultsConfig.columns;
        const filing: Filing = {
          document_number: (await cells[cols.documentNumber]?.textContent())?.trim() || '',
          document_type: (await cells[cols.documentType]?.textContent())?.trim() || '',
          recording_date: (await cells[cols.recordingDate]?.textContent())?.trim() || '',
          grantee_name: (await cells[cols.granteeName]?.textContent())?.trim() || '',
          property_address: cols.propertyAddress >= 0 && cells[cols.propertyAddress]
            ? (await cells[cols.propertyAddress]?.textContent())?.trim() || ''
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

    // Check for next page / pagination
    const nextButton = page.locator(resultsConfig.nextPageButton);
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
