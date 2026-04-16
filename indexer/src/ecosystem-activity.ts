/**
 * ecosystem-activity.ts — Background script that simulates realistic onchain activity
 * from 24 wallets: 4 dev wallets (alice, bob, carol, dave) + 20 ecosystem wallets
 * (address indices 10–29 from the Anvil test mnemonic).
 *
 * Every 60 seconds a "round" executes:
 *  - 3–6 fUNI transfers between random wallets
 *  - REP events covering all 6 categories (2–4 events per category, 12–24 total)
 *    using all wallets so every leaderboard category has real values
 *
 * All transactions are sent sequentially to avoid nonce conflicts. Errors from
 * individual transactions (insufficient balance, gas estimation failures, etc.)
 * are caught and logged as warnings — they never crash the process.
 *
 * Usage:
 *   bun run src/ecosystem-activity.ts
 *
 * Required env vars (same set as the main indexer):
 *   SEPOLIA_RPC_URL, CHAIN_ID (optional, defaults to 11155111),
 *   FAKE_UNI_ADDRESS, REP_EMITTER_ADDRESS
 */

import {
  createPublicClient,
  createWalletClient,
  http,
  parseAbi,
  parseEther,
  formatEther,
  defineChain,
} from "viem"
import { sepolia, anvil } from "viem/chains"
import { mnemonicToAccount, privateKeyToAccount } from "viem/accounts"

// ---------------------------------------------------------------------------
// Configuration (read directly — this script runs standalone, not via config.ts
// which requires several vars not needed here)
// ---------------------------------------------------------------------------

function requireEnv(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`Missing required env var: ${name}`)
  return value
}

function optionalEnv(name: string, fallback: string): string {
  return process.env[name] ?? fallback
}

const RPC_URL = requireEnv("SEPOLIA_RPC_URL")
const CHAIN_ID = parseInt(optionalEnv("CHAIN_ID", "11155111"), 10)
const FAKE_UNI_ADDRESS = requireEnv("FAKE_UNI_ADDRESS") as `0x${string}`
const REP_EMITTER_ADDRESS = requireEnv("REP_EMITTER_ADDRESS") as `0x${string}`

/** How often to fire a round of ecosystem activity (ms). */
const INTERVAL_MS = 60_000

/** Anvil test mnemonic — public, used for local dev only. */
const ANVIL_MNEMONIC = "test test test test test test test test test test test junk"

/** Category names aligned with the RepEmitter contract (indices 0–5). */
const CATEGORY_NAMES = [
  "research",
  "builder",
  "trader",
  "liquidity",
  "governance",
  "community",
] as const

// ---------------------------------------------------------------------------
// Minimal ABIs
// ---------------------------------------------------------------------------

const FAKE_UNI_ABI = parseAbi([
  "function transfer(address to, uint256 amount) returns (bool)",
  "function balanceOf(address account) view returns (uint256)",
])

const REP_EMITTER_ABI = parseAbi([
  "function giveRep(address to, uint8 category, int256 amount)",
])

// ---------------------------------------------------------------------------
// Chain resolution (mirrors blockchain.ts pattern)
// ---------------------------------------------------------------------------

function resolveChain() {
  if (CHAIN_ID === 11155111) return sepolia
  if (CHAIN_ID === 31337) return anvil
  return defineChain({
    id: CHAIN_ID,
    name: `Chain ${CHAIN_ID}`,
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [RPC_URL] } },
  })
}

const chain = resolveChain()

// ---------------------------------------------------------------------------
// Wallet setup — dev wallets (accounts #0-3) + ecosystem wallets (#10-29)
// ---------------------------------------------------------------------------

/** Anvil default private keys for dev wallets (accounts #0-3). Public, local only. */
const DEV_KEYS = {
  alice: "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  bob: "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  carol: "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
  dave: "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6",
} as const

interface SimWallet {
  label: string
  account: ReturnType<typeof mnemonicToAccount> | ReturnType<typeof privateKeyToAccount>
  address: `0x${string}`
}

function buildAllWallets(): SimWallet[] {
  // Dev wallets (accounts #0-3)
  const devWallets: SimWallet[] = Object.entries(DEV_KEYS).map(([label, key]) => {
    const account = privateKeyToAccount(key as `0x${string}`)
    return { label, account, address: account.address }
  })

  // Ecosystem wallets (accounts #10-29)
  const ecoWallets: SimWallet[] = Array.from({ length: 20 }, (_, i) => {
    const account = mnemonicToAccount(ANVIL_MNEMONIC, { addressIndex: i + 10 })
    return {
      label: `eco${String(i + 1).padStart(2, "0")}`,
      account,
      address: account.address,
    }
  })

  return [...devWallets, ...ecoWallets]
}

const allWallets = buildAllWallets()

// ---------------------------------------------------------------------------
// viem clients
// ---------------------------------------------------------------------------

const publicClient = createPublicClient({
  chain,
  transport: http(RPC_URL, { retryCount: 3, retryDelay: 1500 }),
})

/**
 * Create a wallet client for the given wallet.
 * Each account needs its own client so viem can sign transactions correctly.
 */
function makeWalletClient(wallet: SimWallet) {
  return createWalletClient({
    account: wallet.account,
    chain,
    transport: http(RPC_URL, { retryCount: 3, retryDelay: 1500 }),
  })
}

