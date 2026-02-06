/**
 * ORANGE COUNTY LIS PENDENS SCRAPER
 *
 * Main entry point — runs a single scrape cycle:
 * 1. Opens the county website
 * 2. Solves CAPTCHA
 * 3. Searches for today's Lis Pendens filings
 * 4. Scrapes results
 * 5. Deduplicates against previous runs
 * 6. Skip traces new filings (gets phone numbers & emails)
 * 7. Pushes enriched leads to CRM
 *
 * Usage: npm start
 */

import { scrapeFilings, closeBrowser } from './scraper.js';
import {
  initDatabase,
  closeDatabase,
  insertNewFilings,
  getFilingsPendingCrm,
  startRun,
  completeRun,
  getConsecutiveFailures,
} from './database.js';
import { skipTraceFilings } from './skip-trace.js';
import { pushFilingsToCrm } from './crm.js';
import { alertOnFailure, alertOnSuccess } from './notifications.js';
import { log } from './logger.js';

async function main(): Promise<void> {
  const overallStart = Date.now();

  log.info('='.repeat(60));
  log.info('ORANGE COUNTY LIS PENDENS SCRAPER — Starting run');
  log.info('='.repeat(60));

  // Initialize database
  initDatabase();
  const runId = startRun();

  const errors: string[] = [];
  let totalScraped = 0;
  let newFilingsCount = 0;

  try {
    // -----------------------------------------------------------------------
    // STEP 1: Scrape the county website
    // -----------------------------------------------------------------------
    log.info('-'.repeat(40));
    log.info('PHASE 1: Scraping county website');
    log.info('-'.repeat(40));

    const allFilings = await scrapeFilings();
    totalScraped = allFilings.length;

    if (allFilings.length === 0) {
      log.info('No filings found for today. This may be normal (weekends, holidays).');
      completeRun(runId, 'success', 0, 0, []);
      return;
    }

    log.info(`Found ${allFilings.length} total filing(s) on the county website`);

    // -----------------------------------------------------------------------
    // STEP 2: Deduplicate — only keep filings we haven't seen before
    // -----------------------------------------------------------------------
    log.info('-'.repeat(40));
    log.info('PHASE 2: Deduplication');
    log.info('-'.repeat(40));

    const newFilings = insertNewFilings(allFilings);
    newFilingsCount = newFilings.length;

    if (newFilings.length === 0) {
      log.info('All filings already in database — nothing new to process.');
      completeRun(runId, 'success', totalScraped, 0, []);
      return;
    }

    log.success(`${newFilings.length} NEW filing(s) to process`);

    // -----------------------------------------------------------------------
    // STEP 3: Skip trace new filings (get phone numbers & emails)
    // -----------------------------------------------------------------------
    log.info('-'.repeat(40));
    log.info('PHASE 3: Skip tracing');
    log.info('-'.repeat(40));

    const skipTraceResults = await skipTraceFilings(newFilings);

    if (skipTraceResults.failed > 0) {
      errors.push(`Skip trace failed for ${skipTraceResults.failed} filing(s)`);
    }

    // -----------------------------------------------------------------------
    // STEP 4: Push enriched leads to CRM
    // -----------------------------------------------------------------------
    log.info('-'.repeat(40));
    log.info('PHASE 4: Pushing to CRM');
    log.info('-'.repeat(40));

    const pendingCrm = getFilingsPendingCrm();
    const crmResults = await pushFilingsToCrm(pendingCrm);

    if (crmResults.failed > 0) {
      errors.push(`CRM push failed for ${crmResults.failed} filing(s)`);
    }

    // -----------------------------------------------------------------------
    // Summary
    // -----------------------------------------------------------------------
    const duration = ((Date.now() - overallStart) / 1000).toFixed(1);

    log.info('='.repeat(60));
    log.success('RUN COMPLETE');
    log.info(`  Total scraped:      ${totalScraped}`);
    log.info(`  New filings:        ${newFilingsCount}`);
    log.info(`  Skip traced:        ${skipTraceResults.successful} ok, ${skipTraceResults.failed} failed`);
    log.info(`  CRM pushed:         ${crmResults.pushed} ok, ${crmResults.failed} failed`);
    log.info(`  Skip trace cost:    $${skipTraceResults.totalCostUsd.toFixed(2)}`);
    log.info(`  Duration:           ${duration} seconds`);
    log.info(`  Errors:             ${errors.length > 0 ? errors.join('; ') : 'None'}`);
    log.info('='.repeat(60));

    completeRun(runId, 'success', totalScraped, newFilingsCount, errors);

    // Send success notification if there were new filings
    await alertOnSuccess(newFilingsCount, totalScraped);

  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.error(`RUN FAILED: ${message}`);
    errors.push(message);

    completeRun(runId, 'failed', totalScraped, newFilingsCount, errors);

    // Check how many times in a row we've failed
    const consecutiveFailures = getConsecutiveFailures();
    await alertOnFailure(message, consecutiveFailures);

    // Re-throw so the process exits with error code
    throw error;
  } finally {
    await closeBrowser();
    closeDatabase();
  }
}

// Run it
main().catch(error => {
  log.error('Fatal error', error);
  process.exit(1);
});
