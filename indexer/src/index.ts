/**
 * index.ts — Entry point for the Project Unity snapshot pipeline.
 *
 * Modes:
 *  - Default: runs the pipeline on a fixed EPOCH_DURATION_MS interval.
 *  - --once flag: runs a single epoch then exits (useful for cron / CI).
 *
 * Usage:
 *   bun run src/index.ts          # continuous scheduler
 *   bun run src/index.ts --once   # single run
 */

import { mkdir } from "node:fs/promises";
import { runPipeline } from "./pipeline.ts";
import { getState, setState } from "./db.ts";
import { EPOCH_DURATION_MS } from "./config.ts";

const RUN_ONCE = process.argv.includes("--once");

async function getNextEpochNumber(): Promise<bigint> {
  const last = await getState("last_epoch");
  return BigInt(last ?? "0") + 1n;
}

async function main() {
  // Ensure artifacts directory exists.
  await mkdir("./artifacts", { recursive: true });

  console.log("[indexer] Project Unity snapshot pipeline starting...");
  console.log(`[indexer] Epoch duration: ${EPOCH_DURATION_MS / 1000}s`);
  console.log(`[indexer] Mode: ${RUN_ONCE ? "single run" : "continuous"}`);

  if (RUN_ONCE) {
    const epoch = await getNextEpochNumber();
    await runPipeline(epoch);
    process.exit(0);
  }

  // Continuous mode: run at the start, then on a fixed interval.
  const runWithErrorHandling = async () => {
    try {
      const epoch = await getNextEpochNumber();
      await runPipeline(epoch);
    } catch (err) {
      console.error("[indexer] Pipeline error:", err);
      // Continue to next epoch despite error — don't crash the scheduler.
    }
  };

  await runWithErrorHandling();
  setInterval(runWithErrorHandling, EPOCH_DURATION_MS);
}

main().catch((err) => {
  console.error("[indexer] Fatal startup error:", err);
  process.exit(1);
});
