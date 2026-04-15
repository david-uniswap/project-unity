/**
 * pipeline.ts — The full epoch snapshot pipeline.
 *
 * Runs once per epoch (every 10 minutes by default):
 *  1.  Ingest new ProfileRegistry events → sync profiles to DB.
 *  2.  Ingest new ChallengeRegistry events → sync challenges + Aura bonuses to DB.
 *  3.  Read current UNI + LP balances for all profiles.
 *  4.  Compute Aura (with sale detection, LP 2× boost).
 *  5.  Ingest new RepEmitter events → store in DB.
 *  6.  Validate REP events against Aura allowances.
 *  7.  Aggregate REP totals per profile per category.
 *  8.  Build Merkle tree (leaf Aura = UNI-derived + permanent bonus).
 *  9.  Post root onchain (with datasetHash for third-party verification).
 * 10.  Persist snapshots, proofs, and graph to DB.
 * 11.  Output dataset JSON artifact.
 */

import { writeFile } from "node:fs/promises";
import { keccak256 } from "viem";
import {
  getCurrentBlock,
  getProfileRegistryEvents,
  getRepEvents,
  getChallengeRegistryEvents,
  postRootOnchain,
} from "./blockchain.ts";
import {
  getAllProfiles,
  getLastProcessedBlock,
  getPreviousAuraSnapshot,
  getAllRepEvents,
  insertAuraSnapshots,
  insertEpoch,
  insertRepEvents,
  insertChallenge,
  updateChallengeStatus,
  insertAuraBonus,
  setState,
  upsertMerkleProof,
  upsertProfile,
  upsertRepTotals,
  updateLinkedWallet,
} from "./db.ts";
import { computeAllAuraSnapshots, getTotalAuraForLeaf } from "./aura.ts";
import {
  validateAndFilterRepEvents,
  aggregateRepTotals,
  rebuildRepGraph,
  persistRepAllowances,
} from "./rep.ts";
import {
  buildLeaf,
  buildMerkleTree,
  computeDatasetHash,
  dumpMerkleTree,
  extractProofsForAllProfiles,
} from "./merkle.ts";
import type { Profile, AuraSnapshot, PreviousAura, RepTotals } from "./types.ts";

// ---------------------------------------------------------------------------
// Main pipeline function
// ---------------------------------------------------------------------------

