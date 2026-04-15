/**
 * blockchain.ts — viem client setup and onchain read helpers.
 *
 * Reads:
 *  - ProfileRegistry events (NameRegistered, WalletLinked, WalletUnlinked)
 *  - RepEmitter events (RepGiven)
 *  - ChallengeRegistry events (ChallengeSubmitted, ChallengeAccepted, ChallengeRejected, AuraBountyGranted)
 *  - FakeUNI balances for individual wallets
 *  - LP pool token reserves for approved LP contracts (V2-style)
 */

import { createPublicClient, createWalletClient, http, parseAbi, defineChain } from "viem";
import { sepolia, anvil } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import {
  RPC_URL,
  CHAIN_ID,
  FAKE_UNI_ADDRESS,
  PROFILE_REGISTRY_ADDRESS,
  REP_EMITTER_ADDRESS,
  ROOT_REGISTRY_ADDRESS,
  CHALLENGE_REGISTRY_ADDRESS,
  APPROVED_LP_POOLS,
  POSTER_PRIVATE_KEY,
} from "./config.ts";

// ---------------------------------------------------------------------------
// Chain resolution
// ---------------------------------------------------------------------------

/**
 * Resolve the viem chain object from CHAIN_ID.
 * Supports Sepolia (11155111), local Anvil (31337), and any other chain
 * via a minimal custom definition.
 */
function resolveChain() {
  if (CHAIN_ID === 11155111) return sepolia;
  if (CHAIN_ID === 31337) return anvil;
  return defineChain({
    id: CHAIN_ID,
    name: `Chain ${CHAIN_ID}`,
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [RPC_URL] } },
  });
}

const chain = resolveChain();
import type { RepEvent, Challenge, AuraBonus } from "./types.ts";

// ---------------------------------------------------------------------------
// Clients
// ---------------------------------------------------------------------------

export const publicClient = createPublicClient({
  chain,
  transport: http(RPC_URL, { retryCount: 3, retryDelay: 1500 }),
});

const posterAccount = privateKeyToAccount(POSTER_PRIVATE_KEY);

export const walletClient = createWalletClient({
  account: posterAccount,
  chain,
  transport: http(RPC_URL, { retryCount: 3, retryDelay: 1500 }),
});

// ---------------------------------------------------------------------------
// ABIs (minimal — only the functions/events we need)
// ---------------------------------------------------------------------------

const ERC20_ABI = parseAbi([
  "function balanceOf(address account) view returns (uint256)",
  "function totalSupply() view returns (uint256)",
]);

const V2_PAIR_ABI = parseAbi([
  "function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)",
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function totalSupply() view returns (uint256)",
  "function balanceOf(address account) view returns (uint256)",
]);

const PROFILE_REGISTRY_ABI = parseAbi([
  "event NameRegistered(address indexed wallet, string name)",
  "event WalletLinked(address indexed primary, address indexed linked)",
  "event WalletUnlinked(address indexed primary, address indexed linked)",
]);

const REP_EMITTER_ABI = parseAbi([
  "event RepGiven(address indexed from, address indexed to, uint8 indexed category, int256 amount, uint256 timestamp)",
]);

const ROOT_REGISTRY_ABI = parseAbi([
  "function postRoot(uint256 epoch, bytes32 root, bytes32 datasetHash) external",
  "function currentEpoch() view returns (uint256)",
]);

const CHALLENGE_REGISTRY_ABI = parseAbi([
  "event ChallengeSubmitted(uint256 indexed challengeId, address indexed challenger, uint256 indexed epochNumber, bytes32 claimedCorrectRoot, bytes32 evidenceHash)",
  "event ChallengeAccepted(uint256 indexed challengeId, address indexed challenger, uint256 indexed epochNumber)",
  "event ChallengeRejected(uint256 indexed challengeId, address indexed challenger, string reason)",
  "event AuraBountyGranted(address indexed recipient, uint256 amount, uint256 indexed challengeId)",
]);

// ---------------------------------------------------------------------------
// Block helpers
// ---------------------------------------------------------------------------

export async function getCurrentBlock(): Promise<bigint> {
  return publicClient.getBlockNumber();
}

export async function getBlockTimestamp(blockNumber: bigint): Promise<Date> {
  const block = await publicClient.getBlock({ blockNumber });
  return new Date(Number(block.timestamp) * 1000);
}

// ---------------------------------------------------------------------------
// Balance reads
// ---------------------------------------------------------------------------

/** Read the raw fUNI balance for a wallet (wei-scale, 18 decimals). */
export async function getFakeUNIBalance(wallet: `0x${string}`): Promise<bigint> {
  return publicClient.readContract({
    address: FAKE_UNI_ADDRESS,
    abi: ERC20_ABI,
    functionName: "balanceOf",
    args: [wallet],
  });
}

/**
 * For each approved LP pool (V2-style), compute how much UNI the given wallet holds
 * based on their share of the pool. Returns the raw UNI amount (not 2× boosted).
 */
