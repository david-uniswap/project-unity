/**
 * rep.ts — REP event validation and aggregation.
 *
 * Validation rules (enforced by the indexer, not onchain):
 *  1. Giver must be a registered profile OR a whitelisted protocol address.
 *  2. Recipient must be a registered profile.
 *  3. Registered givers must have ≥ 1 Aura (1e18-scaled) in the most recent snapshot.
 *  4. Registered givers' cumulative abs(REP given) must not exceed their current Aura.
 *
 * Protocol addresses (e.g. ChallengeRegistry) bypass all Aura/allowance checks.
 * They are whitelisted in PROTOCOL_GIVERS from config.
 *
 * REP totals are net (positive and negative REP stack).
 */

import type { Profile, AuraSnapshot, RepEvent, RepTotals } from "./types.ts";
import { REP_CATEGORIES } from "./types.ts";
import { MIN_AURA_TO_GIVE_REP, PROTOCOL_GIVERS, DEBUG } from "./config.ts";
import {
  getRepAllowance,
  upsertRepAllowance,
  markRepEventCounted,
  upsertRepGraph,
} from "./db.ts";

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export async function validateAndFilterRepEvents(
  events: RepEvent[],
  auraSnapshots: Map<string, AuraSnapshot>,
  profilesByWallet: Map<string, Profile>
): Promise<RepEvent[]> {
  const repSpentThisRun = new Map<number, bigint>(); // profileId -> cumulative REP spent
  const accepted: RepEvent[] = [];

  for (const event of events) {
    const fromLower = event.fromAddress.toLowerCase();
    const toLower = event.toAddress.toLowerCase();

    if (DEBUG) {
      console.log(`[rep] event tx=${event.txHash} li=${event.logIndex} from=${fromLower} to=${toLower} cat=${event.category} amount=${event.amount}`);
    }

    // Self-rep is always rejected.
    if (fromLower === toLower) {
      if (DEBUG) console.log(`[rep]   → rejected: self-rep`);
      await markRepEventCounted(event.txHash, event.logIndex, false, "self-rep");
      continue;
    }

    // Recipient must always be a registered profile.
    const recipientProfile = profilesByWallet.get(toLower);
    if (!recipientProfile) {
      if (DEBUG) console.log(`[rep]   → rejected: recipient-not-registered`);
      await markRepEventCounted(event.txHash, event.logIndex, false, "recipient-not-registered");
      continue;
    }

    // Protocol addresses (e.g. ChallengeRegistry granting rewards) bypass all Aura checks.
    if (PROTOCOL_GIVERS.has(fromLower)) {
      if (DEBUG) console.log(`[rep]   → accepted: protocol-giver`);
      await markRepEventCounted(event.txHash, event.logIndex, true, undefined);
      accepted.push(event);
      continue;
    }

    // Regular giver: must be a registered profile.
    const giverProfile = profilesByWallet.get(fromLower);
    if (!giverProfile) {
      if (DEBUG) console.log(`[rep]   → rejected: giver-not-registered`);
      await markRepEventCounted(event.txHash, event.logIndex, false, "giver-not-registered");
      continue;
    }

    // Minimum Aura check (1e18-scaled — 1 Aura = 1e18).
    const giverAura =
      auraSnapshots.get(giverProfile.primaryWallet.toLowerCase())?.aura ??
      auraSnapshots.get(fromLower)?.aura ??
      0n;

    if (giverAura < MIN_AURA_TO_GIVE_REP) {
      if (DEBUG) console.log(`[rep]   → rejected: insufficient-aura (${giverAura})`);
      await markRepEventCounted(
        event.txHash,
        event.logIndex,
        false,
        `insufficient-aura:${giverAura}`
      );
      continue;
    }

    // Allowance check: cumulative abs(REP given) ≤ floor(current Aura / 1e18).
    // The allowance is in whole Aura units; Aura in DB is 1e18-scaled.
    const { repSpent: historicalSpent } = await getRepAllowance(giverProfile.id);
    const runningSpent = repSpentThisRun.get(giverProfile.id) ?? 0n;
    const totalSpent = historicalSpent + runningSpent;
    const eventCost = event.amount < 0n ? -event.amount : event.amount;
    const auraInWholeUnits = giverAura / 1_000_000_000_000_000_000n;

    if (totalSpent + eventCost > auraInWholeUnits) {
      if (DEBUG) {
        console.log(`[rep]   → rejected: allowance-exceeded (aura=${auraInWholeUnits} spent=${totalSpent} cost=${eventCost})`);
      }
      await markRepEventCounted(
        event.txHash,
        event.logIndex,
        false,
        `allowance-exceeded:aura=${auraInWholeUnits},spent=${totalSpent},cost=${eventCost}`
      );
      continue;
    }

    if (DEBUG) {
      console.log(`[rep]   → accepted (aura=${auraInWholeUnits} spent=${totalSpent}+${eventCost})`);
    }
    repSpentThisRun.set(giverProfile.id, runningSpent + eventCost);
    await markRepEventCounted(event.txHash, event.logIndex, true, undefined);
    accepted.push(event);
  }

  return accepted;
}

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

export function aggregateRepTotals(
  acceptedEvents: RepEvent[],
  profiles: Profile[]
): RepTotals[] {
  const profileByWallet = buildWalletMap(profiles);
  const totals = new Map<string, bigint>(); // `${profileId}:${category}`

  for (const event of acceptedEvents) {
    const recipient = profileByWallet.get(event.toAddress.toLowerCase());
    if (!recipient) continue;
    const key = `${recipient.id}:${event.category}`;
    totals.set(key, (totals.get(key) ?? 0n) + event.amount);
  }

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
// REP graph
// ---------------------------------------------------------------------------

export async function rebuildRepGraph(
  acceptedEvents: RepEvent[],
  profiles: Profile[]
): Promise<void> {
  const profileByWallet = buildWalletMap(profiles);

  type GraphKey = string;
  const graph = new Map<GraphKey, { net: bigint; count: number; lastAt: Date }>();

  for (const event of acceptedEvents) {
    const giver = profileByWallet.get(event.fromAddress.toLowerCase());
    const recipient = profileByWallet.get(event.toAddress.toLowerCase());
    // Protocol givers have no profile entry — skip graph edges for them.
    if (!giver || !recipient) continue;

    const key = `${giver.id}:${recipient.id}:${event.category}`;
    const current = graph.get(key) ?? { net: 0n, count: 0, lastAt: new Date(0) };
    graph.set(key, {
      net: current.net + event.amount,
      count: current.count + 1,
      lastAt: event.blockTimestamp > current.lastAt ? event.blockTimestamp : current.lastAt,
    });
  }

  for (const [key, data] of graph) {
    const [fromId, toId, category] = key.split(":").map(Number);
    await upsertRepGraph(fromId!, toId!, category!, data.net, data.count, data.lastAt);
  }
}

// ---------------------------------------------------------------------------
// Allowance persistence (regular givers only — protocol givers have no profile)
// ---------------------------------------------------------------------------

export async function persistRepAllowances(
  acceptedEvents: RepEvent[],
  auraSnapshots: Map<string, AuraSnapshot>,
  profiles: Profile[]
): Promise<void> {
  const profileByWallet = buildWalletMap(profiles);
  const spentThisBatch = new Map<number, bigint>();

  for (const event of acceptedEvents) {
    // Skip protocol givers — they have no profile and no allowance to track.
    if (PROTOCOL_GIVERS.has(event.fromAddress.toLowerCase())) continue;

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
