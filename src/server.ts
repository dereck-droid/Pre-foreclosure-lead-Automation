/**
 * ORANGE COUNTY LIS PENDENS SCRAPER — HTTP SERVER
 *
 * A lightweight HTTP server so n8n (or any tool) can trigger scrapes on demand.
 *
 * Endpoints:
 *   GET  /health        — Returns server status + database stats
 *   POST /scrape        — Triggers a scrape (returns 202 immediately)
 *   GET  /scrape/result — Returns the result of the most recent scrape
 *
 * The /scrape endpoint is async — it accepts the request, starts the scrape in
 * the background, and returns 202 right away.  n8n should then poll
 * /scrape/result every ~30s until scraper_busy is false.
 *
 * This avoids Railway's HTTP proxy timeout which kills long-running responses.
 *
 * Usage: npm run serve
 */

import http from 'http';
import { runScraper } from './index.js';
import { closeBrowser } from './scraper.js';
import { initDatabase, closeDatabase, getFilingCount } from './database.js';
import { getStats } from './convexLogger.js';
import { server as serverConfig } from './config.js';
import { log } from './logger.js';
import type { ScrapeResult } from './index.js';

// ---------------------------------------------------------------------------
// Concurrency lock — only one scrape can run at a time (one browser)
// ---------------------------------------------------------------------------
let isRunning = false;
let lastRunAt: string | null = null;
let lastResult: ScrapeResult | null = null;

// ---------------------------------------------------------------------------
// Request body parser
// ---------------------------------------------------------------------------
async function parseBody(req: http.IncomingMessage): Promise<any> {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      if (!body) return resolve({});
      try {
        resolve(JSON.parse(body));
      } catch {
        resolve({});
      }
    });
  });
}

// ---------------------------------------------------------------------------
// JSON response helper
// ---------------------------------------------------------------------------
function jsonResponse(
  res: http.ServerResponse,
  statusCode: number,
  data: any
): void {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  });
  res.end(JSON.stringify(data, null, 2));
}

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

/** GET /health — Server status + filing count (SQLite) + run stats (Convex) */
async function handleHealth(res: http.ServerResponse): Promise<void> {
  try {
    initDatabase();
    const totalFilings = getFilingCount();
    closeDatabase();

    const convexStats = await getStats();

    jsonResponse(res, 200, {
      status: 'ok',
      scraper_busy: isRunning,
      last_run_at: lastRunAt,
      timestamp: new Date().toISOString(),
      database: {
        total_filings: totalFilings,
        ...convexStats,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    jsonResponse(res, 500, {
      status: 'error',
      error: message,
    });
  }
}

/** POST /scrape — Kick off a scrape in the background, return 202 immediately.
 *  n8n should poll GET /scrape/result until scraper_busy is false. */
async function handleScrape(
  req: http.IncomingMessage,
  res: http.ServerResponse
): Promise<void> {
  // Prevent concurrent scrapes (only one browser at a time)
  if (isRunning) {
    jsonResponse(res, 409, {
      success: false,
      error: 'A scrape is already in progress. Poll GET /scrape/result for status.',
      error_step: 'concurrency_lock',
      scraper_busy: true,
    });
    return;
  }

  // Parse optional date from request body
  const body = await parseBody(req);
  const date: string | undefined = body.date;

  if (date) {
    log.info(`Scrape triggered via HTTP with custom date: ${date}`);
  } else {
    log.info('Scrape triggered via HTTP (using today\'s date)');
  }

  isRunning = true;
  lastRunAt = new Date().toISOString();
  lastResult = null;

  // Return 202 immediately — the scrape runs in the background
  jsonResponse(res, 202, {
    accepted: true,
    message: 'Scrape started. Poll GET /scrape/result for the outcome.',
    scraper_busy: true,
    started_at: lastRunAt,
  });

  // Run the scrape in the background (fire-and-forget from the HTTP perspective)
  runScrapeInBackground(date);
}

/** Runs the scraper and stores the result. Called after the 202 is sent. */
async function runScrapeInBackground(date?: string): Promise<void> {
  try {
    const timeoutMs = serverConfig.scrapeTimeoutMs;
    const result = await Promise.race([
      runScraper(date),
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error(`Scrape timed out after ${timeoutMs / 1000}s`)),
          timeoutMs,
        ),
      ),
    ]);

    lastResult = result;
  } catch (error) {
    // Timeout or unexpected crash — clean up browser
    try {
      await closeBrowser();
    } catch {
      // Browser may already be closed — ignore
    }

    const message = error instanceof Error ? error.message : String(error);
    log.error(`Scrape failed: ${message}`);

    lastResult = {
      success: false,
      date_searched: date || new Date().toLocaleDateString('en-US'),
      total_on_site: 0,
      new_filings: [],
      already_seen: 0,
      consecutive_failures: -1,
      duration_seconds: 0,
      error: message,
      error_step: 'unexpected_server_error',
    };
  } finally {
    isRunning = false;
  }
}

