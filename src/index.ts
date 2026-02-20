/**
 * ORANGE COUNTY LIS PENDENS SCRAPER
 *
 * Core scrape function — runs a single scrape cycle:
 * 1. Opens the county website
 * 2. Solves CAPTCHA
 * 3. Searches for Lis Pendens filings (today or a specific date)
 * 4. Scrapes results
 * 5. Deduplicates against previous runs
 * 6. Returns only NEW filings as JSON (for n8n to process downstream)
 *
 * Used by:
 *   - server.ts (HTTP server — triggered by n8n)
 *   - Can also be run directly: npm start
 */

import { scrapeFilings } from './scraper.js';
import { initDatabase, closeDatabase, insertNewFilings } from './database.js';
import type { Filing } from './database.js';
import {
  startRun,
  completeRun,
  getConsecutiveFailures,
} from './convexLogger.js';
import { log } from './logger.js';

// ---------------------------------------------------------------------------
// Result type — this is what n8n receives
// ---------------------------------------------------------------------------
export interface ScrapeResult {
  success: boolean;
  date_searched: string;
  total_on_site: number;
  new_filings: Filing[];
  already_seen: number;
  consecutive_failures: number;
  duration_seconds: number;
  error: string | null;
  error_step: string | null;
}

// ---------------------------------------------------------------------------
// Main scrape function — exported for server.ts
// ---------------------------------------------------------------------------
export async function runScraper(date?: string): Promise<ScrapeResult> {
  const overallStart = Date.now();

  log.info('='.repeat(60));
  log.info('ORANGE COUNTY LIS PENDENS SCRAPER — Starting run');
  log.info('='.repeat(60));

  // Initialize SQLite (filings dedup) and Convex run log
  initDatabase();
  const runId = await startRun();

  try {
    // -------------------------------------------------------------------
    // PHASE 1: Scrape the county website
    // -------------------------------------------------------------------
    log.info('-'.repeat(40));
    log.info('PHASE 1: Scraping county website');
    log.info('-'.repeat(40));

    const { filings: allFilings, date_searched } = await scrapeFilings(date);
    const totalScraped = allFilings.length;

    if (allFilings.length === 0) {
      log.info('No filings found for this date. This may be normal (weekends, holidays).');
      const duration = (Date.now() - overallStart) / 1000;
      const durationRounded = Math.round(duration * 10) / 10;
      await completeRun(runId, 'success', date_searched, 0, 0, 0, durationRounded);

      return {
        success: true,
        date_searched,
        total_on_site: 0,
        new_filings: [],
        already_seen: 0,
        consecutive_failures: 0,
        duration_seconds: durationRounded,
        error: null,
        error_step: null,
      };
    }

    log.info(`Found ${allFilings.length} total filing(s) on the county website`);

    // -------------------------------------------------------------------
    // PHASE 2: Deduplicate — only keep filings we haven't seen before
    // -------------------------------------------------------------------
    log.info('-'.repeat(40));
    log.info('PHASE 2: Deduplication');
    log.info('-'.repeat(40));

    const newFilings = insertNewFilings(allFilings);
    const alreadySeen = totalScraped - newFilings.length;

    if (newFilings.length === 0) {
      log.info('All filings already in database — nothing new to process.');
    } else {
      log.success(`${newFilings.length} NEW filing(s) to process`);
    }

    // -------------------------------------------------------------------
    // Summary
    // -------------------------------------------------------------------
    const duration = (Date.now() - overallStart) / 1000;
    const durationRounded = Math.round(duration * 10) / 10;

    log.info('='.repeat(60));
    log.success('RUN COMPLETE');
    log.info(`  Date searched:      ${date_searched}`);
    log.info(`  Total on site:      ${totalScraped}`);
    log.info(`  New filings:        ${newFilings.length}`);
    log.info(`  Already seen:       ${alreadySeen}`);
    log.info(`  Duration:           ${duration.toFixed(1)} seconds`);
    log.info('='.repeat(60));

    await completeRun(
      runId, 'success', date_searched,
      totalScraped, newFilings.length, alreadySeen, durationRounded
    );

    return {
      success: true,
      date_searched,
      total_on_site: totalScraped,
      new_filings: newFilings,
      already_seen: alreadySeen,
      consecutive_failures: 0,
      duration_seconds: durationRounded,
      error: null,
      error_step: null,
    };

  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.error(`RUN FAILED: ${message}`);

    const duration = (Date.now() - overallStart) / 1000;
    const durationRounded = Math.round(duration * 10) / 10;
    const dateSearched = date || new Date().toLocaleDateString('en-US');

    // Determine which step failed based on the error message
    let errorStep = 'unknown';
    if (message.includes('CAPTCHA') || message.includes('captcha') || message.includes('2captcha')) {
      errorStep = 'captcha_solving';
    } else if (message.includes('disclaimer') || message.includes('Accept')) {
      errorStep = 'disclaimer_page';
    } else if (message.includes('search') || message.includes('Search')) {
      errorStep = 'search_form';
    } else if (message.includes('result') || message.includes('scrape')) {
      errorStep = 'results_scraping';
    } else if (message.includes('browser') || message.includes('Browser') || message.includes('chromium')) {
      errorStep = 'browser_launch';
    } else if (message.includes('timeout') || message.includes('Timeout')) {
      errorStep = 'timeout';
    }

    await completeRun(
      runId, 'failed', dateSearched,
      0, 0, 0, durationRounded,
      message, errorStep
    );

    const consecutiveFailures = await getConsecutiveFailures();

    return {
      success: false,
      date_searched: dateSearched,
      total_on_site: 0,
      new_filings: [],
      already_seen: 0,
      consecutive_failures: consecutiveFailures,
      duration_seconds: durationRounded,
      error: message,
      error_step: errorStep,
    };
  } finally {
    closeDatabase();
  }
}

// ---------------------------------------------------------------------------
// CLI entry point — allows running directly with: npm start
// ---------------------------------------------------------------------------
const isDirectRun = process.argv[1]?.includes('index');

if (isDirectRun) {
  const dateArg = process.argv[2]; // Optional: npm start -- "2/5/2026"
  runScraper(dateArg).then(result => {
    if (result.success) {
      log.info(`Done. ${result.new_filings.length} new filing(s) found.`);
    } else {
      log.error(`Failed: ${result.error}`);
      process.exit(1);
    }
  });
}
