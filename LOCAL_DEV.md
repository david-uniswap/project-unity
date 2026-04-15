# Local Development Guide

This guide gets a frontend developer up and running against a fully seeded local blockchain in a single command. No Sepolia, no testnet tokens, no waiting for blocks.

---

## What you get

A local Ethereum node pre-loaded with:

- **4 dev wallets** (alice, bob, carol, dave) with fUNI tokens you can import into MetaMask
- **20 ecosystem wallets** (eco01–eco20) automatically generating fUNI transfers and REP events every 60 seconds
- **A resolved challenge** (Carol challenged epoch 1, was accepted, earned 1 000 Aura + 1 000 Builder REP)
- **API** running at `http://localhost:3001` with full read access to profiles, leaderboards, epochs, and challenges
- **2-minute epochs** — the indexer snapshots Aura and REP every 2 minutes, builds a Merkle tree, and posts the root onchain
- **Merkle tree artifacts** saved locally at `indexer/artifacts/merkle-epoch-N.json` for offline proof generation

---

## Prerequisites

Install these before running the startup script:

**Foundry** (forge, anvil, cast):

```bash
curl -L https://foundry.paradigm.xyz | bash   # installs the foundryup tool
source ~/.zshenv                               # or restart your terminal
foundryup                                      # installs forge, cast, anvil
```

