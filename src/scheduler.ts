/**
 * SCHEDULER
 *
 * Runs the scraper on a cron schedule during business hours (Eastern Time).
 *
 * Usage: npm run schedule
 *
 * Schedule options (set CHECK_FREQUENCY in .env):
 *   "twice"  → Runs at 9:00 AM and 2:00 PM ET (Monday–Friday)
 *   "three"  → Runs at 8:00 AM, 12:00 PM, and 4:00 PM ET (Monday–Friday)
 */

import cron from 'node-cron';
import { schedule as scheduleConfig } from './config.js';
import { log } from './logger.js';

// The cron expressions for each frequency option
// Format: minute hour * * day-of-week
// All times in Eastern Time
const SCHEDULES = {
  twice: [
    '0 9 * * 1-5',   // 9:00 AM ET, Mon-Fri
    '0 14 * * 1-5',  // 2:00 PM ET, Mon-Fri
  ],
  three: [
    '0 8 * * 1-5',   // 8:00 AM ET, Mon-Fri
    '0 12 * * 1-5',  // 12:00 PM ET, Mon-Fri
    '0 16 * * 1-5',  // 4:00 PM ET, Mon-Fri
  ],
};

async function runScraper(): Promise<void> {
  log.info('Scheduler triggered — starting scraper run');

  try {
    // Dynamic import so each run gets a fresh module state
    // This prevents any stale state from previous runs
    const { execSync } = await import('child_process');
    execSync('npx tsx src/index.ts', {
      cwd: process.cwd(),
      stdio: 'inherit',
      env: { ...process.env },
    });
    log.success('Scheduled run completed successfully');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.error(`Scheduled run failed: ${message}`);
    // Don't re-throw — we want the scheduler to keep running
  }
}

function startScheduler(): void {
  const schedules = SCHEDULES[scheduleConfig.frequency];

  log.info('='.repeat(60));
  log.info('ORANGE COUNTY LIS PENDENS SCRAPER — Scheduler starting');
  log.info(`Frequency: ${scheduleConfig.frequency}`);
  log.info(`Timezone: America/New_York`);
  log.info(`Schedules:`);
  for (const s of schedules) {
    log.info(`  ${s}`);
  }
  log.info('='.repeat(60));

  // Register each cron schedule
  for (const cronExpression of schedules) {
    cron.schedule(cronExpression, runScraper, {
      timezone: 'America/New_York',
    });
  }

  log.info('Scheduler is running. Press Ctrl+C to stop.');
  log.info(`Next run will be at the next scheduled time.`);
  log.info('To test immediately, run: npm start');
}

startScheduler();
