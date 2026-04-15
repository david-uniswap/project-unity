# Project Unity

Onchain alignment and credibility layer for the Uniswap ecosystem.

## What it is

- **Aura** — objective alignment score that accrues from UNI holdings over time; resets to zero if UNI is sold
- **REP** — subjective reputation signal assigned by Aura holders across six categories
- **Profiles** — unique onchain usernames with up to 2 linked wallets
- **Challenges** — anyone can dispute a posted Merkle root; successful challengers earn 1 000 Aura + 1 000 Builder REP

## Repository layout

```text
project-unity/
├── contracts/           Foundry project — all onchain contracts
│   ├── src/
│   │   ├── FakeUNI.sol              Mintable ERC-20 for Sepolia testing
│   │   ├── ProfileRegistry.sol      Username registration + wallet linking
│   │   ├── RepEmitter.sol           Append-only REP event emitter
│   │   ├── RootRegistry.sol         Stores one Merkle root per epoch
│   │   ├── ChallengeRegistry.sol    Challenge + bounty system
│   │   └── CheckpointVerifier.sol   Optional proof cache for hooks/apps
│   ├── test/
│   │   ├── FakeUNI.t.sol
│   │   ├── ProfileRegistry.t.sol
│   │   ├── RepEmitter.t.sol
│   │   ├── RootRegistry.t.sol
│   │   ├── ChallengeRegistry.t.sol
│   │   └── CheckpointVerifier.t.sol
│   └── script/
│       ├── Deploy.s.sol         Sepolia / mainnet deployment
│       ├── LocalSetup.s.sol     Local Anvil deploy + seed data
│       └── LocalChallenge.s.sol Seeds a challenge + acceptance on a running local stack
│
├── db/
│   ├── schema.sql                   Full PostgreSQL schema (tables, indexes, views)
│   └── migrations/
│       └── 002_challenges.sql       Challenge + aura_bonuses tables
│
├── indexer/             Bun/TypeScript snapshot pipeline (runs every 10 min)
│   └── src/
│       ├── index.ts     Scheduler entry point
│       ├── pipeline.ts  Epoch orchestration
│       ├── aura.ts      Aura computation + sale detection
│       ├── rep.ts       REP ingestion, validation, aggregation
│       ├── merkle.ts    Merkle tree construction (@openzeppelin/merkle-tree)
│       ├── blockchain.ts viem client + event readers (Sepolia, Anvil, any chain)
│       ├── db.ts        Postgres read/write
│       ├── config.ts    Environment config
│       └── types.ts     Shared TypeScript interfaces
│
├── api/                 Bun/Hono REST API (read-only, port 3001)
│   └── src/
│       ├── index.ts     Hono app + server
│       ├── db.ts        Postgres read queries
│       └── routes/
│           ├── leaderboard.ts
│           ├── profiles.ts
│           ├── epochs.ts
│           ├── rep.ts
│           └── challenges.ts
│
├── scripts/
│   └── local-dev.sh           One-command local stack (Anvil + Postgres + indexer + API)
├── docker-compose.yml         Postgres + indexer + API
├── docker-compose.local.yml   Adds Anvil node for local dev
├── .env.example               Sepolia config template
├── .env                       Your Sepolia config (gitignored)
├── .env.local                 Local Anvil config (gitignored)
└── LOCAL_DEV.md               Frontend developer setup guide
```

---

## Environments

### Sepolia (staging / demo)

Deploy once to Sepolia and run services against live testnet blocks.

```bash
# 1. One-time setup
./setup.sh

# 2. Fill in .env (SEPOLIA_RPC_URL, POSTER_PRIVATE_KEY at minimum)
#    Set START_BLOCK to the contract deployment block after step 3.

# 3. Deploy contracts
cd contracts
forge script script/Deploy.s.sol \
  --rpc-url $SEPOLIA_RPC_URL \
  --broadcast \
  --verify
cd ..

# 4. Paste the printed addresses into .env
#    Also add CHALLENGE_REGISTRY_ADDRESS to PROTOCOL_GIVERS.

# 5. Run the full stack in Docker
docker compose up

# Or run indexer + API locally (Postgres via Docker is fine):
docker compose up -d postgres
cd indexer && bun run dev
cd api     && bun run dev
```

