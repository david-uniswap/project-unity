# Project Unity

Onchain alignment and credibility layer for the Uniswap ecosystem.

## What it is

- **Aura** — objective alignment score based on UNI holdings over time
- **REP** — subjective reputation signal assigned by Aura holders across six categories
- **Profiles** — unique onchain usernames with up to 2 linked wallets

## Repository Layout

```text
project-unity/
├── contracts/           Foundry project — all onchain contracts
│   ├── src/
│   │   ├── FakeUNI.sol              Mintable ERC-20 for Sepolia testing
│   │   ├── RootRegistry.sol         Stores one Merkle root per epoch
│   │   ├── ProfileRegistry.sol      Username registration + wallet linking
│   │   ├── RepEmitter.sol           Append-only REP event emitter
│   │   └── CheckpointVerifier.sol   Optional proof cache for hooks/apps
│   ├── test/            Foundry tests
│   └── script/          Deploy.s.sol
│
├── db/
│   └── schema.sql       Full PostgreSQL schema (tables, indexes, views)
│
├── indexer/             Bun/TypeScript snapshot pipeline
│   └── src/
│       ├── index.ts     Scheduler entry point (runs every 10 min)
│       ├── pipeline.ts  Full epoch pipeline orchestration
│       ├── aura.ts      Aura computation + sale detection
│       ├── rep.ts       REP ingestion, validation, aggregation
│       ├── merkle.ts    Merkle tree construction (@openzeppelin/merkle-tree)
│       ├── blockchain.ts viem client + contract event readers
│       ├── db.ts        Postgres read/write
│       ├── config.ts    Environment config
│       └── types.ts     Shared TypeScript interfaces
│
├── api/                 Bun/Hono REST API (read-only)
│   └── src/
│       ├── index.ts     Hono app + server
│       ├── db.ts        Postgres read queries
│       └── routes/
│           ├── leaderboard.ts  /api/leaderboard/aura, /api/leaderboard/rep
│           ├── profiles.ts     /api/profiles/:id, /api/profiles/:id/proof
│           ├── epochs.ts       /api/epochs/current, /api/epochs/:n
│           └── rep.ts          /api/rep/events, /api/rep/graph
│
├── docker-compose.yml   Postgres + indexer + API
├── .env.example         Template — copy to .env
└── setup.sh             One-time setup (Foundry, bun install, Postgres)
```

## Quick Start

```bash
# 1. Setup
./setup.sh

# 2. Edit .env with your RPC URL and private key

# 3. Deploy contracts to Sepolia
cd contracts
forge script script/Deploy.s.sol \
  --rpc-url $SEPOLIA_RPC_URL \
  --broadcast \
  --verify
cd ..

# 4. Copy deployed addresses into .env

# 5. Run everything
docker compose up

# Or run services individually:
cd indexer && bun run dev   # port: no HTTP, just pipeline
cd api     && bun run dev   # http://localhost:3001
```

## API Reference

| Method | Path | Description |
| ------ | ---- | ----------- |
| GET | `/api/health` | Health check |
| GET | `/api/leaderboard/aura` | Aura leaderboard |
| GET | `/api/leaderboard/rep?category=builder` | REP leaderboard |
| GET | `/api/profiles/:id` | Profile by username or wallet |
| GET | `/api/profiles/:id/proof?epoch=N` | Merkle proof |
| GET | `/api/epochs/current` | Current epoch state |
| GET | `/api/epochs/:n` | Specific epoch |
| GET | `/api/rep/events` | REP events (filterable) |
| GET | `/api/rep/graph` | REP relationship graph |

## Epoch Pipeline

Every 10 minutes the indexer:

1. Ingests new `ProfileRegistry` events → syncs profiles to DB
2. Reads fUNI + LP balances for all wallets
3. Computes Aura (2× boost for approved LP positions, reset on sale)
4. Ingests new `RepEmitter` events
5. Validates REP against Aura allowances
6. Aggregates REP totals per profile per category
7. Builds a StandardMerkleTree (OZ-compatible)
8. Posts the root to `RootRegistry` onchain
9. Persists snapshots, proofs, and REP graph to Postgres

## Aura Formula

```python
aura_rate_per_epoch = 0.0001 / 144   # (10-min epoch, 144 epochs/day)

effective_uni = wallet_balance + lp_balance
aura_weighted = wallet_balance + (lp_balance × 2)

if effective_uni < previous_effective_uni:
    new_aura = 0  # sale detected
else:
    new_aura = prev_aura + (aura_weighted × aura_rate_per_epoch)
```

## REP Rules

- Minimum 1 Aura to give REP (enforced by indexer)
- Each Aura point allows 1 REP unit (cumulative across all grants)
- REP can be positive or negative
- No direct revocation — issue negative REP to offset prior grants
- Categories: Research, Builder, Trader, Liquidity, Governance, Community

## Contracts

All deployed on Sepolia testnet. Addresses in `.env` after deployment.

| Contract | Purpose |
| -------- | ------- |
| `FakeUNI` | ERC-20 stand-in for real UNI on testnet |
| `ProfileRegistry` | Username + wallet linking |
| `RootRegistry` | One Merkle root per epoch |
| `RepEmitter` | Append-only REP events |
| `CheckpointVerifier` | Optional: verify + cache proofs onchain |
