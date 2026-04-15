import { Hono } from "hono";
import { listRepEvents, getRepGraph } from "../db.ts";

export const repRoutes = new Hono();

const CATEGORY_NAMES = ["research", "builder", "trader", "liquidity", "governance", "community"];

// GET /api/rep/events?from=0x...&to=0x...&category=builder&limit=50&counted=true
repRoutes.get("/events", async (c) => {
  const from = c.req.query("from");
  const to = c.req.query("to");
  const categoryParam = c.req.query("category");
  const limit = Math.min(parseInt(c.req.query("limit") ?? "50"), 200);
  const offset = parseInt(c.req.query("offset") ?? "0");
  const countedOnly = c.req.query("counted") !== "false";

  let category: number | undefined;
  if (categoryParam) {
    const idx = CATEGORY_NAMES.indexOf(categoryParam.toLowerCase());
    if (idx === -1) {
      return c.json(
        { error: `Invalid category. Valid: ${CATEGORY_NAMES.join(", ")}` },
        400
      );
    }
    category = idx;
  }

  const events = await listRepEvents({ from, to, category, limit, offset, countedOnly });
  return c.json({
    data: events.map((e: {
      id: number;
      fromAddress: string;
      toAddress: string;
      category: number;
      amount: string;
      txHash: string;
      blockNumber: string;
      blockTimestamp: string;
      counted: boolean;
      rejectionReason: string | null;
    }) => ({
      ...e,
      categoryName: CATEGORY_NAMES[e.category] ?? "unknown",
    })),
    meta: { limit, offset, countedOnly },
  });
});

// GET /api/rep/graph?profile=0x...&category=research&minAmount=1
repRoutes.get("/graph", async (c) => {
  const profileParam = c.req.query("profile");
  const categoryParam = c.req.query("category");
  const minAmount = parseInt(c.req.query("minAmount") ?? "0");

  // Resolve profile ID from wallet address.
  let profileId: number | undefined;
  if (profileParam) {
    // We'd need a profile lookup here — for now accept numeric IDs directly.
    const asNum = parseInt(profileParam);
    if (!isNaN(asNum)) profileId = asNum;
  }

  let category: number | undefined;
  if (categoryParam) {
    const idx = CATEGORY_NAMES.indexOf(categoryParam.toLowerCase());
    if (idx !== -1) category = idx;
  }

  const edges = await getRepGraph({ profileId, category, minAmount });
  return c.json({
    data: edges.map((e: {
      fromProfileId: number;
      fromUsername: string;
      fromWallet: string;
      toProfileId: number;
      toUsername: string;
      toWallet: string;
      category: number;
      netAmount: string;
      eventCount: number;
      lastEventAt: string;
    }) => ({
      ...e,
      categoryName: CATEGORY_NAMES[e.category] ?? "unknown",
    })),
  });
});
