/**
 * aura.ts — Aura computation for a single epoch.
 *
 * Rules:
 *  - Aura accrues at 0.0001 per UNI per day (AURA_RATE_PER_EPOCH per epoch).
 *  - UNI in approved LP positions gets a 2× weighting toward accrual.
 *  - UNI in approved lending/wrapper contracts is NOT treated as a sale,
 *    but also does not contribute to Aura accrual (excluded entirely for now).
 *  - If a profile's effective UNI balance (wallet + LP raw, excluding lending)
 *    drops vs the previous epoch, a sale is detected and Aura resets to 0.
 *  - Transfers between a profile's two linked wallets do NOT trigger a sale.
 */

import {
  getFakeUNIBalance,
  getLPUNIBalance,
} from "./blockchain.ts";
import { AURA_RATE_PER_EPOCH } from "./config.ts";
import type { Profile, AuraSnapshot, PreviousAura } from "./types.ts";

// ---------------------------------------------------------------------------
// Per-profile balance fetch
// ---------------------------------------------------------------------------

interface WalletBalances {
  uniBalance: bigint; // sum of raw fUNI across primary + linked wallets
  lpBalance: bigint;  // sum of raw UNI in approved LP positions (raw, not 2x)
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
 *
 * Detection: current effective_balance (uniBalance + lpBalance) < previous effective_balance.
 *
 * Transfers between linked wallets are invisible here because we sum across
 * both wallets before comparing, so intra-profile moves don't register as a drop.
 */
function detectSale(currentEffective: bigint, previous: PreviousAura | null): boolean {
  if (!previous) return false; // No history — can't detect a sale yet.
  return currentEffective < previous.effectiveBalance;
}

// ---------------------------------------------------------------------------
// Aura computation
// ---------------------------------------------------------------------------

/**
 * Compute the Aura snapshot for a single profile in the current epoch.
 *
 * @param profile       The profile to compute for.
 * @param epochNumber   Current epoch number.
 * @param previous      Previous epoch's aura state (null on first appearance).
 */
export async function computeAuraSnapshot(
  profile: Profile,
  epochNumber: bigint,
  previous: PreviousAura | null
): Promise<AuraSnapshot> {
  const { uniBalance, lpBalance } = await fetchBalancesForProfile(profile);

  // Effective balance for sale detection (raw totals, not 2x).
  const effectiveBalance = uniBalance + lpBalance;

  const saleDetected = detectSale(effectiveBalance, previous);

  // Aura-weighted balance applies the 2× LP multiplier.
  const auraWeightedBalance = uniBalance + lpBalance * 2n;

  // Aura calculation:
  //  - Reset to 0 on sale.
  //  - Otherwise: previous Aura + (auraWeightedBalance × rate per epoch).
  //    rate per epoch = AURA_RATE_PER_EPOCH (1e18-scaled per unit of UNI, where UNI is in wei).
  //    UNI is stored in wei (1 UNI = 1e18 wei), so:
  //      increment = (auraWeightedBalance * AURA_RATE_PER_EPOCH) / 1e18
  //                = auraWeightedBalance * AURA_RATE_PER_EPOCH / 1e18
  let newAura: bigint;
  if (saleDetected) {
    newAura = 0n;
  } else {
    const prevAura = previous?.aura ?? 0n;
    const increment =
      (auraWeightedBalance * AURA_RATE_PER_EPOCH) / 1_000_000_000_000_000_000n;
    newAura = prevAura + increment;
  }

  return {
    profileId: profile.id,
    epochNumber,
    aura: newAura,
    uniBalance,
    lpBalance,
    effectiveBalance,
    saleDetected,
  };
}

/**
 * Compute Aura snapshots for all profiles in parallel (batched to avoid RPC rate limits).
 */
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
      batch.map((p) => computeAuraSnapshot(p, epochNumber, previousAuras.get(p.id) ?? null))
    );
    results.push(...batchResults);
    if (i + BATCH_SIZE < profiles.length) {
      // Small delay between batches to respect RPC rate limits.
      await new Promise((r) => setTimeout(r, 200));
    }
  }

  return results;
}