> **No archive node required.** The indexer only reads current-block balances
> and `eth_getLogs` — both work on standard Sepolia nodes (Alchemy free tier, Infura, etc.).
> Set `START_BLOCK` in `.env` to the deployment block to avoid scanning from genesis.

### Local Anvil (fast iteration / testing)

Everything runs locally — no testnet, no tokens, no waiting for blocks.

**Frontend developers:** see [LOCAL_DEV.md](LOCAL_DEV.md) for a single-command setup with pre-seeded wallets, wallet credentials, and a full API reference.

**Quickest start (one command):**

```bash
./scripts/local-dev.sh
```

This starts Anvil, deploys all contracts, seeds 4 wallets with fUNI, registers profiles, runs a challenge, and starts Postgres + indexer + API — all automatically.

**Manual setup (for finer control):**

```bash
# Terminal 1 — start a local Ethereum node
# (auto-mines a block every 2 seconds, gives 10 accounts with 10 000 ETH each)
anvil --block-time 2

# Terminal 2 — deploy + seed contracts
cd contracts
forge script script/LocalSetup.s.sol \
  --rpc-url http://127.0.0.1:8545 \
  --broadcast
cd ..

# Paste the printed addresses into .env.local (FAKE_UNI_ADDRESS etc.)
# Also set PROTOCOL_GIVERS= to the ChallengeRegistry address.

# Terminal 3 — start Postgres (Docker)
docker compose up -d postgres

# Terminal 4 — load local env vars, then start indexer
set -a && source .env.local && set +a
cd indexer && bun run dev

# Terminal 5 — (new terminal, with env already sourced) start API
cd api && bun run dev
```

Epochs run every **30 seconds** in the local environment (vs 10 minutes on Sepolia).
`DEBUG=true` is pre-set in `.env.local` — you'll see every REP validation decision in the logs.

#### Full Docker local stack

```bash
# Start everything (Anvil + Postgres + indexer + API) in one command:
docker compose -f docker-compose.yml -f docker-compose.local.yml up

# Then in a separate terminal, deploy contracts:
forge script contracts/script/LocalSetup.s.sol \
  --rpc-url http://127.0.0.1:8545 \
  --broadcast

# Paste addresses into .env.local and restart the indexer container:
docker compose -f docker-compose.yml -f docker-compose.local.yml restart indexer
```

---

## Running tests

All tests are Foundry (Solidity). There are no TypeScript unit tests — the indexer and API logic is covered by the Solidity contract tests and integration-tested against a running stack.

```bash
cd contracts

# Run all tests
forge test

# Full trace output on failures
forge test -vvv

# Run a single test file
forge test --match-path test/FakeUNI.t.sol

# Run a specific test by name
forge test --match-test test_faucet_revertWhen_cooldownActive

# Gas report
forge test --gas-report

# Coverage report
forge coverage --report summary
```

Tests exist for all six contracts: `FakeUNI`, `ProfileRegistry`, `RepEmitter`, `RootRegistry`, `ChallengeRegistry`, `CheckpointVerifier`.

---

## Debugging

### Verbose indexer logging

Set `DEBUG=true` in your `.env` or `.env.local`. The indexer will log every REP event validation decision:

```text
[rep] event tx=0xabc... li=0 from=0x1234 to=0x5678 cat=0 amount=10
[rep]   → accepted (aura=1200 spent=0+10)

[rep] event tx=0xdef... li=1 from=0x9999 to=0x5678 cat=1 amount=5
[rep]   → rejected: insufficient-aura (0)
```

### Pipeline step-by-step

The indexer logs progress at each step:

```text
[pipeline] ═══ Epoch 42 ═══ 2026-04-15T10:00:00.000Z
[pipeline] Scanning blocks 1234 → 5678
[pipeline] ProfileRegistry: +2 names, +0 links, -0 unlinks
[pipeline] ChallengeRegistry: +0 submitted, 0 resolved, 0 bounties
[pipeline] Profiles: 4
[pipeline] Aura computed. Sales detected: 0
[pipeline] New REP events: 3
[pipeline] REP events: 15 total, 12 accepted
[pipeline] Merkle root: 0xabc... (4 leaves)
[pipeline] ✓ Epoch 42 complete in 843ms
```

### Checking what the indexer sees

```bash
# Check the last processed block
psql $DATABASE_URL -c "SELECT * FROM indexer_state;"

# See which REP events were rejected and why
psql $DATABASE_URL -c "SELECT tx_hash, rejection_reason FROM rep_events WHERE counted = false LIMIT 20;"

# Check a profile's Aura history
psql $DATABASE_URL -c "SELECT epoch_number, aura, sale_detected FROM aura_snapshots WHERE profile_id = 1 ORDER BY epoch_number DESC LIMIT 10;"

# See challenge status
psql $DATABASE_URL -c "SELECT id, status, challenger_address, epoch_number FROM challenges;"
```

### Checking the API

```bash
# Health check
curl http://localhost:3001/api/health

# Current epoch
curl http://localhost:3001/api/epochs/current | jq

# Profile by username
curl http://localhost:3001/api/profiles/alice | jq

# Merkle proof
curl "http://localhost:3001/api/profiles/alice/proof" | jq

# All REP events (including rejected)
curl "http://localhost:3001/api/rep/events?countedOnly=false" | jq

# Challenges
curl http://localhost:3001/api/challenges | jq
```

### Common issues

**"Aura computed" shows 0 for everyone on first epoch**
Expected. Aura accrual only begins after the first epoch — there is no "previous snapshot" on epoch 1, so the increment is computed on top of 0. Aura shows up from epoch 2 onwards.

**REP events all rejected with `insufficient-aura`**
Also expected on epoch 1. The REP allowance check uses Aura from the most recent snapshot. On epoch 1 there are no prior snapshots, so all givers have 0 Aura. Give it a few more epochs.

**Indexer crashes with `Missing required env var`**
Check that `.env` (or `.env.local`) is populated. Required vars: `SEPOLIA_RPC_URL`, `FAKE_UNI_ADDRESS`, `PROFILE_REGISTRY_ADDRESS`, `ROOT_REGISTRY_ADDRESS`, `REP_EMITTER_ADDRESS`, `CHALLENGE_REGISTRY_ADDRESS`, `POSTER_PRIVATE_KEY`, `DATABASE_URL`.

**`postRoot` reverts on Anvil**
The `POSTER_PRIVATE_KEY` in `.env.local` must correspond to the address that was set as `poster` in `RootRegistry` during `LocalSetup.s.sol`. The default Anvil key is pre-filled and LocalSetup uses the same account as both deployer and poster.

**Anvil resets between restarts**
Anvil is stateless — a fresh `anvil` process gives you a blank chain. Re-run `LocalSetup.s.sol` and update `.env.local` with the new addresses. Postgres persists independently (Docker volume), so run `docker compose down -v` to clear both at once.

---

## API reference

| Method | Path | Description |
| ------ | ---- | ----------- |
| GET | `/api/health` | Health check |
| GET | `/api/leaderboard/aura` | Aura leaderboard |
| GET | `/api/leaderboard/rep?category=builder` | REP leaderboard by category |
| GET | `/api/profiles/search?q=name` | Username search |
| GET | `/api/profiles/:id` | Profile by username or wallet |
| GET | `/api/profiles/:id/proof?epoch=N` | Merkle proof |
| GET | `/api/epochs/current` | Latest epoch root |
| GET | `/api/epochs` | List recent epochs |
| GET | `/api/epochs/:n` | Specific epoch |
| GET | `/api/epochs/:n/challenges` | Challenge summary counts for epoch |
| GET | `/api/rep/events` | REP events (filterable by from/to/category) |
| GET | `/api/rep/graph` | REP relationship graph |
| GET | `/api/challenges` | All challenges (filter by status/epoch) |
| GET | `/api/challenges/:id` | Single challenge by onchain ID |