/** GET /scrape/result — Returns the latest scrape result, or busy status.
 *  Includes a stale-run safety net: if the scrape has been "running" for longer
 *  than the configured timeout + 60s buffer, force-clear the lock so the poll
 *  loop in n8n doesn't spin forever. */
function handleResult(res: http.ServerResponse): void {
  if (isRunning) {
    // Safety net: auto-clear a stale lock if the run has exceeded the timeout
    const staleLimitMs = serverConfig.scrapeTimeoutMs + 60_000;
    const elapsed = lastRunAt ? Date.now() - new Date(lastRunAt).getTime() : 0;

    if (elapsed > staleLimitMs) {
      log.error(`Stale scrape detected (${Math.round(elapsed / 1000)}s). Forcing lock release.`);
      isRunning = false;
      if (!lastResult) {
        lastResult = {
          success: false,
          date_searched: new Date().toLocaleDateString('en-US'),
          total_on_site: 0,
          new_filings: [],
          already_seen: 0,
          consecutive_failures: -1,
          duration_seconds: Math.round(elapsed / 1000),
          error: 'Scrape exceeded maximum runtime and was force-cleared',
          error_step: 'stale_lock_recovery',
        };
      }
    } else {
      jsonResponse(res, 200, {
        scraper_busy: true,
        message: 'Scrape is still running. Poll again in 30 seconds.',
        started_at: lastRunAt,
        elapsed_seconds: Math.round(elapsed / 1000),
      });
      return;
    }
  }

  if (!lastResult) {
    jsonResponse(res, 200, {
      scraper_busy: false,
      message: 'No scrape has been run yet since the server started.',
      last_run_at: lastRunAt,
    });
    return;
  }

  jsonResponse(res, 200, {
    scraper_busy: false,
    ...lastResult,
  });
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------
const httpServer = http.createServer(async (req, res) => {
  const url = req.url?.split('?')[0]; // Strip query params
  const method = req.method?.toUpperCase();

  // CORS preflight
  if (method === 'OPTIONS') {
    jsonResponse(res, 204, '');
    return;
  }

  // Route requests
  if (method === 'GET' && url === '/health') {
    return await handleHealth(res);
  }

  if (method === 'POST' && url === '/scrape') {
    return handleScrape(req, res);
  }

  if (method === 'GET' && url === '/scrape/result') {
    return handleResult(res);
  }

  // 404 for anything else
  jsonResponse(res, 404, {
    error: 'Not found',
    available_endpoints: {
      'GET /health': 'Server status and database stats',
      'POST /scrape': 'Trigger a scrape (returns 202, runs in background)',
      'GET /scrape/result': 'Get the result of the latest scrape',
    },
  });
});

// Start listening
httpServer.listen(serverConfig.port, () => {
  log.info('='.repeat(60));
  log.info('ORANGE COUNTY LIS PENDENS SCRAPER — HTTP Server');
  log.info('='.repeat(60));
  log.info(`Listening on port ${serverConfig.port}`);
  log.info('');
  log.info('Endpoints:');
  log.info(`  GET  http://localhost:${serverConfig.port}/health         — Status check`);
  log.info(`  POST http://localhost:${serverConfig.port}/scrape         — Trigger scrape (async)`);
  log.info(`  GET  http://localhost:${serverConfig.port}/scrape/result  — Poll for result`);
  log.info('');
  log.info('n8n workflow:');
  log.info('  1. POST /scrape → receives 202 immediately');
  log.info('  2. Wait 30s → GET /scrape/result');
  log.info('  3. If scraper_busy=true, wait 30s and poll again');
  log.info('  4. If scraper_busy=false, process the result');
  log.info('='.repeat(60));
});

// Graceful shutdown
process.on('SIGTERM', () => {
  log.info('SIGTERM received, shutting down...');
  httpServer.close();
  process.exit(0);
});

process.on('SIGINT', () => {
  log.info('SIGINT received, shutting down...');
  httpServer.close();
  process.exit(0);
});