export async function getLPUNIBalance(wallet: `0x${string}`): Promise<bigint> {
  if (APPROVED_LP_POOLS.length === 0) return 0n;

  let total = 0n;
  for (const pool of APPROVED_LP_POOLS) {
    try {
      const [reserves, token0, totalSupply, userBalance] = await Promise.all([
        publicClient.readContract({ address: pool, abi: V2_PAIR_ABI, functionName: "getReserves" }),
        publicClient.readContract({ address: pool, abi: V2_PAIR_ABI, functionName: "token0" }),
        publicClient.readContract({ address: pool, abi: V2_PAIR_ABI, functionName: "totalSupply" }),
        publicClient.readContract({
          address: pool,
          abi: V2_PAIR_ABI,
          functionName: "balanceOf",
          args: [wallet],
        }),
      ]);

      if (totalSupply === 0n || userBalance === 0n) continue;

      const token1 = await publicClient.readContract({
        address: pool,
        abi: V2_PAIR_ABI,
        functionName: "token1",
      });

      const fakeUniLower = FAKE_UNI_ADDRESS.toLowerCase();
      const uniReserve =
        (token0 as string).toLowerCase() === fakeUniLower ? reserves[0] : reserves[1];

      const userUniInPool = (BigInt(userBalance) * BigInt(uniReserve)) / BigInt(totalSupply);
      total += userUniInPool;
    } catch {
      console.warn(`[blockchain] Failed to read LP pool ${pool} for ${wallet}, skipping`);
    }
  }
  return total;
}

// ---------------------------------------------------------------------------
// ProfileRegistry events
// ---------------------------------------------------------------------------

export type NameRegisteredEvent = { wallet: `0x${string}`; name: string; blockNumber: bigint };
export type WalletLinkedEvent = { primary: `0x${string}`; linked: `0x${string}`; blockNumber: bigint };
export type WalletUnlinkedEvent = { primary: `0x${string}`; linked: `0x${string}`; blockNumber: bigint };

export async function getProfileRegistryEvents(
  fromBlock: bigint,
  toBlock: bigint
): Promise<{
  registered: NameRegisteredEvent[];
  linked: WalletLinkedEvent[];
  unlinked: WalletUnlinkedEvent[];
}> {
  const [regLogs, linkLogs, unlinkLogs] = await Promise.all([
    publicClient.getLogs({ address: PROFILE_REGISTRY_ADDRESS, event: PROFILE_REGISTRY_ABI[0], fromBlock, toBlock }),
    publicClient.getLogs({ address: PROFILE_REGISTRY_ADDRESS, event: PROFILE_REGISTRY_ABI[1], fromBlock, toBlock }),
    publicClient.getLogs({ address: PROFILE_REGISTRY_ADDRESS, event: PROFILE_REGISTRY_ABI[2], fromBlock, toBlock }),
  ]);

  return {
    registered: regLogs.map((l) => ({
      wallet: l.args.wallet as `0x${string}`,
      name: l.args.name as string,
      blockNumber: l.blockNumber!,
    })),
    linked: linkLogs.map((l) => ({
      primary: l.args.primary as `0x${string}`,
      linked: l.args.linked as `0x${string}`,
      blockNumber: l.blockNumber!,
    })),
    unlinked: unlinkLogs.map((l) => ({
      primary: l.args.primary as `0x${string}`,
      linked: l.args.linked as `0x${string}`,
      blockNumber: l.blockNumber!,
    })),
  };
}

// ---------------------------------------------------------------------------
// RepEmitter events
// ---------------------------------------------------------------------------

export async function getRepEvents(fromBlock: bigint, toBlock: bigint): Promise<RepEvent[]> {
  const logs = await publicClient.getLogs({
    address: REP_EMITTER_ADDRESS,
    event: REP_EMITTER_ABI[0],
    fromBlock,
    toBlock,
  });

  const uniqueBlocks = [...new Set(logs.map((l) => l.blockNumber!))];
  const timestamps = new Map<bigint, Date>();
  await Promise.all(
    uniqueBlocks.map(async (bn) => {
      timestamps.set(bn, await getBlockTimestamp(bn));
    })
  );

  return logs.map((l) => ({
    fromAddress: l.args.from as `0x${string}`,
    toAddress: l.args.to as `0x${string}`,
    category: Number(l.args.category),
    amount: l.args.amount as bigint,
    txHash: l.transactionHash as `0x${string}`,
    blockNumber: l.blockNumber!,
    logIndex: l.logIndex!,
    blockTimestamp: timestamps.get(l.blockNumber!)!,
  }));
}

// ---------------------------------------------------------------------------
// ChallengeRegistry events
// ---------------------------------------------------------------------------

export interface ChallengeSubmittedEvent {
  challengeId: bigint;
  challenger: `0x${string}`;
  epochNumber: bigint;
  claimedCorrectRoot: `0x${string}`;
  evidenceHash: `0x${string}`;
  txHash: `0x${string}`;
  blockNumber: bigint;
  blockTimestamp: Date;
}

export interface ChallengeResolvedEvent {
  challengeId: bigint;
  challenger: `0x${string}`;
  epochNumber?: bigint;
  status: "accepted" | "rejected";
  /** Populated for rejected events (from the ChallengeRejected event's reason param). */
  reason?: string;
  txHash: `0x${string}`;
  blockNumber: bigint;
  blockTimestamp: Date;
}

