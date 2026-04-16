/**
 * aura.ts — Aura computation for a single epoch.
 *
 * Aura values use 18-decimal fixed-point (1 Aura = 1e18), matching the ERC-20 token
 * standard. This makes onchain integration and third-party tooling straightforward.
 *
 * Two components contribute to a profile's total Aura:
 *   1. UNI-derived Aura — accrues each epoch from holdings; resets to 0 on a sale.
 *   2. Permanent bonus Aura — granted for accepted challenge submissions;
 *      immune to sale resets and stored separately in aura_bonuses.
 *
 * The Merkle leaf encodes total Aura = UNI-derived + bonus.
 * The aura_snapshots table stores UNI-derived Aura only, to preserve clean
 * sale-detection continuity across epochs.
 *
 * Rules:
 *  - Aura accrues at 0.0001 per UNI per day (AURA_RATE_PER_EPOCH per epoch).
 *  - UNI in approved LP positions gets a 2× weighting toward accrual.
 *  - Transfers between a profile's two linked wallets do NOT trigger a sale.
 */

import { getFakeUNIBalance, getLPUNIBalance } from "./blockchain.ts";
import { AURA_RATE_PER_EPOCH } from "./config.ts";
import { getTotalAuraBonus } from "./db.ts";
import type { Profile, AuraSnapshot, PreviousAura } from "./types.ts";

// ---------------------------------------------------------------------------
// Per-profile balance fetch
// ---------------------------------------------------------------------------

interface WalletBalances {
  uniBalance: bigint;
  lpBalance: bigint;
}

async function fetchBalancesForProfile(profile: Profile): Promise<WalletBalances> {
  const wallets: `0x${string}`[] = [profile.primaryWallet];
  if (profile.linkedWallet) wallets.push(profile.linkedWallet);

  const [uniBalances, lpBalances] = await Promise.all([
    Promise.all(wallets.map((w) => getFakeUNIBalance(w))),
    Promise.all(wallets.map((w) => getLPUNIBalance(w))),
  ]);

  return {
    uniBalance: uniBalances.reduce((a, b) => a + b, 0n),
    lpBalance: lpBalances.reduce((a, b) => a + b, 0n),
  };
}

// ---------------------------------------------------------------------------
// Sale detection
// ---------------------------------------------------------------------------

/**
 * Returns true if the profile appears to have sold UNI since the last epoch.
 * Comparison is on effective_balance (wallet + raw LP) summed across both linked
 * wallets, so intra-profile transfers are invisible.
 */
function detectSale(currentEffective: bigint, previous: PreviousAura | null): boolean {
  if (!previous) return false;
  return currentEffective < previous.effectiveBalance;
}

// ---------------------------------------------------------------------------
// Aura computation (UNI-derived only — no bonus)
// ---------------------------------------------------------------------------

/**
 * Compute the UNI-derived Aura snapshot for a single profile in the current epoch.
 * Does NOT include permanent bonus Aura — that is added by the pipeline when building
 * Merkle leaves, so the DB snapshot stays clean for sale-detection continuity.
 */
export async function computeAuraSnapshot(
  profile: Profile,
  epochNumber: bigint,
  previous: PreviousAura | null
): Promise<AuraSnapshot> {
  const { uniBalance, lpBalance } = await fetchBalancesForProfile(profile);

  const effectiveBalance = uniBalance + lpBalance;
  const saleDetected = detectSale(effectiveBalance, previous);

  // 2× LP multiplier for Aura accrual.
  const auraWeightedBalance = uniBalance + lpBalance * 2n;

  // UNI-derived Aura:
  //   increment = (auraWeightedBalance × AURA_RATE_PER_EPOCH) / 1e18
  //
  // UNI is wei-scaled (1 UNI = 1e18) and AURA_RATE_PER_EPOCH is also 1e18-scaled,
  // so dividing by 1e18 yields an Aura increment in 1e18-scaled units.
  const prevAura = previous?.aura ?? 0n;
  const increment =
    (auraWeightedBalance * AURA_RATE_PER_EPOCH) / 1_000_000_000_000_000_000n;

  let newAura: bigint;
  if (saleDetected && previous && previous.effectiveBalance > 0n) {
    // Pro-rata decrease: Aura scales proportionally to balance retention.
    // E.g. 100 UNI / 1000 Aura → sell 10 UNI → 1000 * 90/100 = 900 Aura.
    const scaledAura =
      (prevAura * effectiveBalance) / previous.effectiveBalance;
    newAura = scaledAura + increment;
  } else {
    newAura = prevAura + increment;
  }

  return {
    profileId: profile.id,
    epochNumber,
    aura: newAura,       // UNI-derived only — bonuses added separately in pipeline
    uniBalance,
    lpBalance,
    effectiveBalance,
    saleDetected,
  };
}

// ---------------------------------------------------------------------------
// Total Aura for Merkle leaf (UNI-derived + permanent bonus)
// ---------------------------------------------------------------------------

/**
 * Returns the total Aura to encode in the Merkle leaf for a profile.
 * = UNI-derived Aura (from snapshot) + permanent bonus Aura (from aura_bonuses table).
 *
 * Bonus Aura:
 *  - Is 1e18-scaled (1 000e18 = 1 000 Aura), same convention as UNI-derived Aura.
 *  - Is NOT reset on UNI sales.
 *  - Is credited to the primary wallet used at the time of the challenge.
 */
export async function getTotalAuraForLeaf(
  profile: Profile,
  uniDerivedAura: bigint
): Promise<bigint> {
  const bonus = await getTotalAuraBonus(profile.primaryWallet);
  return uniDerivedAura + bonus;
}

// ---------------------------------------------------------------------------
// Batch computation
// ---------------------------------------------------------------------------

export async function computeAllAuraSnapshots(
  profiles: Profile[],
  epochNumber: bigint,
  previousAuras: Map<number, PreviousAura>
): Promise<AuraSnapshot[]> {
  const BATCH_SIZE = 20;
  const results: AuraSnapshot[] = [];

  for (let i = 0; i < profiles.length; i += BATCH_SIZE) {
    const batch = profiles.slice(i, i + BATCH_SIZE);
    const batchResults = await Promise.all(
      batch.map((p) =>
        computeAuraSnapshot(p, epochNumber, previousAuras.get(p.id) ?? null)
      )
    );
    results.push(...batchResults);
    if (i + BATCH_SIZE < profiles.length) {
      await new Promise((r) => setTimeout(r, 200));
    }
  }

  return results;
}
