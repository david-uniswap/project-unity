/**
 * api/src/index.ts — Project Unity REST API.
 *
 * Built with Hono on Bun. All data is read-only from Postgres.
 * The indexer (separate process) writes all state.
 *
 * Base URL: http://localhost:3001
 *
 * Routes:
 *   GET /api/leaderboard/aura
 *   GET /api/leaderboard/rep
 *   GET /api/profiles/search?q=...
 *   GET /api/profiles/:identifier
 *   GET /api/profiles/:identifier/proof
 *   GET /api/epochs/current
 *   GET /api/epochs
 *   GET /api/epochs/:number
 *   GET /api/rep/events
 *   GET /api/rep/graph
 *   GET /api/health
 */

import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { timing } from "hono/timing";
import { leaderboardRoutes } from "./routes/leaderboard.ts";
import { profileRoutes } from "./routes/profiles.ts";
import { epochRoutes } from "./routes/epochs.ts";
import { repRoutes } from "./routes/rep.ts";
import { sql } from "./db.ts";

const app = new Hono();

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------

app.use("*", timing());
app.use("*", logger());
app.use(
  "*",
  cors({
    origin: process.env["CORS_ORIGIN"] ?? "*",
    allowMethods: ["GET", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization"],
    maxAge: 60,
  })
);

// ---------------------------------------------------------------------------
// Health check
// ---------------------------------------------------------------------------

app.get("/api/health", async (c) => {
  try {
    await sql`SELECT 1`;
    return c.json({ status: "ok", timestamp: new Date().toISOString() });
  } catch {
    return c.json({ status: "error", message: "Database unreachable" }, 503);
  }
});

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

app.route("/api/leaderboard", leaderboardRoutes);
app.route("/api/profiles", profileRoutes);
app.route("/api/epochs", epochRoutes);
app.route("/api/rep", repRoutes);

// ---------------------------------------------------------------------------
// 404 fallback
// ---------------------------------------------------------------------------

app.notFound((c) => c.json({ error: "Not found" }, 404));

app.onError((err, c) => {
  console.error("[api] Unhandled error:", err);
  return c.json({ error: "Internal server error" }, 500);
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

const PORT = parseInt(process.env["PORT"] ?? "3001");

export default {
  port: PORT,
  fetch: app.fetch,
};

console.log(`[api] Project Unity API running on http://localhost:${PORT}`);
