/**
 * blockchain.ts — viem client setup and onchain read helpers.
 *
 * Reads:
 *  - ProfileRegistry events (NameRegistered, WalletLinked, WalletUnlinked)
 *  - RepEmitter events (RepGiven)
 *  - FakeUNI balances for individual wallets
 *  - LP pool token reserves for approved LP contracts (V2-style)
 */

import { createPublicClient, createWalletClient, http, parseAbi, getAddress } from "viem";
import { sepolia } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import {
  RPC_URL,
  FAKE_UNI_ADDRESS,
  PROFILE_REGISTRY_ADDRESS,
  REP_EMITTER_ADDRESS,
  ROOT_REGISTRY_ADDRESS,
  APPROVED_LP_POOLS,
  POSTER_PRIVATE_KEY,
} from "./config.ts";
import type { RepEvent } from "./types.ts";

// ---------------------------------------------------------------------------
// Clients
// ---------------------------------------------------------------------------

export const publicClient = createPublicClient({
  chain: sepolia,
  transport: http(RPC_URL, { retryCount: 3, retryDelay: 1500 }),
});

const posterAccount = privateKeyToAccount(POSTER_PRIVATE_KEY);

export const walletClient = createWalletClient({
  account: posterAccount,
  chain: sepolia,
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
  "function postRoot(uint256 epoch, bytes32 root) external",
  "function currentEpoch() view returns (uint256)",
]);

// ---------------------------------------------------------------------------
// Block helpers
// ---------------------------------------------------------------------------

export async function getCurrentBlock(): Promise<bigint> {
  const block = await publicClient.getBlockNumber();
  return block;
}

export async function getBlockTimestamp(blockNumber: bigint): Promise<Date> {
  const block = await publicClient.getBlock({ blockNumber });
  return new Date(Number(block.timestamp) * 1000);
}

// ---------------------------------------------------------------------------
// Balance reads
// ---------------------------------------------------------------------------

/** Read the raw fUNI balance for a wallet (wei-scale). */
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
 * based on their share of the pool.
 * Returns the raw UNI amount (not 2x boosted — boosting happens in aura.ts).
 */
export async function getLPUNIBalance(wallet: `0x${string}`): Promise<bigint> {
  if (APPROVED_LP_POOLS.length === 0) return 0n;

  let total = 0n;
  for (const pool of APPROVED_LP_POOLS) {
    try {
      const [reserves, token0, token1, totalSupply, userBalance] = await Promise.all([
        publicClient.readContract({ address: pool, abi: V2_PAIR_ABI, functionName: "getReserves" }),
        publicClient.readContract({ address: pool, abi: V2_PAIR_ABI, functionName: "token0" }),
        publicClient.readContract({ address: pool, abi: V2_PAIR_ABI, functionName: "token1" }),
        publicClient.readContract({ address: pool, abi: V2_PAIR_ABI, functionName: "totalSupply" }),
        publicClient.readContract({
          address: pool,
          abi: V2_PAIR_ABI,
          functionName: "balanceOf",
          args: [wallet],
        }),
      ]);

      if (totalSupply === 0n || userBalance === 0n) continue;

      // Which reserve is fUNI?
      const fakeUniLower = FAKE_UNI_ADDRESS.toLowerCase();
      const uniReserve =
        token0.toLowerCase() === fakeUniLower ? reserves[0] : reserves[1];

      // User's share: (userBalance / totalSupply) * uniReserve
      const userUniInPool = (BigInt(userBalance) * BigInt(uniReserve)) / BigInt(totalSupply);
      total += userUniInPool;
    } catch {
      // Pool read failed — skip it for this epoch rather than breaking the pipeline.
      console.warn(`[blockchain] Failed to read LP pool ${pool} for ${wallet}, skipping`);
    }
  }
  return total;
}

// ---------------------------------------------------------------------------
// ProfileRegistry events
// ---------------------------------------------------------------------------

export type NameRegisteredEvent = {
  wallet: `0x${string}`;
  name: string;
  blockNumber: bigint;
};

export type WalletLinkedEvent = {
  primary: `0x${string}`;
  linked: `0x${string}`;
  blockNumber: bigint;
};

export type WalletUnlinkedEvent = {
  primary: `0x${string}`;
  linked: `0x${string}`;
  blockNumber: bigint;
};

export async function getProfileRegistryEvents(
  fromBlock: bigint,
  toBlock: bigint
): Promise<{
  registered: NameRegisteredEvent[];
  linked: WalletLinkedEvent[];
  unlinked: WalletUnlinkedEvent[];
}> {
  const [regLogs, linkLogs, unlinkLogs] = await Promise.all([
    publicClient.getLogs({
      address: PROFILE_REGISTRY_ADDRESS,
      event: PROFILE_REGISTRY_ABI[0],
      fromBlock,
      toBlock,
    }),
    publicClient.getLogs({
      address: PROFILE_REGISTRY_ADDRESS,
      event: PROFILE_REGISTRY_ABI[1],
      fromBlock,
      toBlock,
    }),
    publicClient.getLogs({
      address: PROFILE_REGISTRY_ADDRESS,
      event: PROFILE_REGISTRY_ABI[2],
      fromBlock,
      toBlock,
    }),
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

export async function getRepEvents(
  fromBlock: bigint,
  toBlock: bigint
): Promise<RepEvent[]> {
  const logs = await publicClient.getLogs({
    address: REP_EMITTER_ADDRESS,
    event: REP_EMITTER_ABI[0],
    fromBlock,
    toBlock,
  });

  // Fetch block timestamps in parallel (group by unique block numbers to minimise calls).
  const uniqueBlocks = [...new Set(logs.map((l) => l.blockNumber!))];
  const timestamps = new Map<bigint, Date>();
  await Promise.all(
    uniqueBlocks.map(async (bn) => {
      const ts = await getBlockTimestamp(bn);
      timestamps.set(bn, ts);
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
// Root posting
// ---------------------------------------------------------------------------

export async function postRootOnchain(epoch: bigint, root: `0x${string}`): Promise<`0x${string}`> {
  const hash = await walletClient.writeContract({
    address: ROOT_REGISTRY_ADDRESS,
    abi: ROOT_REGISTRY_ABI,
    functionName: "postRoot",
    args: [epoch, root as `0x${string}`],
  });
  console.log(`[blockchain] Root posted: epoch=${epoch} root=${root} tx=${hash}`);
  return hash;
}

export async function getCurrentEpochOnchain(): Promise<bigint> {
  return publicClient.readContract({
    address: ROOT_REGISTRY_ADDRESS,
    abi: ROOT_REGISTRY_ABI,
    functionName: "currentEpoch",
  });
}