// ---------------------------------------------------------------------------
// Utility helpers
// ---------------------------------------------------------------------------

/** Inclusive random integer in [min, max]. */
function randInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min
}

/**
 * Pick two distinct indices from [0, length) at random.
 * Returns [fromIndex, toIndex].
 */
function pickDistinctPair(length: number): [number, number] {
  const from = randInt(0, length - 1)
  let to = randInt(0, length - 2)
  if (to >= from) to++
  return [from, to]
}

// ---------------------------------------------------------------------------
// Transaction helpers
// ---------------------------------------------------------------------------

/**
 * Attempt a single fUNI transfer between two ecosystem wallets.
 * Reads the sender's live balance and silently skips if insufficient.
 */
async function attemptTransfer(fromIdx: number, toIdx: number, amount: bigint): Promise<void> {
  const sender = allWallets[fromIdx]
  const recipient = allWallets[toIdx]

  const balance = await publicClient.readContract({
    address: FAKE_UNI_ADDRESS,
    abi: FAKE_UNI_ABI,
    functionName: "balanceOf",
    args: [sender.address],
  })

  if (balance < amount) return // silently skip — insufficient funds

  const wc = makeWalletClient(sender)
  const hash = await wc.writeContract({
    address: FAKE_UNI_ADDRESS,
    abi: FAKE_UNI_ABI,
    functionName: "transfer",
    args: [recipient.address, amount],
  })

  const displayAmount = Number(formatEther(amount)).toLocaleString("en-US", {
    maximumFractionDigits: 1,
  })
  console.log(
    `[ecosystem] fUNI  ${sender.label} → ${recipient.label}  ${displayAmount} fUNI  tx=${hash}`
  )
}

/**
 * Attempt a single giveRep call between two ecosystem wallets.
 */
async function attemptGiveRep(
  fromIdx: number,
  toIdx: number,
  category: number,
  amount: number
): Promise<void> {
  const sender = allWallets[fromIdx]
  const recipient = allWallets[toIdx]

  const wc = makeWalletClient(sender)
  const hash = await wc.writeContract({
    address: REP_EMITTER_ADDRESS,
    abi: REP_EMITTER_ABI,
    functionName: "giveRep",
    args: [recipient.address, category as number & { __brand: "uint8" }, BigInt(amount)],
  })

  console.log(
    `[ecosystem] REP   ${sender.label} → ${recipient.label}  +${amount} ${CATEGORY_NAMES[category]}  tx=${hash}`
  )
}

// ---------------------------------------------------------------------------
// Round execution
// ---------------------------------------------------------------------------

/**
 * Execute one round of ecosystem activity:
 *  - 3–6 random fUNI transfers
 *  - REP events covering all 6 categories (2–4 events per category, 12–24 total)
 *
 * All transactions run sequentially to avoid nonce conflicts. Individual errors
 * are caught and logged without aborting the round.
 */
async function runRound(round: number): Promise<void> {
  console.log(`[ecosystem] --- round ${round} ---`)

  const transferCount = randInt(3, 6)

  // fUNI transfers
  for (let i = 0; i < transferCount; i++) {
    const [fromIdx, toIdx] = pickDistinctPair(allWallets.length)
    // Random amount between 1,000 and 500,000 fUNI (whole numbers for readability)
    const fUNIAmount = parseEther(String(randInt(1_000, 500_000)))
    try {
      await attemptTransfer(fromIdx, toIdx, fUNIAmount)
    } catch (err: any) {
      console.warn(
        `[ecosystem] skipped: fUNI transfer ${allWallets[fromIdx].label} → ${allWallets[toIdx].label}: ${err?.shortMessage ?? err?.message ?? "unknown"}`
      )
    }
  }

  // REP events — cover every category each round so all 6 leaderboards populate.
  // 2–4 events per category with random givers, recipients, and amounts.
  for (let category = 0; category < CATEGORY_NAMES.length; category++) {
    const eventsThisCategory = randInt(2, 4)
    for (let i = 0; i < eventsThisCategory; i++) {
      const [fromIdx, toIdx] = pickDistinctPair(allWallets.length)
      const amount = randInt(1, 5)
      try {
        await attemptGiveRep(fromIdx, toIdx, category, amount)
      } catch (err: any) {
        console.warn(
          `[ecosystem] skipped: giveRep ${allWallets[fromIdx].label} → ${allWallets[toIdx].label}: ${err?.shortMessage ?? err?.message ?? "unknown"}`
        )
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

console.log("[ecosystem] Ecosystem activity simulator starting")
console.log(`[ecosystem] Chain: ${CHAIN_ID}  RPC: ${RPC_URL}`)
console.log(`[ecosystem] ${allWallets.length} wallets (4 dev + 20 eco), all 6 REP categories per round`)
console.log("[ecosystem] Wallets:")
for (const w of allWallets) {
  console.log(`[ecosystem]   ${w.label}  ${w.address}`)
}
console.log(`[ecosystem] Interval: ${INTERVAL_MS / 1000}s`)
console.log("[ecosystem] ---")

let round = 1
await runRound(round++)
setInterval(() => runRound(round++), INTERVAL_MS)
