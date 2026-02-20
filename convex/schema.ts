import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  scrapeRuns: defineTable({
    startedAt: v.string(),
    completedAt: v.optional(v.string()),
    status: v.union(
      v.literal("running"),
      v.literal("success"),
      v.literal("failed")
    ),
    dateSearched: v.optional(v.string()),
    totalOnSite: v.number(),
    newFilings: v.number(),
    alreadySeen: v.number(),
    durationSeconds: v.optional(v.number()),
    error: v.optional(v.string()),
    errorStep: v.optional(v.string()),
  })
    .index("by_startedAt", ["startedAt"])
    .index("by_status_startedAt", ["status", "startedAt"]),
});
