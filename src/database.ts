import Database from 'better-sqlite3';
import fs from 'fs';
import { paths } from './config.js';
import { log } from './logger.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
export interface Filing {
  document_number: string;
  document_type: string;
  recording_date: string;
  grantee_name: string;
  property_address: string;
}

export interface EnrichedFiling extends Filing {
  phones: string[];
  emails: string[];
  mailing_address: string;
  skip_trace_status: 'pending' | 'success' | 'failed';
  crm_status: 'pending' | 'pushed' | 'failed';
}

export interface RunLog {
  id?: number;
  started_at: string;
  completed_at?: string;
  status: 'running' | 'success' | 'failed';
  total_scraped: number;
  new_filings: number;
  errors: string;
}

// ---------------------------------------------------------------------------
// Database initialization
// ---------------------------------------------------------------------------
let db: Database.Database;

export function initDatabase(): void {
  // Ensure data directory exists
  fs.mkdirSync(paths.data, { recursive: true });

  db = new Database(paths.database);

  // Enable WAL mode for better concurrent access
  db.pragma('journal_mode = WAL');

  // Create tables
  db.exec(`
    CREATE TABLE IF NOT EXISTS filings (
      document_number TEXT PRIMARY KEY,
      document_type   TEXT NOT NULL,
      recording_date  TEXT NOT NULL,
      grantee_name    TEXT NOT NULL,
      property_address TEXT DEFAULT '',
      phones          TEXT DEFAULT '[]',
      emails          TEXT DEFAULT '[]',
      mailing_address TEXT DEFAULT '',
      skip_trace_status TEXT DEFAULT 'pending',
      crm_status      TEXT DEFAULT 'pending',
      created_at      TEXT DEFAULT (datetime('now')),
      updated_at      TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS run_log (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      started_at    TEXT NOT NULL,
      completed_at  TEXT,
      status        TEXT NOT NULL DEFAULT 'running',
      total_scraped INTEGER DEFAULT 0,
      new_filings   INTEGER DEFAULT 0,
      errors        TEXT DEFAULT '[]'
    );
  `);

  log.info('Database initialized', { path: paths.database });
}

// ---------------------------------------------------------------------------
// Filing operations
// ---------------------------------------------------------------------------

/** Check if a filing already exists in our database */
export function filingExists(documentNumber: string): boolean {
  const row = db.prepare(
    'SELECT 1 FROM filings WHERE document_number = ?'
  ).get(documentNumber);
  return !!row;
}

/** Insert new filings, skipping any that already exist. Returns only the NEW ones. */
export function insertNewFilings(filings: Filing[]): Filing[] {
  const insert = db.prepare(`
    INSERT OR IGNORE INTO filings (document_number, document_type, recording_date, grantee_name, property_address)
    VALUES (@document_number, @document_type, @recording_date, @grantee_name, @property_address)
  `);

  const newFilings: Filing[] = [];

  const transaction = db.transaction((items: Filing[]) => {
    for (const filing of items) {
      const result = insert.run(filing);
      if (result.changes > 0) {
        newFilings.push(filing);
      }
    }
  });

  transaction(filings);
  return newFilings;
}

/** Update a filing with skip trace results */
export function updateSkipTrace(
  documentNumber: string,
  phones: string[],
  emails: string[],
  mailingAddress: string,
  status: 'success' | 'failed'
): void {
  db.prepare(`
    UPDATE filings
    SET phones = ?, emails = ?, mailing_address = ?, skip_trace_status = ?, updated_at = datetime('now')
    WHERE document_number = ?
  `).run(
    JSON.stringify(phones),
    JSON.stringify(emails),
    mailingAddress,
    status,
    documentNumber
  );
}

/** Mark a filing as pushed to CRM */
export function updateCrmStatus(
  documentNumber: string,
  status: 'pushed' | 'failed'
): void {
  db.prepare(`
    UPDATE filings SET crm_status = ?, updated_at = datetime('now') WHERE document_number = ?
  `).run(status, documentNumber);
}

/** Get a filing with all enriched data */
export function getFiling(documentNumber: string): EnrichedFiling | undefined {
  const row = db.prepare('SELECT * FROM filings WHERE document_number = ?').get(documentNumber) as any;
  if (!row) return undefined;
  return {
    ...row,
    phones: JSON.parse(row.phones || '[]'),
    emails: JSON.parse(row.emails || '[]'),
  };
}

/** Get all filings that need skip tracing */
export function getFilingsPendingSkipTrace(): Filing[] {
  return db.prepare(
    "SELECT * FROM filings WHERE skip_trace_status = 'pending'"
  ).all() as Filing[];
}

/** Get all filings that need CRM push */
export function getFilingsPendingCrm(): EnrichedFiling[] {
  const rows = db.prepare(
    "SELECT * FROM filings WHERE crm_status = 'pending' AND skip_trace_status IN ('success', 'failed')"
  ).all() as any[];
  return rows.map(row => ({
    ...row,
    phones: JSON.parse(row.phones || '[]'),
    emails: JSON.parse(row.emails || '[]'),
  }));
}

// ---------------------------------------------------------------------------
// Run log operations
// ---------------------------------------------------------------------------

/** Start a new run log entry */
export function startRun(): number {
  const result = db.prepare(`
    INSERT INTO run_log (started_at, status) VALUES (datetime('now'), 'running')
  `).run();
  return Number(result.lastInsertRowid);
}

/** Complete a run log entry */
export function completeRun(
  runId: number,
  status: 'success' | 'failed',
  totalScraped: number,
  newFilings: number,
  errors: string[]
): void {
  db.prepare(`
    UPDATE run_log
    SET completed_at = datetime('now'), status = ?, total_scraped = ?, new_filings = ?, errors = ?
    WHERE id = ?
  `).run(status, totalScraped, newFilings, JSON.stringify(errors), runId);
}

/** Get the last successful run timestamp */
export function getLastSuccessfulRun(): string | null {
  const row = db.prepare(
    "SELECT completed_at FROM run_log WHERE status = 'success' ORDER BY id DESC LIMIT 1"
  ).get() as any;
  return row?.completed_at || null;
}

/** Get count of consecutive failed runs */
export function getConsecutiveFailures(): number {
  const rows = db.prepare(
    'SELECT status FROM run_log ORDER BY id DESC LIMIT 10'
  ).all() as any[];
  let count = 0;
  for (const row of rows) {
    if (row.status === 'failed') count++;
    else break;
  }
  return count;
}

/** Close the database connection */
export function closeDatabase(): void {
  if (db) {
    db.close();
    log.info('Database connection closed');
  }
}
