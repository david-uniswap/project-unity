/**
 * config.ts — Environment-driven configuration for the snapshot pipeline.
 *
 * All values are read from environment variables at startup. Missing required
 * vars throw immediately so failures are obvious rather than silent.
 */

function require(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

function optional(name: string, fallback: string): string {
  return process.env[name] ?? fallback;
}

// ---------------------------------------------------------------------------
// Network
// ---------------------------------------------------------------------------

export const RPC_URL = require("SEPOLIA_RPC_URL");

/** Chain ID for Sepolia (11155111). */
export const CHAIN_ID = parseInt(optional("CHAIN_ID", "11155111"), 10);

// ---------------------------------------------------------------------------
// Contract addresses
// ---------------------------------------------------------------------------

export const FAKE_UNI_ADDRESS = require("FAKE_UNI_ADDRESS") as `0x${string}`;
export const PROFILE_REGISTRY_ADDRESS = require("PROFILE_REGISTRY_ADDRESS") as `0x${string}`;
export const ROOT_REGISTRY_ADDRESS = require("ROOT_REGISTRY_ADDRESS") as `0x${string}`;
export const REP_EMITTER_ADDRESS = require("REP_EMITTER_ADDRESS") as `0x${string}`;
export const CHALLENGE_REGISTRY_ADDRESS = require("CHALLENGE_REGISTRY_ADDRESS") as `0x${string}`;

/**
 * Comma-separated list of approved LP pool addresses eligible for the 2× Aura boost.
 * The top 3 deepest UNI/fUNI pools should be listed here.
 */
export const APPROVED_LP_POOLS: `0x${string}`[] = optional("APPROVED_LP_POOLS", "")
  .split(",")
  .filter(Boolean)
  .map((a) => a.trim() as `0x${string}`);

/**
 * Comma-separated list of approved lending / wrapper contract addresses.
 * UNI deposited here is NOT treated as a sale and does NOT get the LP boost.
 */
export const APPROVED_LENDING_CONTRACTS: `0x${string}`[] = optional(
  "APPROVED_LENDING_CONTRACTS",
  ""
)
  .split(",")
  .filter(Boolean)
  .map((a) => a.trim() as `0x${string}`);

/**
 * Protocol-level addresses whose REP events bypass all Aura allowance checks.
 * The ChallengeRegistry is whitelisted here so it can grant Builder REP to
 * successful challengers without needing any Aura of its own.
 */
export const PROTOCOL_GIVERS: Set<string> = new Set(
  optional("PROTOCOL_GIVERS", "")
    .split(",")
    .filter(Boolean)
    .map((a) => a.trim().toLowerCase())
);

// ---------------------------------------------------------------------------
// Poster credentials
// ---------------------------------------------------------------------------

export const POSTER_PRIVATE_KEY = require("POSTER_PRIVATE_KEY") as `0x${string}`;

// ---------------------------------------------------------------------------
// Database
// ---------------------------------------------------------------------------

export const DATABASE_URL = require("DATABASE_URL");

// ---------------------------------------------------------------------------
// Pipeline parameters
// ---------------------------------------------------------------------------

/** Epoch duration in milliseconds. Default: 10 minutes. */
export const EPOCH_DURATION_MS = parseInt(
  optional("EPOCH_DURATION_MS", String(10 * 60 * 1000)),
  10
);

/**
 * Aura accrual rate per epoch per unit of UNI, expressed in 1e18-scaled units.
 *
 * All Aura values are 18-decimal fixed-point (identical convention to ERC-20 tokens),
 * so 1 Aura = 1e18 in uint256 storage — this makes onchain integration and
 * third-party tooling work without any custom decimal handling.
 *
 * Rate = 0.0001 Aura per UNI per day × (10 min / 1440 min/day)
 *      = 1e18 / 1_440_000
 *      ≈ 694_444_444_444 (per 1 UNI held per epoch, in 1e18-scaled units)
 */
export const AURA_RATE_PER_EPOCH: bigint = 1_000_000_000_000_000_000n / 1_440_000n;

/**
 * Minimum Aura (1e18-scaled) a profile must have to have their REP grants counted.
 * 1 Aura = 1_000_000_000_000_000_000 (1e18).
 */
export const MIN_AURA_TO_GIVE_REP: bigint = 1_000_000_000_000_000_000n;

/** Block to start scanning events from if no checkpoint exists. */
export const START_BLOCK = BigInt(optional("START_BLOCK", "0"));

/**
 * Enable verbose per-event debug logging.
 * Set DEBUG=true in .env to see per-event validation decisions,
 * aura computation detail, and blockchain call traces.
 */
export const DEBUG = optional("DEBUG", "false") === "true";
