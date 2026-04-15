import { Hono } from "hono";
import { getCurrentEpoch, getEpochByNumber, listEpochs, getEpochChallengeSummary } from "../db.ts";

export const epochRoutes = new Hono();

// GET /api/epochs/current
epochRoutes.get("/current", async (c) => {
  const epoch = await getCurrentEpoch();
  if (!epoch) return c.json({ error: "No epochs posted yet" }, 404);
  return c.json(epoch);
});

// GET /api/epochs — list recent epochs
epochRoutes.get("/", async (c) => {
  const limit = Math.min(parseInt(c.req.query("limit") ?? "20"), 100);
  const offset = parseInt(c.req.query("offset") ?? "0");
  const epochs = await listEpochs(limit, offset);
  return c.json({ data: epochs, meta: { limit, offset } });
});

// GET /api/epochs/:number
epochRoutes.get("/:number", async (c) => {
  const num = parseInt(c.req.param("number"));
  if (isNaN(num)) return c.json({ error: "Invalid epoch number" }, 400);

  const epoch = await getEpochByNumber(num);
  if (!epoch) return c.json({ error: "Epoch not found" }, 404);

  return c.json(epoch);
});

// GET /api/epochs/:number/challenges
// Returns challenge summary counts (pending/accepted/rejected) for an epoch.
epochRoutes.get("/:number/challenges", async (c) => {
  const num = parseInt(c.req.param("number"));
  if (isNaN(num)) return c.json({ error: "Invalid epoch number" }, 400);

  const summary = await getEpochChallengeSummary(num);
  if (!summary) return c.json({ error: "Epoch not found" }, 404);

  return c.json(summary);
});
