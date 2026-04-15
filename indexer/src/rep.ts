/**
 * rep.ts — REP event validation and aggregation.
 *
 * Validation rules (enforced by the indexer, not onchain):
 *  1. Giver must have ≥ 1 Aura (1e18 scaled) in the most recent snapshot.
 *  2. The giver's cumulative abs(REP given) must not exceed their current Aura
 *     (each Aura point can be used to assign REP once, in total across all grants).
 *  3. Self-REP (from == to) is rejected (already blocked onchain, belt-and-suspenders).
 *
 * REP totals are net values — positive and negative REP stack.
 * Negative REP is how givers offset prior positive grants.
 */

import type {
  Profile,
  AuraSnapshot,
  RepEvent,
  RepTotals,
} from "./types.ts";
import { REP_CATEGORIES, CATEGORY_INDEX } from "./types.ts";
import { MIN_AURA_TO_GIVE_REP } from "./config.ts";
import {
  getRepAllowance,
  upsertRepAllowance,
  markRepEventCounted,
  upsertRepGraph,
} from "./db.ts";

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Validate and filter REP events against current Aura state.
 * Returns only the events that should count toward REP totals.
 *
 * @param events        All raw REP events (new events this epoch or full history).
 * @param auraSnapshots Current epoch's Aura snapshots, keyed by primary wallet (lowercase).
 * @param profilesByWallet Map from any wallet address (lowercase) → profile.
 */
export async function validateAndFilterRepEvents(
  events: RepEvent[],
  auraSnapshots: Map<string, AuraSnapshot>,
  profilesByWallet: Map<string, Profile>
): Promise<RepEvent[]> {
  // We process events chronologically. For each giver, track how much REP they've spent
  // cumulatively (against their Aura allowance).
  const repSpentThisRun = new Map<number, bigint>(); // profileId -> abs(REP) spent so far

  const accepted: RepEvent[] = [];

  for (const event of events) {
    const fromLower = event.fromAddress.toLowerCase();
    const toLower = event.toAddress.toLowerCase();

    // Belt-and-suspenders: reject self-rep.
    if (fromLower === toLower) {
      await markRepEventCounted(event.txHash, event.logIndex, false, "self-rep");
      continue;
    }

    // Resolve giver to a profile.
    const giverProfile = profilesByWallet.get(fromLower);
    if (!giverProfile) {
      await markRepEventCounted(event.txHash, event.logIndex, false, "giver-not-registered");
      continue;
    }

    // Resolve recipient to a profile.
    const recipientProfile = profilesByWallet.get(toLower);
    if (!recipientProfile) {
      await markRepEventCounted(event.txHash, event.logIndex, false, "recipient-not-registered");
      continue;
    }

    // Get giver's Aura from the most recent snapshot.
    const giverAura =
      auraSnapshots.get(giverProfile.primaryWallet.toLowerCase())?.aura ??
      auraSnapshots.get(fromLower)?.aura ??
      0n;

    // Minimum Aura check.
    if (giverAura < MIN_AURA_TO_GIVE_REP) {
      await markRepEventCounted(
        event.txHash,
        event.logIndex,
        false,
        `insufficient-aura:${giverAura}`
      );
      continue;
    }

    // Allowance check: abs(REP given historically) + abs(this event) ≤ current Aura.
    const { repSpent: historicalSpent } = await getRepAllowance(giverProfile.id);
    const runningSpent = repSpentThisRun.get(giverProfile.id) ?? 0n;
    const totalSpent = historicalSpent + runningSpent;
    const eventCost = event.amount < 0n ? -event.amount : event.amount;

    if (totalSpent + eventCost > giverAura / 1_000_000_000_000_000_000n) {
      // giverAura is 1e18-scaled; allowance is integer REP units.
      await markRepEventCounted(
        event.txHash,
        event.logIndex,
        false,
        `allowance-exceeded:aura=${giverAura},spent=${totalSpent},cost=${eventCost}`
      );
      continue;
    }

    // Accept the event.
    repSpentThisRun.set(
      giverProfile.id,
      runningSpent + eventCost
    );
    await markRepEventCounted(event.txHash, event.logIndex, true, undefined);
    accepted.push(event);
  }

  return accepted;
}

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

