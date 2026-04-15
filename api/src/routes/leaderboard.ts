import { Hono } from "hono";
import {
  getAuraLeaderboard,
  getRepLeaderboard,
  getRepLeaderboardByCategory,
} from "../db.ts";

export const leaderboardRoutes = new Hono();

const CATEGORY_NAMES = ["research", "builder", "trader", "liquidity", "governance", "community"];

// GET /api/leaderboard/aura?limit=50&offset=0
leaderboardRoutes.get("/aura", async (c) => {
  const limit = Math.min(parseInt(c.req.query("limit") ?? "50"), 200);
  const offset = parseInt(c.req.query("offset") ?? "0");

  const rows = await getAuraLeaderboard(limit, offset);
  return c.json({
    data: rows.map((r, i) => ({
      rank: offset + i + 1,
      profileId: r.profileId,
      username: r.username,
      primaryWallet: r.primaryWallet,
      linkedWallet: r.linkedWallet ?? null,
      aura: r.aura,
      epochNumber: r.epochNumber,
      saleDetected: r.saleDetected,
    })),
    meta: { limit, offset },
  });
});

// GET /api/leaderboard/rep?limit=50&offset=0&category=all
leaderboardRoutes.get("/rep", async (c) => {
  const limit = Math.min(parseInt(c.req.query("limit") ?? "50"), 200);
  const offset = parseInt(c.req.query("offset") ?? "0");
  const categoryParam = c.req.query("category");

  if (categoryParam && categoryParam !== "all") {
    const catIndex = CATEGORY_NAMES.indexOf(categoryParam.toLowerCase());
    if (catIndex === -1) {
      return c.json({ error: `Invalid category. Valid: ${CATEGORY_NAMES.join(", ")} or all` }, 400);
    }
    const rows = await getRepLeaderboardByCategory(catIndex, limit, offset);
    return c.json({
      data: rows.map((r, i) => ({
        rank: offset + i + 1,
        profileId: r.profileId,
        username: r.username,
        primaryWallet: r.primaryWallet,
        total: r.total,
        category: categoryParam,
      })),
      meta: { limit, offset, category: categoryParam },
    });
  }

  const rows = await getRepLeaderboard(limit, offset);
  return c.json({
    data: rows.map((r, i) => ({
      rank: offset + i + 1,
      profileId: r.profileId,
      username: r.username,
      primaryWallet: r.primaryWallet,
      totalPositiveRep: r.totalPositiveRep,
      netRep: r.netRep,
    })),
    meta: { limit, offset, category: "all" },
  });
});
