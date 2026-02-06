import { chromium, type Browser, type Page } from 'playwright';
import path from 'path';
import { scraper as scraperConfig, paths } from './config.js';
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
  await delay(2000); // Let the page fully settle
  await screenshot(page, '01-disclaimer-page');

  // --- Solve reCAPTCHA v2 checkbox ---
  log.step(1, 'Waiting for reCAPTCHA to load...');

  // The reCAPTCHA widget takes a few seconds to load after the page.
  // Wait for the iframe to appear, which signals the widget is ready.
  try {
    await page.waitForSelector(
      'iframe[src*="recaptcha"], [data-sitekey], .g-recaptcha',
      { timeout: 15_000 }
    );
    log.info('reCAPTCHA widget detected on page');
  } catch {
    log.warn('reCAPTCHA iframe not found after 15s — may not be present');
  }

  // Extra wait for the reCAPTCHA to fully initialize its JavaScript
  await delay(3000);

  // The site has a reCAPTCHA v2 "I'm not a robot" checkbox.
  // We find the sitekey from the page and send it to 2Captcha.
  const siteKey = await page.evaluate(() => {
    const el = document.querySelector('[data-sitekey]');
    return el?.getAttribute('data-sitekey') || null;
  });

  if (siteKey) {
    log.info(`reCAPTCHA found (sitekey: ${siteKey.substring(0, 10)}...), solving via 2Captcha...`);

    // Try solving the CAPTCHA up to 2 times (2Captcha uses real humans, can be slow)
    let solved = false;
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        if (attempt > 1) log.info(`CAPTCHA retry attempt ${attempt}...`);
        const result = await solveCaptcha(siteKey, scraperConfig.startUrl);

        // Inject the solved token into the page
        await page.evaluate(getCaptchaInjectionScript(result.token));
        log.success(`CAPTCHA solved on attempt ${attempt} (cost: $${result.costUsd})`);
        solved = true;
        break;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.warn(`CAPTCHA attempt ${attempt} failed: ${msg}`);
        if (attempt === 2) throw err;
        log.info('Waiting 5 seconds before retrying...');
        await delay(5000);
      }
    }

    await delay(2000); // Let the page process the token
  } else {
    log.warn('No reCAPTCHA sitekey found — may not be present or page structure changed');
  }

  // --- Click "I Accept" button ---
  log.step(1, 'Clicking "I Accept" button...');

  // Wait for the button to be enabled (it's disabled until CAPTCHA is solved)
  const acceptButton = page.getByRole('button', { name: 'I Accept' });
  await acceptButton.waitFor({ state: 'visible', timeout: 10_000 });
  await delay(1000); // Brief pause like a human would
  await acceptButton.click();
  await page.waitForLoadState('networkidle');
  await delay(2000); // Let the next page fully load
  await screenshot(page, '02-after-accept');

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

  // Wait for the home page content to fully render
  await page.waitForSelector('text=Basic Official Records Search', { timeout: 15_000 });
  await delay(1500);

  await page.getByText('Basic Official Records Search').click();
  await page.waitForLoadState('networkidle');
  await delay(2000); // Let the search form fully render

  // Wait for the search form to actually appear
  await page.waitForSelector('input[placeholder="mm/dd/yyyy"]', { timeout: 15_000 });
  await screenshot(page, '03-search-page');

  log.success('Search page loaded');
}

// ---------------------------------------------------------------------------
// Step 3: Fill out the search form
// ---------------------------------------------------------------------------

