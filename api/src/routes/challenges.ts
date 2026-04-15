/**
 * routes/challenges.ts — Challenge system endpoints.
 *
 * Routes (mounted under /api/challenges):
 *   GET /            — list challenges (filterable by status, epoch)
 *   GET /:id         — single challenge by onchain challengeId
 */

import { Hono } from "hono";
import { listChallenges, getChallengeById } from "../db.ts";

export const challengeRoutes = new Hono();

// ---------------------------------------------------------------------------
// GET /api/challenges
// ---------------------------------------------------------------------------
// Query params:
//   status  — filter by status: pending | accepted | rejected
//   epoch   — filter by epoch number
//   limit   — max results (default 50, max 200)
//   offset  — pagination offset (default 0)

challengeRoutes.get("/", async (c) => {
  const status = c.req.query("status");
  const epochRaw = c.req.query("epoch");
  const limitRaw = c.req.query("limit");
  const offsetRaw = c.req.query("offset");

  if (status && !["pending", "accepted", "rejected"].includes(status)) {
    return c.json({ error: "status must be one of: pending, accepted, rejected" }, 400);
  }

  const epochNumber = epochRaw !== undefined ? parseInt(epochRaw, 10) : undefined;
  if (epochNumber !== undefined && isNaN(epochNumber)) {
    return c.json({ error: "epoch must be an integer" }, 400);
  }

  const limit = Math.min(parseInt(limitRaw ?? "50", 10) || 50, 200);
  const offset = parseInt(offsetRaw ?? "0", 10) || 0;

  const rows = await listChallenges({ status, epochNumber, limit, offset });
  return c.json({ challenges: rows });
});

// ---------------------------------------------------------------------------
// GET /api/challenges/:id
// ---------------------------------------------------------------------------

challengeRoutes.get("/:id", async (c) => {
  const idRaw = c.req.param("id");
  const id = parseInt(idRaw, 10);
  if (isNaN(id) || id < 0) {
    return c.json({ error: "id must be a non-negative integer" }, 400);
  }

  const row = await getChallengeById(id);
  if (!row) return c.json({ error: "Challenge not found" }, 404);
  return c.json(row);
});
