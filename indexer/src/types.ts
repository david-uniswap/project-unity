/**
 * types.ts — Shared TypeScript types for the indexer pipeline.
 */

// ---------------------------------------------------------------------------
// Profile
// ---------------------------------------------------------------------------

export interface Profile {
  id: number;
  username: string;
  primaryWallet: `0x${string}`;
  linkedWallet: `0x${string}` | null;
}

// ---------------------------------------------------------------------------
// Aura
// ---------------------------------------------------------------------------

export interface AuraSnapshot {
  profileId: number;
  epochNumber: bigint;
  /** Aura value scaled by 1e18. */
  aura: bigint;
  /** Raw fUNI balance in primary + linked wallets, wei-scale. */
  uniBalance: bigint;
  /** fUNI in approved LP positions (raw amount, not 2x), wei-scale. */
  lpBalance: bigint;
  /** uniBalance + lpBalance + approved lending balance (for sale detection). */
  effectiveBalance: bigint;
  saleDetected: boolean;
}

export interface PreviousAura {
  profileId: number;
  aura: bigint;
  effectiveBalance: bigint;
}

// ---------------------------------------------------------------------------
// REP
// ---------------------------------------------------------------------------

export const REP_CATEGORIES = [
  "research",
  "builder",
  "trader",
  "liquidity",
  "governance",
  "community",
] as const;

export type RepCategory = (typeof REP_CATEGORIES)[number];

export const CATEGORY_INDEX: Record<number, RepCategory> = {
  0: "research",
  1: "builder",
  2: "trader",
  3: "liquidity",
  4: "governance",
  5: "community",
};

export interface RepEvent {
  id?: number;
  fromAddress: `0x${string}`;
  toAddress: `0x${string}`;
  category: number;
  amount: bigint;
  txHash: `0x${string}`;
  blockNumber: bigint;
  logIndex: number;
  blockTimestamp: Date;
}

export interface RepTotals {
  profileId: number;
  research: bigint;
  builder: bigint;
  trader: bigint;
  liquidity: bigint;
  governance: bigint;
  community: bigint;
}

// ---------------------------------------------------------------------------
// Merkle leaf
// ---------------------------------------------------------------------------

/** One leaf in the Merkle tree — one row per profile per epoch. */
export interface MerkleLeaf {
  epoch: bigint;
  primaryWallet: `0x${string}`;
  linkedWallet1: `0x${string}`; // address(0) if none
  linkedWallet2: `0x${string}`; // reserved, always address(0) for now
  usernameHash: `0x${string}`; // keccak256 of the username string
  aura: bigint; // 1e18-scaled
  repResearch: bigint;
  repBuilder: bigint;
  repTrader: bigint;
  repLiquidity: bigint;
  repGovernance: bigint;
  repCommunity: bigint;
}

// ---------------------------------------------------------------------------
// Pipeline output
// ---------------------------------------------------------------------------

export interface EpochOutput {
  epochNumber: bigint;
  root: `0x${string}`;
  leafCount: number;
  datasetHash: `0x${string}`;
  configHash: `0x${string}`;
  profiles: ProfileEpochData[];
}

export interface ProfileEpochData {
  profile: Profile;
  aura: bigint;
  repByCategory: Record<RepCategory, bigint>;
  proof: `0x${string}`[];
  leaf: `0x${string}`;
}