export async function runPipeline(epochNumber: bigint): Promise<void> {
  const startTime = Date.now();
  console.log(`\n[pipeline] ═══ Epoch ${epochNumber} ═══ ${new Date().toISOString()}`);

  // ─── Step 1: Ingest ProfileRegistry events ───────────────────────────────

  const lastBlock = await getLastProcessedBlock();
  const currentBlock = await getCurrentBlock();

  console.log(`[pipeline] Scanning blocks ${lastBlock + 1n} → ${currentBlock}`);

  if (currentBlock > lastBlock) {
    const { registered, linked, unlinked } = await getProfileRegistryEvents(
      lastBlock + 1n,
      currentBlock
    );

    console.log(
      `[pipeline] ProfileRegistry: +${registered.length} names, +${linked.length} links, -${unlinked.length} unlinks`
    );

    for (const reg of registered) {
      await upsertProfile({ username: reg.name, primaryWallet: reg.wallet });
    }
    for (const link of linked) {
      await updateLinkedWallet(link.primary, link.linked);
    }
    for (const unlink of unlinked) {
      await updateLinkedWallet(unlink.primary, null);
    }
  }

  // ─── Step 2: Ingest ChallengeRegistry events ─────────────────────────────

  if (currentBlock > lastBlock) {
    const { submitted, resolved, auraBounties } = await getChallengeRegistryEvents(
      lastBlock + 1n,
      currentBlock
    );

    console.log(
      `[pipeline] ChallengeRegistry: +${submitted.length} submitted, ${resolved.length} resolved, ${auraBounties.length} bounties`
    );

    for (const ev of submitted) {
      await insertChallenge({
        id: ev.challengeId,
        challengerAddress: ev.challenger,
        epochNumber: ev.epochNumber,
        claimedCorrectRoot: ev.claimedCorrectRoot,
        evidenceHash: ev.evidenceHash,
        txHash: ev.txHash,
        blockNumber: ev.blockNumber,
        submittedAt: ev.blockTimestamp,
        status: "pending",
      });
    }

    for (const ev of resolved) {
      await updateChallengeStatus(
        ev.challengeId,
        ev.status,
        ev.blockTimestamp,
        ev.txHash,
        ev.reason
      );
    }

    for (const ev of auraBounties) {
      await insertAuraBonus({
        walletAddress: ev.recipient,
        amount: ev.amount,
        challengeId: ev.challengeId,
        txHash: ev.txHash,
        grantedAt: ev.blockTimestamp,
      });
    }
  }

  // ─── Step 3: Load all profiles ───────────────────────────────────────────

  const profiles = await getAllProfiles();
  console.log(`[pipeline] Profiles: ${profiles.length}`);

  if (profiles.length === 0) {
    console.log("[pipeline] No profiles registered — skipping this epoch.");
    await setState("last_block", currentBlock.toString());
    return;
  }

  // ─── Step 4: Compute Aura ────────────────────────────────────────────────

  // Load previous aura snapshots in parallel.
  const previousAuras = new Map<number, PreviousAura>();
  await Promise.all(
    profiles.map(async (p) => {
      const prev = await getPreviousAuraSnapshot(p.id);
      if (prev) previousAuras.set(p.id, { profileId: p.id, ...prev });
    })
  );

  const auraSnapshots = await computeAllAuraSnapshots(profiles, epochNumber, previousAuras);
  console.log(
    `[pipeline] Aura computed. Sales detected: ${auraSnapshots.filter((s) => s.saleDetected).length}`
  );

  // Build a by-wallet lookup for REP validation (UNI-derived Aura only — bonuses
  // don't affect the REP allowance check, which uses snapshot.aura).
  const auraByWallet = new Map<string, AuraSnapshot>();
  for (const [i, snapshot] of auraSnapshots.entries()) {
    const profile = profiles[i]!;
    auraByWallet.set(profile.primaryWallet.toLowerCase(), snapshot);
    if (profile.linkedWallet) {
      auraByWallet.set(profile.linkedWallet.toLowerCase(), snapshot);
    }
  }

  // ─── Step 5: Ingest REP events ───────────────────────────────────────────

  if (currentBlock > lastBlock) {
    const newRepEvents = await getRepEvents(lastBlock + 1n, currentBlock);
    console.log(`[pipeline] New REP events: ${newRepEvents.length}`);
    await insertRepEvents(newRepEvents);
  }

  // ─── Step 6: Validate REP events ─────────────────────────────────────────

  const allRepEvents = await getAllRepEvents();

  const profileByWallet = new Map<string, Profile>();
  for (const p of profiles) {
    profileByWallet.set(p.primaryWallet.toLowerCase(), p);
    if (p.linkedWallet) profileByWallet.set(p.linkedWallet.toLowerCase(), p);
  }

  const acceptedEvents = await validateAndFilterRepEvents(
    allRepEvents,
    auraByWallet,
    profileByWallet
  );
  console.log(
    `[pipeline] REP events: ${allRepEvents.length} total, ${acceptedEvents.length} accepted`
  );

  // ─── Step 7: Aggregate REP totals ────────────────────────────────────────

  const repTotalsList = aggregateRepTotals(acceptedEvents, profiles);
  await upsertRepTotals(repTotalsList);

  const repTotalsMap = new Map<number, RepTotals>(
    repTotalsList.map((t) => [t.profileId, t])
  );

  // ─── Step 8: Build Merkle tree ───────────────────────────────────────────
  //
  // Each leaf uses TOTAL Aura = UNI-derived (from snapshot) + permanent bonus
  // (from aura_bonuses table). Bonuses are not reset on UNI sales.

  const leaves = await Promise.all(
    profiles.map(async (profile, i) => {
      const snapshot = auraSnapshots[i]!;
      const totals = repTotalsMap.get(profile.id) ?? {
        profileId: profile.id,
        research: 0n,
        builder: 0n,
        trader: 0n,
        liquidity: 0n,
        governance: 0n,
        community: 0n,
      };
      const totalAura = await getTotalAuraForLeaf(profile, snapshot.aura);
      return buildLeaf(epochNumber, profile, totalAura, totals);
    })
  );

  const merkleOutput = buildMerkleTree(leaves);
  console.log(`[pipeline] Merkle root: ${merkleOutput.root} (${leaves.length} leaves)`);

  // ─── Step 9: Post root onchain ───────────────────────────────────────────

  const datasetHash = computeDatasetHash(leaves);
  const configHash = computeConfigHash(epochNumber);

  // datasetHash is posted alongside the root so third parties can independently
  // reconstruct and verify the dataset that produced the tree.
  await postRootOnchain(epochNumber, merkleOutput.root, datasetHash);

  // ─── Step 10: Persist to DB ──────────────────────────────────────────────

  await insertEpoch({
    epochNumber,
    root: merkleOutput.root,
    postedAt: new Date(),
    datasetHash,
    configHash,
    leafCount: leaves.length,
  });

  await insertAuraSnapshots(auraSnapshots);

  const profileEpochData = extractProofsForAllProfiles(
    merkleOutput,
    profiles,
    auraSnapshots,
    repTotalsMap
  );

  for (const data of profileEpochData) {
    await upsertMerkleProof(data.profile.id, epochNumber, data.proof, data.leaf);
  }

  // Update REP graph and allowances.
  await rebuildRepGraph(acceptedEvents, profiles);
  await persistRepAllowances(acceptedEvents, auraByWallet, profiles);

  // Update block checkpoint.
  await setState("last_block", currentBlock.toString());
  await setState("last_epoch", epochNumber.toString());

  // ─── Step 11: Output artifacts ───────────────────────────────────────────

  const artifact = {
    epoch: epochNumber.toString(),
    root: merkleOutput.root,
    datasetHash,
    configHash,
    leafCount: leaves.length,
    generatedAt: new Date().toISOString(),
    profiles: profileEpochData.map((d) => ({
      username: d.profile.username,
      primaryWallet: d.profile.primaryWallet,
      aura: d.aura.toString(),
      repByCategory: Object.fromEntries(
        Object.entries(d.repByCategory).map(([k, v]) => [k, v.toString()])
      ),
      proof: d.proof,
      leaf: d.leaf,
    })),
  };

  await writeFile(
    `./artifacts/epoch-${epochNumber}.json`,
    JSON.stringify(artifact, null, 2)
  ).catch(() => {
    // artifacts dir may not exist on first run — non-fatal.
  });

  // Save the raw Merkle tree dump. Loadable offline with:
  //   StandardMerkleTree.load(JSON.parse(fs.readFileSync("merkle-epoch-N.json")))
  // This lets frontend devs generate proofs without hitting the API.
  const bigintReplacer = (_: string, v: unknown) => typeof v === "bigint" ? v.toString() : v;
  await writeFile(
    `./artifacts/merkle-epoch-${epochNumber}.json`,
    JSON.stringify(dumpMerkleTree(merkleOutput), bigintReplacer, 2)
  ).catch(() => {});

  const elapsed = Date.now() - startTime;
  console.log(`[pipeline] ✓ Epoch ${epochNumber} complete in ${elapsed}ms`);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function computeConfigHash(epoch: bigint): `0x${string}` {
  const config = {
    epoch: epoch.toString(),
    auraRatePerEpoch: (1_000_000_000_000_000_000n / 1_440_000n).toString(),
    epochDurationMs: process.env["EPOCH_DURATION_MS"] ?? "600000",
    fakeUniAddress: process.env["FAKE_UNI_ADDRESS"] ?? "",
    approvedLpPools: process.env["APPROVED_LP_POOLS"] ?? "",
  };
  return keccak256(
    new TextEncoder().encode(JSON.stringify(config))
  ) as `0x${string}`;
}
