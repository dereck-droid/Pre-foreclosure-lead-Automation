import { mutation, query } from "./_generated/server";
import { v } from "convex/values";

/** Create a new run record with status "running". Returns the document ID. */
export const startRun = mutation({
  args: {},
  handler: async (ctx) => {
    return await ctx.db.insert("scrapeRuns", {
      startedAt: new Date().toISOString(),
      status: "running",
      totalOnSite: 0,
      newFilings: 0,
      alreadySeen: 0,
    });
  },
});

/** Update a run record with the final results. */
export const completeRun = mutation({
  args: {
    runId: v.id("scrapeRuns"),
    status: v.union(v.literal("success"), v.literal("failed")),
    dateSearched: v.string(),
    totalOnSite: v.number(),
    newFilings: v.number(),
    alreadySeen: v.number(),
    durationSeconds: v.number(),
    error: v.optional(v.string()),
    errorStep: v.optional(v.string()),
  },
  handler: async (ctx, { runId, ...fields }) => {
    await ctx.db.patch(runId, {
      completedAt: new Date().toISOString(),
      ...fields,
    });
  },
});

/**
 * Count how many of the most recent runs are consecutive failures.
 * Used to alert when the scraper is repeatedly broken.
 */
export const getConsecutiveFailures = query({
  args: {},
  handler: async (ctx) => {
    const recentRuns = await ctx.db
      .query("scrapeRuns")
      .withIndex("by_startedAt")
      .order("desc")
      .take(10);

    let count = 0;
    for (const run of recentRuns) {
      if (run.status === "failed") count++;
      else break;
    }
    return count;
  },
});

/** Aggregate stats for the /health endpoint. */
export const getStats = query({
  args: {},
  handler: async (ctx) => {
    const allRuns = await ctx.db.query("scrapeRuns").collect();
    const totalRuns = allRuns.length;

    const recentRuns = await ctx.db
      .query("scrapeRuns")
      .withIndex("by_startedAt")
      .order("desc")
      .take(10);

    let consecutiveFailures = 0;
    for (const run of recentRuns) {
      if (run.status === "failed") consecutiveFailures++;
      else break;
    }

    const lastSuccessful = await ctx.db
      .query("scrapeRuns")
      .withIndex("by_status_startedAt", (q) => q.eq("status", "success"))
      .order("desc")
      .first();

    return {
      total_runs: totalRuns,
      last_successful_run: lastSuccessful?.completedAt ?? null,
      consecutive_failures: consecutiveFailures,
    };
  },
});

/** Return the N most recent runs for dashboard inspection. */
export const getRecentRuns = query({
  args: {
    limit: v.optional(v.number()),
  },
  handler: async (ctx, { limit = 20 }) => {
    return await ctx.db
      .query("scrapeRuns")
      .withIndex("by_startedAt")
      .order("desc")
      .take(limit);
  },
});