/**
 * Given a set of accepted REP events, build the per-profile REP totals.
 * This replaces (not increments) the stored totals — it computes from scratch
 * using all historical accepted events.
 */
export function aggregateRepTotals(
  acceptedEvents: RepEvent[],
  profiles: Profile[]
): RepTotals[] {
  const profileById = new Map<number, Profile>(profiles.map((p) => [p.id, p]));
  const profileByWallet = buildWalletMap(profiles);

  // Accumulate totals per (profileId, category).
  const totals = new Map<string, bigint>(); // key: `${profileId}:${category}`

  for (const event of acceptedEvents) {
    const recipient = profileByWallet.get(event.toAddress.toLowerCase());
    if (!recipient) continue;

    const key = `${recipient.id}:${event.category}`;
    totals.set(key, (totals.get(key) ?? 0n) + event.amount);
  }

  // Build output objects for every profile (defaulting missing categories to 0).
  return profiles.map((p) => ({
    profileId: p.id,
    research: totals.get(`${p.id}:0`) ?? 0n,
    builder: totals.get(`${p.id}:1`) ?? 0n,
    trader: totals.get(`${p.id}:2`) ?? 0n,
    liquidity: totals.get(`${p.id}:3`) ?? 0n,
    governance: totals.get(`${p.id}:4`) ?? 0n,
    community: totals.get(`${p.id}:5`) ?? 0n,
  }));
}

// ---------------------------------------------------------------------------
// REP graph update
// ---------------------------------------------------------------------------

/**
 * Recompute and persist the directional REP graph from all accepted events.
 */
export async function rebuildRepGraph(
  acceptedEvents: RepEvent[],
  profiles: Profile[]
): Promise<void> {
  const profileByWallet = buildWalletMap(profiles);

  type GraphKey = string;
  const graph = new Map<
    GraphKey,
    { net: bigint; count: number; lastAt: Date }
  >();

  for (const event of acceptedEvents) {
    const giver = profileByWallet.get(event.fromAddress.toLowerCase());
    const recipient = profileByWallet.get(event.toAddress.toLowerCase());
    if (!giver || !recipient) continue;

    const key = `${giver.id}:${recipient.id}:${event.category}`;
    const current = graph.get(key) ?? { net: 0n, count: 0, lastAt: new Date(0) };
    graph.set(key, {
      net: current.net + event.amount,
      count: current.count + 1,
      lastAt:
        event.blockTimestamp > current.lastAt ? event.blockTimestamp : current.lastAt,
    });
  }

  for (const [key, data] of graph) {
    const [fromId, toId, category] = key.split(":").map(Number);
    await upsertRepGraph(fromId!, toId!, category!, data.net, data.count, data.lastAt);
  }
}

// ---------------------------------------------------------------------------
// Allowance persistence
// ---------------------------------------------------------------------------

/**
 * Persist updated REP allowances after processing a new batch of events.
 */
export async function persistRepAllowances(
  acceptedEvents: RepEvent[],
  auraSnapshots: Map<string, AuraSnapshot>,
  profiles: Profile[]
): Promise<void> {
  const profileByWallet = buildWalletMap(profiles);

  // Sum abs(amount) per giver from the accepted events.
  const spentThisBatch = new Map<number, bigint>();
  for (const event of acceptedEvents) {
    const giver = profileByWallet.get(event.fromAddress.toLowerCase());
    if (!giver) continue;
    const cost = event.amount < 0n ? -event.amount : event.amount;
    spentThisBatch.set(giver.id, (spentThisBatch.get(giver.id) ?? 0n) + cost);
  }

  for (const [profileId, newSpent] of spentThisBatch) {
    const { repSpent: existing } = await getRepAllowance(profileId);
    const profile = profiles.find((p) => p.id === profileId);
    if (!profile) continue;
    const aura =
      auraSnapshots.get(profile.primaryWallet.toLowerCase())?.aura ?? 0n;
    await upsertRepAllowance(profileId, aura, existing + newSpent);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildWalletMap(profiles: Profile[]): Map<string, Profile> {
  const m = new Map<string, Profile>();
  for (const p of profiles) {
    m.set(p.primaryWallet.toLowerCase(), p);
    if (p.linkedWallet) m.set(p.linkedWallet.toLowerCase(), p);
  }
  return m;
}