async function fillSearchForm(page: Page, date?: string): Promise<string> {
  log.step(3, 'Filling out search form...');

  // --- Build date string in M/D/YYYY format ---
  // If a date was provided (e.g. from n8n), use it. Otherwise use today.
  let dateString: string;
  if (date) {
    dateString = date;
  } else {
    const today = new Date();
    dateString = `${today.getMonth() + 1}/${today.getDate()}/${today.getFullYear()}`;
  }
  log.info(`Searching for filings on: ${dateString}`);

  // --- Recording Date Start ---
  log.info('Setting Recording Date Start...');

  // Type the date directly into the input field (simpler than the calendar picker)
  const dateInputs = page.locator('input[placeholder="mm/dd/yyyy"]');
  const startDateInput = dateInputs.nth(0);
  const endDateInput = dateInputs.nth(1);

  await startDateInput.click();
  await delay(500);
  // Triple-click to select any existing text, then type over it
  await startDateInput.click({ clickCount: 3 });
  await startDateInput.pressSequentially(dateString, { delay: 50 });
  // Press Tab to move focus out and confirm the value
  await startDateInput.press('Tab');
  await delay(1000);

  log.info('Recording Date Start set');

  // --- Recording Date End ---
  log.info('Setting Recording Date End...');

  await endDateInput.click();
  await delay(500);
  await endDateInput.click({ clickCount: 3 });
  await endDateInput.pressSequentially(dateString, { delay: 50 });
  await endDateInput.press('Tab');
  await delay(1000);

  log.info('Recording Date End set');

  // --- Document Type: Lis Pendens ---
  log.info('Selecting document type: Lis Pendens');

  // From screenshots: the Document Types field is a searchable input.
  // It has a magnifying glass icon and when you click it shows a dropdown
  // of all document types. When you type "lis" it filters to show "Lis Pendens".
  // The error log revealed the exact selector: getByRole('textbox', { name: 'Document Types' })
  // This targets the visible text input (id="field_selfservice_documentTypes"), not the hidden one.
  const docTypeField = page.getByRole('textbox', { name: 'Document Types' });
  await docTypeField.click();
  await delay(1000); // Let the dropdown initialize
  await docTypeField.pressSequentially('lis', { delay: 150 });
  await delay(2000); // Wait for autocomplete/filter to process

  // From screenshot: the dropdown shows two items after typing "lis":
  //   1. The typed text echo (not clickable)
  //   2. The actual "Lis Pendens" option (bottom one — this is what we want)
  // Use .last() to always target the real selectable option at the bottom.
  await page.locator('li, .option, [role="option"]').filter({ hasText: 'Lis Pendens' }).last().click();
  await delay(1000); // Let the tag/chip appear

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
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await page.waitForLoadState('networkidle');
  await delay(3000); // Give results time to fully render
  await screenshot(page, '05-results');

  log.success('Search submitted');
  return dateString;
}

// ---------------------------------------------------------------------------
// Step 4: Scrape results — card-based layout
// ---------------------------------------------------------------------------
// The results page uses a card layout, NOT a table. Each result looks like:
//
//   20260071189 • Lis Pendens • 02/05/2026 01:31 PM
//   Grantor                Grantee              Legal              BookPage
//   RIDGEMOORE HOA INC     DE OLIVEIRA ANDREA C Lot: 7 RIDGE...
//
// We scrape by finding each result card and extracting the text content.
// ---------------------------------------------------------------------------

