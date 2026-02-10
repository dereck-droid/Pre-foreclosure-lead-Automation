/**
 * ORANGE COUNTY LIS PENDENS SCRAPER — HTTP SERVER
 *
 * A lightweight HTTP server so n8n (or any tool) can trigger scrapes on demand.
 *
 * Endpoints:
 *   GET  /health  — Returns server status + database stats
 *   POST /scrape  — Triggers a scrape. Accepts optional JSON body: { "date": "2/5/2026" }
 *                   Returns scraped filings as JSON (takes 2-3 minutes due to CAPTCHA)
 *
 * In n8n:
 *   1. Schedule Trigger node (set your desired frequency)
 *   2. HTTP Request node → POST http://your-server:3000/scrape
 *      - Set timeout to 300 seconds (5 min) to allow for CAPTCHA solving
 *   3. The response contains new_filings[] — loop through and process each one
 *
 * Usage: npm run serve
 */

import http from 'http';
import { runScraper } from './index.js';
import { initDatabase, closeDatabase, getStats } from './database.js';
import { closeBrowser } from './scraper.js';
import { server as serverConfig } from './config.js';
import { log } from './logger.js';

// ---------------------------------------------------------------------------
// Concurrency lock — only one scrape can run at a time (one browser)
// Auto-resets after lockTimeoutMs to prevent stale locks from crashes.
// ---------------------------------------------------------------------------
let isRunning = false;
let lastRunAt: string | null = null;
let runStartedAt: number = 0;

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

/** GET /health — Server status + database stats */
function handleHealth(res: http.ServerResponse): void {
  try {
    initDatabase();
    const stats = getStats();
    closeDatabase();

    jsonResponse(res, 200, {
      status: 'ok',
      scraper_busy: isRunning,
      last_run_at: lastRunAt,
      timestamp: new Date().toISOString(),
      database: stats,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    jsonResponse(res, 500, {
      status: 'error',
      error: message,
    });
  }
}

/** Wrap a promise with a timeout. Rejects with a clear message if exceeded. */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${label}: exceeded ${Math.round(ms / 1000)}s timeout`)),
      ms
    );
    promise
      .then((v) => { clearTimeout(timer); resolve(v); })
      .catch((e) => { clearTimeout(timer); reject(e); });
  });
}

/** POST /scrape — Trigger a scrape run */
async function handleScrape(
  req: http.IncomingMessage,
  res: http.ServerResponse
): Promise<void> {
  // Auto-reset stale lock — if a previous run crashed without clearing isRunning,
  // allow a new run after lockTimeoutMs has elapsed.
  if (isRunning && runStartedAt > 0) {
    const elapsed = Date.now() - runStartedAt;
    if (elapsed > serverConfig.lockTimeoutMs) {
      log.warn(`Stale lock detected (${Math.round(elapsed / 1000)}s old) — auto-resetting`);
      isRunning = false;
    }
  }

  // Prevent concurrent scrapes (only one browser at a time)
  if (isRunning) {
    jsonResponse(res, 409, {
      success: false,
      error: 'A scrape is already in progress. Try again later.',
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
  runStartedAt = Date.now();

  try {
    // Wrap the scraper with an overall timeout so we always respond before
    // n8n's HTTP Request node gives up (300s). Default: 240s (4 min).
    const result = await withTimeout(
      runScraper(date),
      serverConfig.scrapeTimeoutMs,
      'Scrape run'
    );

    // HTTP status: 200 for success, 502 for scraper failure
    // (502 = "Bad Gateway" — the upstream service (county site) had an issue)
    const statusCode = result.success ? 200 : 502;
    jsonResponse(res, statusCode, result);
  } catch (error) {
    // This catches both runScraper errors and our timeout wrapper.
    const message = error instanceof Error ? error.message : String(error);
    const duration = (Date.now() - runStartedAt) / 1000;
    log.error(`Scrape failed: ${message}`);

    // If the timeout fired, the browser may still be running — force-close it.
    await closeBrowser().catch(() => {});

    jsonResponse(res, 500, {
      success: false,
      error: message,
      error_step: message.includes('timeout') ? 'overall_timeout' : 'unexpected_server_error',
      date_searched: date || new Date().toLocaleDateString('en-US'),
      total_on_site: 0,
      new_filings: [],
      already_seen: 0,
      consecutive_failures: -1,
      duration_seconds: Math.round(duration * 10) / 10,
    });
  } finally {
    isRunning = false;
    runStartedAt = 0;
  }
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
    return handleHealth(res);
  }

  if (method === 'POST' && url === '/scrape') {
    return handleScrape(req, res);
  }

  // 404 for anything else
  jsonResponse(res, 404, {
    error: 'Not found',
    available_endpoints: {
      'GET /health': 'Server status and database stats',
      'POST /scrape': 'Trigger a scrape. Optional body: { "date": "2/5/2026" }',
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
  log.info(`  GET  http://localhost:${serverConfig.port}/health  — Status check`);
  log.info(`  POST http://localhost:${serverConfig.port}/scrape  — Trigger scrape`);
  log.info('');
  log.info('n8n HTTP Request node settings:');
  log.info(`  URL:     http://your-server-ip:${serverConfig.port}/scrape`);
  log.info('  Method:  POST');
  log.info('  Timeout: 300 seconds (CAPTCHA solving takes 1-3 minutes)');
  log.info('  Body:    { "date": "2/5/2026" }  (optional — omit for today)');
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