All list endpoints support `limit` and `offset` for pagination.

---

## Epoch pipeline

Every epoch the indexer:

1. Ingests new `ProfileRegistry` events → syncs profiles to DB
2. Ingests new `ChallengeRegistry` events → syncs challenges and Aura bonuses to DB
3. Reads fUNI + LP balances for all wallets via RPC
4. Computes Aura (2× boost for approved LP positions, reset to 0 on UNI sale)
5. Ingests new `RepEmitter` events
6. Validates REP against Aura allowances (indexer-enforced, not onchain)
7. Aggregates REP totals per profile per category
8. Builds a StandardMerkleTree (OZ-compatible double-keccak256 leaves)
9. Posts `root` + `datasetHash` onchain to `RootRegistry`
10. Persists snapshots, proofs, and REP graph to Postgres
11. Writes `artifacts/epoch-N.json` for third-party verification

---

## Aura formula

```text
aura_rate_per_epoch = 1e18 / 1_440_000   # ≈ 694_444 (scaled by 1e18)

effective_uni  = wallet_fUNI + lp_fUNI
weighted_uni   = wallet_fUNI + (lp_fUNI × 2)

if effective_uni < previous_effective_uni:
    new_aura = 0                                       # sale detected — reset
else:
    new_aura = prev_aura + (weighted_uni × rate / 1e18)
```

Aura values are 18-decimal fixed-point (1 Aura = 1e18), matching the ERC-20 convention.

Permanent Aura bonuses from accepted challenges are stored separately and added on top of UNI-derived Aura when building Merkle leaves — they survive sale resets.

---

## REP rules

- Minimum **1 Aura** to give REP (enforced by indexer, not onchain)
- Each Aura unit allows **1 REP unit** of cumulative giving capacity across all grants
- REP can be **positive or negative** — no direct revocation; issue negative REP to offset
- REP is an **integer** — minimum unit is 1 (no decimals)

Categories: `Research (0)`, `Builder (1)`, `Trader (2)`, `Liquidity (3)`, `Governance (4)`, `Community (5)`

---

## Challenge system

Anyone can call `ChallengeRegistry.submitChallenge(epochNumber, claimedCorrectRoot, evidenceHash)` to dispute a posted root.

On acceptance, the challenger receives:

- **1 000 Aura** via `AuraBountyGranted` event (indexed by the pipeline into `aura_bonuses`)
- **1 000 Builder REP** via `RepEmitter` (ChallengeRegistry is whitelisted as a protocol giver in `PROTOCOL_GIVERS`)

Third parties can verify any epoch independently:

1. Download `artifacts/epoch-N.json` or fetch `/api/epochs/N`
2. Recompute the `datasetHash` from the leaf data
3. Compare against `RootRegistry.epochDatasetHashes[N]` onchain

---

## Contracts

All deployed on Sepolia. Addresses in `.env` after deployment.

| Contract | Purpose |
| -------- | ------- |
| `FakeUNI` | ERC-20 stand-in for real UNI; public faucet (10 000 / hour) |
| `ProfileRegistry` | Username + wallet linking (max 2 wallets per profile) |
| `RepEmitter` | Append-only REP event log — no onchain validation |
| `RootRegistry` | One Merkle root per epoch; stores datasetHash for auditing |
| `ChallengeRegistry` | Submit, accept, or reject root challenges; issues bounties |
| `CheckpointVerifier` | Optional: verify + cache Merkle proofs onchain for hook use |
