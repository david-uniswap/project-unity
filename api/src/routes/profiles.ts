import { Hono } from "hono";
import {
  getProfileByUsername,
  getProfileByWallet,
  getProfileRepBreakdown,
  getProfileAuraHistory,
  getMerkleProof,
  searchProfiles,
} from "../db.ts";

export const profileRoutes = new Hono();

const CATEGORY_NAMES = ["research", "builder", "trader", "liquidity", "governance", "community"];

// Resolve identifier → profile (username or 0x address).
async function resolveProfile(identifier: string) {
  if (identifier.startsWith("0x") && identifier.length === 42) {
    return getProfileByWallet(identifier);
  }
  return getProfileByUsername(identifier);
}

// GET /api/profiles/:identifier
// :identifier = username or wallet address (0x...)
profileRoutes.get("/:identifier", async (c) => {
  const identifier = c.req.param("identifier");
  const profile = await resolveProfile(identifier);

  if (!profile) {
    return c.json({ error: "Profile not found" }, 404);
  }

  const [repBreakdown, auraHistory] = await Promise.all([
    getProfileRepBreakdown(profile.id),
    getProfileAuraHistory(profile.id, 10),
  ]);

  const repByCategory = Object.fromEntries(
    repBreakdown.map((r: { category: number; total: string }) => [
      CATEGORY_NAMES[r.category] ?? r.category,
      r.total,
    ])
  );

  return c.json({
    id: profile.id,
    username: profile.username,
    primaryWallet: profile.primaryWallet,
    linkedWallet: profile.linkedWallet ?? null,
    createdAt: profile.createdAt,
    aura: profile.aura ?? "0",
    epochNumber: profile.epochNumber ?? null,
    saleDetected: profile.saleDetected ?? false,
    repByCategory,
    recentAuraHistory: auraHistory,
  });
});

// GET /api/profiles/:identifier/proof?epoch=<n>
profileRoutes.get("/:identifier/proof", async (c) => {
  const identifier = c.req.param("identifier");
  const epochParam = c.req.query("epoch");

  const profile = await resolveProfile(identifier);
  if (!profile) return c.json({ error: "Profile not found" }, 404);

  const epochNumber = epochParam ? parseInt(epochParam) : undefined;
  const proof = await getMerkleProof(profile.id, epochNumber);

  if (!proof) {
    return c.json({ error: "No proof found for this profile/epoch" }, 404);
  }

  return c.json({
    profileId: profile.id,
    username: profile.username,
    epochNumber: proof.epochNumber ?? epochNumber,
    leaf: proof.leaf,
    proof: proof.proof,
  });
});

// GET /api/profiles/search?q=<query>&limit=10
profileRoutes.get("/search", async (c) => {
  const query = c.req.query("q") ?? "";
  if (query.length < 1) return c.json({ data: [] });

  const limit = Math.min(parseInt(c.req.query("limit") ?? "10"), 50);
  const results = await searchProfiles(query, limit);
  return c.json({ data: results });
});
