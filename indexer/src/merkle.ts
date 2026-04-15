/**
 * merkle.ts — Merkle tree construction using @openzeppelin/merkle-tree.
 *
 * Each leaf encodes one profile's full state for an epoch:
 *   [epoch, primaryWallet, linkedWallet1, linkedWallet2, usernameHash,
 *    aura, repResearch, repBuilder, repTrader, repLiquidity, repGovernance, repCommunity]
 *
 * Types (ABI-encoded):
 *   [uint256, address, address, address, bytes32, uint256,
 *    int256, int256, int256, int256, int256, int256]
 *
 * The StandardMerkleTree encodes leaves with abi.encode + double keccak256,
 * which matches the CheckpointVerifier's Solidity verification.
 */

import { StandardMerkleTree } from "@openzeppelin/merkle-tree";
import { keccak256, toHex, encodeAbiParameters, parseAbiParameters } from "viem";
import type { Profile, AuraSnapshot, RepTotals, MerkleLeaf, ProfileEpochData } from "./types.ts";
import { REP_CATEGORIES } from "./types.ts";

// ABI parameter types matching the Solidity leaf encoding.
const LEAF_TYPES = [
  "uint256", // epoch
  "address", // primaryWallet
  "address", // linkedWallet1
  "address", // linkedWallet2 (reserved)
  "bytes32", // usernameHash
  "uint256", // aura
  "int256",  // repResearch
  "int256",  // repBuilder
  "int256",  // repTrader
  "int256",  // repLiquidity
  "int256",  // repGovernance
  "int256",  // repCommunity
] as const;

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as const;

// ---------------------------------------------------------------------------
// Leaf construction
// ---------------------------------------------------------------------------

export function buildLeaf(
  epoch: bigint,
  profile: Profile,
  aura: bigint,
  repTotals: RepTotals
): MerkleLeaf {
  const usernameHash = keccak256(
    new TextEncoder().encode(profile.username)
  ) as `0x${string}`;

  return {
    epoch,
    primaryWallet: profile.primaryWallet,
    linkedWallet1: (profile.linkedWallet ?? ZERO_ADDRESS) as `0x${string}`,
    linkedWallet2: ZERO_ADDRESS,
    usernameHash,
    aura,
    repResearch: repTotals.research,
    repBuilder: repTotals.builder,
    repTrader: repTotals.trader,
    repLiquidity: repTotals.liquidity,
    repGovernance: repTotals.governance,
    repCommunity: repTotals.community,
  };
}

function leafToValues(leaf: MerkleLeaf): (string | bigint)[] {
  return [
    leaf.epoch,
    leaf.primaryWallet,
    leaf.linkedWallet1,
    leaf.linkedWallet2,
    leaf.usernameHash,
    leaf.aura,
    leaf.repResearch,
    leaf.repBuilder,
    leaf.repTrader,
    leaf.repLiquidity,
    leaf.repGovernance,
    leaf.repCommunity,
  ];
}

// ---------------------------------------------------------------------------
// Tree construction
// ---------------------------------------------------------------------------

export interface MerkleOutput {
  root: `0x${string}`;
  tree: StandardMerkleTree<(string | bigint)[]>;
  leaves: MerkleLeaf[];
}

export function buildMerkleTree(leaves: MerkleLeaf[]): MerkleOutput {
  if (leaves.length === 0) {
    throw new Error("Cannot build a Merkle tree with zero leaves");
  }

  const values = leaves.map(leafToValues);
  const tree = StandardMerkleTree.of(values, LEAF_TYPES as unknown as string[]);

  return {
    root: tree.root as `0x${string}`,
    tree,
    leaves,
  };
}

// ---------------------------------------------------------------------------
// Proof extraction
// ---------------------------------------------------------------------------

/**
 * For each leaf in the tree, extract its proof and build ProfileEpochData.
 */
export function extractProofsForAllProfiles(
  output: MerkleOutput,
  profiles: Profile[],
  auraSnapshots: AuraSnapshot[],
  repTotalsMap: Map<number, RepTotals>
): ProfileEpochData[] {
  const profileById = new Map(profiles.map((p) => [p.id, p]));
  const auraById = new Map(auraSnapshots.map((s) => [s.profileId, s]));

  const results: ProfileEpochData[] = [];

  for (const [i, leaf] of output.leaves.entries()) {
    // Find the profile for this leaf.
    const profile = profiles.find(
      (p) => p.primaryWallet.toLowerCase() === leaf.primaryWallet.toLowerCase()
    );
    if (!profile) continue;

    const auraSnapshot = auraById.get(profile.id);
    const repTotals = repTotalsMap.get(profile.id);
    if (!auraSnapshot || !repTotals) continue;

    const proof = output.tree.getProof(i) as `0x${string}`[];
    const leafHash = output.tree.leafHash(leafToValues(leaf) as Parameters<typeof output.tree.leafHash>[0]) as `0x${string}`;

    results.push({
      profile,
      aura: auraSnapshot.aura,
      repByCategory: {
        research: repTotals.research,
        builder: repTotals.builder,
        trader: repTotals.trader,
        liquidity: repTotals.liquidity,
        governance: repTotals.governance,
        community: repTotals.community,
      },
      proof,
      leaf: leafHash,
    });
  }

  return results;
}

// ---------------------------------------------------------------------------
// Dataset hashing (for reproducibility auditing)
// ---------------------------------------------------------------------------

/**
 * Returns a deterministic hash of the full dataset (all leaves sorted by wallet address).
 * Posted alongside the root so anyone can verify the dataset that generated it.
 */
export function computeDatasetHash(leaves: MerkleLeaf[]): `0x${string}` {
  const sorted = [...leaves].sort((a, b) =>
    a.primaryWallet.toLowerCase() < b.primaryWallet.toLowerCase() ? -1 : 1
  );
  const encoded = JSON.stringify(
    sorted.map((l) => ({
      epoch: l.epoch.toString(),
      primaryWallet: l.primaryWallet,
      linkedWallet1: l.linkedWallet1,
      usernameHash: l.usernameHash,
      aura: l.aura.toString(),
      rep: {
        research: l.repResearch.toString(),
        builder: l.repBuilder.toString(),
        trader: l.repTrader.toString(),
        liquidity: l.repLiquidity.toString(),
        governance: l.repGovernance.toString(),
        community: l.repCommunity.toString(),
      },
    }))
  );
  return keccak256(new TextEncoder().encode(encoded)) as `0x${string}`;
}