export interface AuraBountyGrantedEvent {
  recipient: `0x${string}`;
  amount: bigint;
  challengeId: bigint;
  txHash: `0x${string}`;
  blockNumber: bigint;
  blockTimestamp: Date;
}

export async function getChallengeRegistryEvents(
  fromBlock: bigint,
  toBlock: bigint
): Promise<{
  submitted: ChallengeSubmittedEvent[];
  resolved: ChallengeResolvedEvent[];
  auraBounties: AuraBountyGrantedEvent[];
}> {
  const [submittedLogs, acceptedLogs, rejectedLogs, bountyLogs] = await Promise.all([
    publicClient.getLogs({ address: CHALLENGE_REGISTRY_ADDRESS, event: CHALLENGE_REGISTRY_ABI[0], fromBlock, toBlock }),
    publicClient.getLogs({ address: CHALLENGE_REGISTRY_ADDRESS, event: CHALLENGE_REGISTRY_ABI[1], fromBlock, toBlock }),
    publicClient.getLogs({ address: CHALLENGE_REGISTRY_ADDRESS, event: CHALLENGE_REGISTRY_ABI[2], fromBlock, toBlock }),
    publicClient.getLogs({ address: CHALLENGE_REGISTRY_ADDRESS, event: CHALLENGE_REGISTRY_ABI[3], fromBlock, toBlock }),
  ]);

  // Collect all unique block numbers for timestamp resolution.
  const allLogs = [...submittedLogs, ...acceptedLogs, ...rejectedLogs, ...bountyLogs];
  const uniqueBlocks = [...new Set(allLogs.map((l) => l.blockNumber!))];
  const timestamps = new Map<bigint, Date>();
  await Promise.all(
    uniqueBlocks.map(async (bn) => {
      timestamps.set(bn, await getBlockTimestamp(bn));
    })
  );

  const submitted: ChallengeSubmittedEvent[] = submittedLogs.map((l) => ({
    challengeId: l.args.challengeId as bigint,
    challenger: l.args.challenger as `0x${string}`,
    epochNumber: l.args.epochNumber as bigint,
    claimedCorrectRoot: l.args.claimedCorrectRoot as `0x${string}`,
    evidenceHash: l.args.evidenceHash as `0x${string}`,
    txHash: l.transactionHash as `0x${string}`,
    blockNumber: l.blockNumber!,
    blockTimestamp: timestamps.get(l.blockNumber!)!,
  }));

  const resolved: ChallengeResolvedEvent[] = [
    ...acceptedLogs.map((l) => ({
      challengeId: l.args.challengeId as bigint,
      challenger: l.args.challenger as `0x${string}`,
      epochNumber: l.args.epochNumber as bigint,
      status: "accepted" as const,
      txHash: l.transactionHash as `0x${string}`,
      blockNumber: l.blockNumber!,
      blockTimestamp: timestamps.get(l.blockNumber!)!,
    })),
    ...rejectedLogs.map((l) => ({
      challengeId: l.args.challengeId as bigint,
      challenger: l.args.challenger as `0x${string}`,
      status: "rejected" as const,
      reason: l.args.reason as string,
      txHash: l.transactionHash as `0x${string}`,
      blockNumber: l.blockNumber!,
      blockTimestamp: timestamps.get(l.blockNumber!)!,
    })),
  ];

  const auraBounties: AuraBountyGrantedEvent[] = bountyLogs.map((l) => ({
    recipient: l.args.recipient as `0x${string}`,
    amount: l.args.amount as bigint,
    challengeId: l.args.challengeId as bigint,
    txHash: l.transactionHash as `0x${string}`,
    blockNumber: l.blockNumber!,
    blockTimestamp: timestamps.get(l.blockNumber!)!,
  }));

  return { submitted, resolved, auraBounties };
}

// ---------------------------------------------------------------------------
// Root posting
// ---------------------------------------------------------------------------

/**
 * Post a new Merkle root onchain. `datasetHash` is published alongside the root
 * so third parties can independently verify the dataset that produced the tree.
 *
 * Both `root` and `datasetHash` are 1e18-scale-independent — they're raw bytes32.
 */
export async function postRootOnchain(
  epoch: bigint,
  root: `0x${string}`,
  datasetHash: `0x${string}`
): Promise<`0x${string}`> {
  const hash = await walletClient.writeContract({
    address: ROOT_REGISTRY_ADDRESS,
    abi: ROOT_REGISTRY_ABI,
    functionName: "postRoot",
    args: [epoch, root, datasetHash],
  });
  console.log(`[blockchain] Root posted: epoch=${epoch} root=${root} datasetHash=${datasetHash} tx=${hash}`);
  return hash;
}

export async function getCurrentEpochOnchain(): Promise<bigint> {
  return publicClient.readContract({
    address: ROOT_REGISTRY_ADDRESS,
    abi: ROOT_REGISTRY_ABI,
    functionName: "currentEpoch",
  });
}