**Docker Desktop:** [docker.com/products/docker-desktop](https://www.docker.com/products/docker-desktop)

**Bun:**

```bash
curl -fsSL https://bun.sh/install | bash
source ~/.zshenv   # or restart your terminal
```

**jq:**

```bash
brew install jq
```

---

## Start the stack

From the repo root:

```bash
./scripts/local-dev.sh
```

This single command:

1. Starts a local Anvil blockchain (auto-mines every 2 seconds, 30 accounts)
2. Deploys all 6 contracts
3. Mints fUNI tokens to 4 dev wallets + 20 ecosystem wallets
4. Registers usernames: alice, bob, carol, dave, eco01–eco20
5. Emits initial REP events between dev wallets
6. Starts Postgres, the indexer, the API, and the ecosystem activity simulator
7. Waits for epoch 1, then seeds a challenge and acceptance for Carol
8. Prints all wallet credentials and endpoints

The script takes about 2–3 minutes to complete (most of that is waiting for the first 2-minute epoch).

---

## Add wallets to MetaMask or Uniswap Wallet

### Step 1 — Add the local network

In your wallet app:

| Field | Value |
|-------|-------|
| Network name | Project Unity Local |
| RPC URL | `http://127.0.0.1:8545` |
| Chain ID | `31337` |
| Currency symbol | `ETH` |

### Step 2 — Import a wallet by private key

Pick any wallet below. Import via "Import account" → "Private key".

> **These keys are publicly known Anvil defaults. Never use them on mainnet or Sepolia.**

---

### Alice — Highest Aura

```
Address:     0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266
Private key: 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
```

- fUNI balance: **10 000 000**
- Aura accrual: ~6.9 Aura per epoch (fastest)
- Username: `alice`
- REP given: 5 research to bob, 2 builder to carol
- REP received: 3 community from bob

---

### Bob

```
Address:     0x70997970C51812dc3A010C7d01b50e0d17dc79C8
Private key: 0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d
```

- fUNI balance: **5 000 000**
- Aura accrual: ~3.5 Aura per epoch
- Username: `bob`
- REP given: 3 community to alice, 1 trader to dave
- REP received: 5 research from alice, 1 governance from carol

---

### Carol — Has a resolved challenge

```
Address:     0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC
Private key: 0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a
```

- fUNI balance: **1 000 000**
- Aura accrual: ~0.7 Aura per epoch (slower — visible after epoch 2-3)
- Username: `carol`
- REP given: 1 governance to bob
- REP received: 2 builder from alice
- **Challenge bonus**: 1 000 Aura + 1 000 Builder REP (credited next epoch after challenge)

---

### Dave — Low Aura tier

```
Address:     0x90F79bf6EB2c4f870365E785982E1f101E93b906
Private key: 0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6
```

- fUNI balance: **200 000**
- Aura accrual: ~0.14 Aura per epoch (low tier — useful for testing Aura floor behaviour)
- Username: `dave`
- REP received: 1 trader from bob

---

## Ecosystem wallets (eco01–eco20)

20 additional wallets run automatically in the background, generating fUNI transfers and REP events every 60 seconds. They are derived from the same Anvil test mnemonic at address indices 10–29.

You don't need to import these — they exist to populate the leaderboard and REP graph with realistic activity. The API returns them like any other profile.

```bash
# See all eco profiles
curl http://localhost:3001/api/profiles/eco01 | jq
curl http://localhost:3001/api/leaderboard/aura | jq  # includes eco wallets
```

fUNI distribution (spans every Aura tier):

| Wallet | fUNI balance |
|--------|--------------|
| eco01  | 8 000 000    |
| eco02  | 6 500 000    |
| eco03  | 5 000 000    |
| eco04  | 3 500 000    |
| eco05  | 2 500 000    |
| eco06  | 1 800 000    |
| eco07  | 1 200 000    |
| eco08  | 900 000      |
| eco09  | 650 000      |
| eco10  | 450 000      |
| eco11  | 320 000      |
| eco12  | 220 000      |
| eco13  | 160 000      |
| eco14  | 120 000      |
| eco15  | 85 000       |
| eco16  | 60 000       |
| eco17  | 40 000       |
| eco18  | 25 000       |
| eco19  | 15 000       |
| eco20  | 8 000        |

Watch live activity:

```bash
tail -f /tmp/unity-ecosystem.log
# [ecosystem] fUNI  eco07 → eco14  42000.0 fUNI  tx=0xabc...
# [ecosystem] REP   eco03 → eco11  +5 builder  tx=0xdef...
```

---

## Merkle tree artifacts

After each epoch, the indexer writes two files to `indexer/artifacts/`:

| File                   | Contents                                                 |
|------------------------|----------------------------------------------------------|
| `epoch-N.json`         | Full snapshot: profiles, Aura, REP by category, proofs   |
| `merkle-epoch-N.json`  | Raw tree dump loadable with `StandardMerkleTree.load()`  |

The tree dump lets you generate proofs offline without the API:

```typescript
import { StandardMerkleTree } from "@openzeppelin/merkle-tree"
import { readFileSync } from "node:fs"

const dump = JSON.parse(readFileSync("indexer/artifacts/merkle-epoch-1.json", "utf8"))
const tree = StandardMerkleTree.load(dump)

// Generate a proof for any leaf
for (const [i, leaf] of tree.entries()) {
  if (leaf[1] === "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266") { // alice
    console.log("Proof:", tree.getProof(i))
    break
  }
}
```

---

## API reference

Base URL: `http://localhost:3001`

```bash
# Health check
curl http://localhost:3001/api/health

# Current epoch
curl http://localhost:3001/api/epochs/current | jq

# All recent epochs
curl http://localhost:3001/api/epochs | jq

# Aura leaderboard
curl http://localhost:3001/api/leaderboard/aura | jq

# REP leaderboard (builder category)
curl "http://localhost:3001/api/leaderboard/rep?category=builder" | jq

# Profile by username
curl http://localhost:3001/api/profiles/alice | jq

# Profile by wallet address
curl http://localhost:3001/api/profiles/0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266 | jq

# Merkle proof for alice (default: latest epoch)
curl http://localhost:3001/api/profiles/alice/proof | jq

# Merkle proof for a specific epoch
curl "http://localhost:3001/api/profiles/alice/proof?epoch=1" | jq

# All REP events (including rejected)
curl "http://localhost:3001/api/rep/events?countedOnly=false" | jq

# REP relationship graph
curl http://localhost:3001/api/rep/graph | jq

# All challenges
curl http://localhost:3001/api/challenges | jq

# Challenges on a specific epoch
curl "http://localhost:3001/api/challenges?epoch=1" | jq
```

---

## Understanding the epoch timeline

The indexer runs every **30 seconds**. Each epoch:

1. Reads fUNI balances for all registered wallets
2. Computes Aura (accruals and sale resets)
3. Ingests and validates REP events
4. Builds a Merkle tree and posts the root onchain
5. Saves snapshots to Postgres

**Epoch 1 quirk:** No Aura accrues on epoch 1 because there is no prior snapshot to measure the increment against. Aura first appears in epoch 2. REP events from before epoch 2 will show as `insufficient-aura` until Aura exists.

**What to expect after startup:**

| Time | What happens |
|------|-------------|
| 0s | Contracts deployed, wallets funded, profiles registered |
| ~35s | Epoch 1 completes — profiles visible in API, Aura = 0 |
| ~35s | Carol's challenge is seeded and accepted |
| ~65s | Epoch 2 completes — Alice has ~6.9 Aura, Bob ~3.5 Aura |
| ~95s | Epoch 3 — REP events from seeding start counting |

---

## Watching the indexer

```bash
# Real-time indexer log (shows per-epoch progress and per-event REP decisions)
tail -f /tmp/unity-indexer.log

# Example output:
# [pipeline] ═══ Epoch 2 ═══ 2026-04-15T10:00:30.000Z
# [pipeline] Scanning blocks 45 → 62
# [pipeline] Profiles: 4
# [pipeline] Aura computed. Sales detected: 0
# [pipeline] New REP events: 5
# [rep] event from=0xf39... to=0x709... cat=0 amount=5
# [rep]   → rejected: insufficient-aura (0)
# [pipeline] REP events: 5 total, 0 accepted
# [pipeline] Merkle root: 0xabc... (4 leaves)
# [pipeline] ✓ Epoch 2 complete in 312ms
```

---

## Faucet

Any wallet (including wallets not in this guide) can call the public faucet on the FakeUNI contract to self-mint up to 10 000 fUNI per hour.

```bash
# Get the FakeUNI address
FAKE_UNI=$(grep FAKE_UNI_ADDRESS .env.local | cut -d= -f2)

# Mint 1 000 fUNI to yourself (replace with your address)
cast send "$FAKE_UNI" "faucet(uint256)" 1000000000000000000000 \
  --rpc-url http://127.0.0.1:8545 \
  --private-key 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
```

---

## Reset everything

Anvil is stateless. Restarting it gives you a blank chain. To do a full reset:

```bash
# Kill background processes
kill $(cat /tmp/unity-anvil.pid 2>/dev/null) 2>/dev/null || true
kill $(cat /tmp/unity-indexer.pid 2>/dev/null) 2>/dev/null || true
kill $(cat /tmp/unity-api.pid 2>/dev/null) 2>/dev/null || true

# Wipe Postgres data
docker compose down -v

# Start fresh
./scripts/local-dev.sh
```

---

## Troubleshooting

**"Cannot connect to the Docker daemon"**
Start Docker Desktop first.

**"forge: command not found"**
Run `foundryup` and restart your terminal.

**"bun: command not found"**
Install Bun: `curl -fsSL https://bun.sh/install | bash` and restart your terminal.

**API returns empty leaderboard or profiles**
The indexer hasn't run yet. Wait for the first epoch (~35 seconds) and retry.

**REP events show `insufficient-aura` in the logs**
Expected for epoch 1 (no prior snapshot = 0 Aura). Aura appears from epoch 2 onwards and REP events begin counting in epoch 3.

**Anvil resets between restarts (addresses change)**
Re-run `./scripts/local-dev.sh` — it re-deploys and updates `.env.local` automatically.

**"postRoot reverts"**
The indexer's POSTER_PRIVATE_KEY must match the poster set in RootRegistry. The startup script ensures this — if you're running manually, verify `.env.local` has the correct key (account #9).

**Port 8545 or 3001 already in use**
```bash
lsof -ti:8545 | xargs kill -9
lsof -ti:3001 | xargs kill -9
```
Then rerun the startup script.
