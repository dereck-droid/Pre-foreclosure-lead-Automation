/**
 * CONVEX LOGGER
 *
 * Cloud-backed logging for scrape run attempts.
 * Uses ConvexHttpClient (no WebSocket) — appropriate for a Node.js scraper.
 *
 * makeFunctionReference is used instead of the generated `api` object so this
 * file compiles before `npx convex dev` has been run for the first time.
 */

import { ConvexHttpClient } from "convex/browser";
import { makeFunctionReference } from "convex/server";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ConvexRunId = string;

export interface ConvexStats {
  total_runs: number;
  last_successful_run: string | null;
  consecutive_failures: number;
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

function getClient(): ConvexHttpClient {
  const url = process.env.CONVEX_URL;
  if (!url) {
    throw new Error(
      "CONVEX_URL is not set. Add it to your .env file (run `npx convex dev` to get the URL)."
    );
  }
  return new ConvexHttpClient(url);
}

// ---------------------------------------------------------------------------
// Function references (avoids dependency on convex/_generated/api)
// ---------------------------------------------------------------------------

const fns = {
  startRun: makeFunctionReference<"mutation">("scrapeRuns:startRun"),
  completeRun: makeFunctionReference<"mutation">("scrapeRuns:completeRun"),
  getConsecutiveFailures: makeFunctionReference<"query">(
    "scrapeRuns:getConsecutiveFailures"
  ),
  getStats: makeFunctionReference<"query">("scrapeRuns:getStats"),
};

// ---------------------------------------------------------------------------
// Exported helpers — called from src/index.ts and src/server.ts
// ---------------------------------------------------------------------------

/** Create a "running" record in Convex. Returns the document ID. */
export async function startRun(): Promise<ConvexRunId> {
  const client = getClient();
  return (await client.mutation(fns.startRun, {})) as ConvexRunId;
}

/** Finalize a run record with results. */
export async function completeRun(
  runId: ConvexRunId,
  status: "success" | "failed",
  dateSearched: string,
  totalOnSite: number,
  newFilings: number,
  alreadySeen: number,
  durationSeconds: number,
  error?: string,
  errorStep?: string
): Promise<void> {
  const client = getClient();
  await client.mutation(fns.completeRun, {
    runId,
    status,
    dateSearched,
    totalOnSite,
    newFilings,
    alreadySeen,
    durationSeconds,
    ...(error !== undefined && { error }),
    ...(errorStep !== undefined && { errorStep }),
  });
}

/** Count consecutive failed runs (most recent first). */
export async function getConsecutiveFailures(): Promise<number> {
  const client = getClient();
  return (await client.query(fns.getConsecutiveFailures, {})) as number;
}

/** Aggregate stats for the /health endpoint. */
export async function getStats(): Promise<ConvexStats> {
  const client = getClient();
  return (await client.query(fns.getStats, {})) as ConvexStats;
}
