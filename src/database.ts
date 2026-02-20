import Database from 'better-sqlite3';
import fs from 'fs';
import { paths } from './config.js';
import { log } from './logger.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
/** A single Lis Pendens filing as scraped from the county website */
export interface Filing {
  document_number: string;
  document_type: string;
  recording_date: string;
  grantor_name: string;      // Who filed (usually a bank, lender, or HOA)
  grantee_name: string;      // The property owner(s) — this is the lead
  legal_description: string; // Property info like "Lot: 7 RIDGEMOORE PHASE ONE"
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

  db.exec(`
    CREATE TABLE IF NOT EXISTS filings (
      document_number   TEXT PRIMARY KEY,
      document_type     TEXT NOT NULL,
      recording_date    TEXT NOT NULL,
      grantor_name      TEXT DEFAULT '',
      grantee_name      TEXT NOT NULL,
      legal_description TEXT DEFAULT '',
      created_at        TEXT DEFAULT (datetime('now'))
    );
  `);

  log.info('Database initialized', { path: paths.database });
}

// ---------------------------------------------------------------------------
// Filing operations
// ---------------------------------------------------------------------------

/** Insert new filings, skipping any that already exist. Returns only the NEW ones. */
export function insertNewFilings(filings: Filing[]): Filing[] {
  const insert = db.prepare(`
    INSERT OR IGNORE INTO filings
      (document_number, document_type, recording_date, grantor_name, grantee_name, legal_description)
    VALUES
      (@document_number, @document_type, @recording_date, @grantor_name, @grantee_name, @legal_description)
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

/** Get the count of all known filings for the /health endpoint */
export function getFilingCount(): number {
  const row = db.prepare('SELECT COUNT(*) as count FROM filings').get() as any;
  return row?.count || 0;
}

/** Close the database connection */
export function closeDatabase(): void {
  if (db) {
    db.close();
    log.info('Database connection closed');
  }
}