async function scrapeResults(page: Page): Promise<Filing[]> {
  log.step(4, 'Scraping results...');

  // Check if there are any results at all
  const noResults = await page.getByText('No results found').isVisible().catch(() => false);
  if (noResults) {
    log.info('No results found for this date range');
    return [];
  }

  // Get the total result count from the header text
  // Format: "Showing page 1 of 1 for 9 Total Results"
  const headerText = await page.getByText('Total Results').textContent().catch(() => '');
  const totalMatch = headerText?.match(/(\d+)\s*Total Results/);
  if (totalMatch) {
    log.info(`Results page says: ${totalMatch[1]} total results`);
  }

  // Scrape all result cards from the page.
  // Each card's full text contains the doc number, type, date, and party names.
  // We use page.evaluate() to extract structured data from the DOM in one pass.
  const filings = await page.evaluate(() => {
    const results: Array<{
      document_number: string;
      document_type: string;
      recording_date: string;
      grantor_name: string;
      grantee_name: string;
      legal_description: string;
    }> = [];

    // Strategy 1: Look for result card containers.
    // Tyler Tech ssweb apps typically wrap each result in a repeated element
    // with a document number as a prominent header or link.

    // Find all elements that contain a document number pattern (11-digit number)
    // The header format is: "20260071189 • Lis Pendens • 02/05/2026 01:31 PM"
    const allElements = document.querySelectorAll(
      // Common card containers in Tyler Tech apps
      '.search-result, .result-card, .document-card, ' +
      // Angular component selectors
      '[class*="result"], [class*="record"], [class*="document-row"], ' +
      // Generic card/list patterns
      '.card, .list-item, .row-item'
    );

    // If we found card containers, extract data from each
    if (allElements.length > 0) {
      for (const card of allElements) {
        const text = card.textContent || '';

        // Look for document number pattern: 11+ digits
        const docMatch = text.match(/(\d{11,})/);
        if (!docMatch) continue;

        // Look for date pattern: MM/DD/YYYY
        const dateMatch = text.match(/(\d{1,2}\/\d{1,2}\/\d{4})/);

        // Look for Grantor/Grantee sections
        const grantorSection = card.querySelector('[class*="grantor"], [data-label*="Grantor"]');
        const granteeSection = card.querySelector('[class*="grantee"], [data-label*="Grantee"]');
        const legalSection = card.querySelector('[class*="legal"], [data-label*="Legal"]');

        const grantorText = grantorSection?.textContent?.replace(/Grantor\s*(\(\d+\))?/i, '').trim() || '';
        const granteeText = granteeSection?.textContent?.replace(/Grantee\s*(\(\d+\))?/i, '').trim() || '';
        const legalText = legalSection?.textContent?.replace(/Legal/i, '').trim() || '';

        results.push({
          document_number: docMatch[1],
          document_type: 'Lis Pendens',
          recording_date: dateMatch ? dateMatch[1] : '',
          grantor_name: grantorText,
          grantee_name: granteeText,
          legal_description: legalText,
        });
      }
    }

    // Strategy 2: If strategy 1 found nothing, try parsing the full page text
    // by looking for the repeating pattern of document numbers
    if (results.length === 0) {
      const bodyText = document.body.innerText;
      // Match lines that start with an 11-digit number followed by bullet separators
      const cardPattern = /(\d{11,})\s*[•·]\s*(Lis Pendens)\s*[•·]\s*(\d{1,2}\/\d{1,2}\/\d{4}[^]*?)(?=\d{11,}\s*[•·]|$)/g;
      let match;

      while ((match = cardPattern.exec(bodyText)) !== null) {
        const cardText = match[3];

        // Extract Grantor text (everything between "Grantor" label and "Grantee" label)
        const grantorMatch = cardText.match(/Grantor(?:\s*\(\d+\))?\s+([\s\S]*?)(?=Grantee)/i);
        const granteeMatch = cardText.match(/Grantee(?:\s*\(\d+\))?\s+([\s\S]*?)(?=Legal)/i);
        const legalMatch = cardText.match(/Legal\s+([\s\S]*?)(?=BookPage|$)/i);

        results.push({
          document_number: match[1],
          document_type: match[2],
          recording_date: match[3].match(/(\d{1,2}\/\d{1,2}\/\d{4})/)?.[1] || '',
          grantor_name: grantorMatch?.[1]?.trim() || '',
          grantee_name: granteeMatch?.[1]?.trim() || '',
          legal_description: legalMatch?.[1]?.trim() || '',
        });
      }
    }

    return results;
  });

  log.success(`Scraped ${filings.length} filing(s) from results page`);

  // Log first result as a sample for verification
  if (filings.length > 0) {
    log.info('Sample result:', filings[0]);
  }

  return filings;
}

// ---------------------------------------------------------------------------
// Main scrape function — orchestrates the full flow
// ---------------------------------------------------------------------------

export async function scrapeFilings(date?: string): Promise<{ filings: Filing[]; date_searched: string }> {
  const page = await launchBrowser();

  try {
    await navigateAndAcceptDisclaimer(page);
    await navigateToSearch(page);
    const dateSearched = await fillSearchForm(page, date);
    const filings = await scrapeResults(page);
    return { filings, date_searched: dateSearched };
  } catch (error) {
    await errorScreenshot(page, 'scrape-failure');
    throw error;
  } finally {
    await closeBrowser();
  }
}
