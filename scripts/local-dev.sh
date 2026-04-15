#!/usr/bin/env bash
# =============================================================================
# local-dev.sh — One-command local development stack
# =============================================================================
# Starts Anvil, deploys contracts, seeds accounts, starts Postgres + indexer +
# API, then runs a sample challenge so frontend devs have data to explore.
#
# Usage:
#   ./scripts/local-dev.sh
#
# Prerequisites:
#   - Foundry (forge, anvil, cast) — https://getfoundry.sh
#   - Docker + Docker Compose
#   - Bun — https://bun.sh
#   - jq — brew install jq
# =============================================================================

set -euo pipefail

# Pull in standard tool install locations — covers the case where the user
# installed Foundry or Bun but hasn't restarted their terminal yet.
export PATH="$HOME/.foundry/bin:$HOME/.bun/bin:$PATH"
# Extract PATH additions from shell configs without sourcing the full files
# (sourcing .zshrc hangs in non-interactive bash due to plugins/prompts).
for rc in "$HOME/.zshenv" "$HOME/.zshrc" "$HOME/.profile"; do
    [ -f "$rc" ] && eval "$(grep -E '^\s*export\s+PATH=' "$rc" 2>/dev/null)" 2>/dev/null || true
done

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_LOCAL="$REPO_ROOT/.env.local"
BROADCAST_JSON="$REPO_ROOT/contracts/broadcast/LocalSetup.s.sol/31337/run-latest.json"
ANVIL_PID_FILE="/tmp/unity-anvil.pid"
INDEXER_PID_FILE="/tmp/unity-indexer.pid"
API_PID_FILE="/tmp/unity-api.pid"
ECO_PID_FILE="/tmp/unity-ecosystem.pid"
RPC="http://127.0.0.1:8545"

# ── Colors ────────────────────────────────────────────────────────────────────
GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; RED='\033[0;31m'; RESET='\033[0m'
ok()   { echo -e "${GREEN}✓${RESET} $*"; }
step() { echo -e "\n${CYAN}▶${RESET} $*"; }
warn() { echo -e "${YELLOW}!${RESET} $*"; }
fail() { echo -e "${RED}✗${RESET} $*"; }

trap 'echo -e "\n${RED}ERROR${RESET}: script failed at line $LINENO" >&2' ERR

# ── Prerequisite check ────────────────────────────────────────────────────────
step "Checking prerequisites..."

missing=()
for cmd in forge anvil cast docker bun jq; do
    if ! command -v "$cmd" &>/dev/null; then
        missing+=("$cmd")
    fi
done

if [ ${#missing[@]} -gt 0 ]; then
    echo ""
    for cmd in "${missing[@]}"; do
        fail "'$cmd' not found"
        case "$cmd" in
            forge|anvil|cast)
                echo "       Install Foundry:"
                echo "         curl -L https://foundry.paradigm.xyz | bash"
                echo "         source ~/.zshenv"
                echo "         foundryup"
                ;;
            bun)
                echo "       Install Bun:"
                echo "         curl -fsSL https://bun.sh/install | bash"
                echo "         source ~/.zshenv"
                ;;
            jq)
                echo "       Install jq:  brew install jq"
                ;;
            docker)
                echo "       Install Docker Desktop: https://www.docker.com/products/docker-desktop"
                ;;
        esac
    done
    echo ""
    echo "After installing, re-run:  ./scripts/local-dev.sh"
    exit 1
fi
ok "All prerequisites found"

# ── Stop any existing processes ───────────────────────────────────────────────
for pid_file in "$ANVIL_PID_FILE" "$INDEXER_PID_FILE" "$API_PID_FILE" "$ECO_PID_FILE"; do
    if [ -f "$pid_file" ]; then
        pid=$(cat "$pid_file")
        kill "$pid" 2>/dev/null || true
        rm -f "$pid_file"
    fi
done
# Kill orphaned bun processes from previous runs (subshell PIDs don't always
# propagate SIGTERM to child bun processes, leaving them alive as orphans).
pkill -f "ecosystem-activity" 2>/dev/null || true
pkill -f "unity.*index\.ts" 2>/dev/null || true
lsof -ti:8545 2>/dev/null | xargs kill -9 2>/dev/null || true
lsof -ti:3001 2>/dev/null | xargs kill -9 2>/dev/null || true
sleep 1

# ── Start Anvil (instant-mine mode for fast deployment) ──────────────────────
step "Starting Anvil local node..."
anvil \
    --host 0.0.0.0 \
    --chain-id 31337 \
    --accounts 30 \
    --balance 10000 \
    --silent \
    &
echo $! > "$ANVIL_PID_FILE"

# Wait for Anvil to be ready
for i in $(seq 1 30); do
    if cast block-number --rpc-url "$RPC" &>/dev/null 2>&1; then
        break
    fi
    sleep 0.5
done
cast block-number --rpc-url "$RPC" &>/dev/null || { echo "ERROR: Anvil did not start"; exit 1; }
ok "Anvil running on $RPC (chain ID 31337, instant-mine)"

# ── Install contract dependencies ────────────────────────────────────────────
step "Installing contract dependencies..."
cd "$REPO_ROOT/contracts"
if [ ! -d "lib/openzeppelin-contracts" ]; then
    forge install OpenZeppelin/openzeppelin-contracts@v5.2.0 2>&1 | tail -3
    ok "openzeppelin-contracts installed"
else
    ok "openzeppelin-contracts already present"
fi
if [ ! -d "lib/forge-std" ]; then
    forge install foundry-rs/forge-std 2>&1 | tail -3
    ok "forge-std installed"
else
    ok "forge-std already present"
fi
cd "$REPO_ROOT"

# ── Deploy contracts ──────────────────────────────────────────────────────────
step "Deploying and seeding contracts..."
cd "$REPO_ROOT/contracts"
forge script script/LocalSetup.s.sol \
    --rpc-url "$RPC" \
    --broadcast
cd "$REPO_ROOT"
ok "Contracts deployed"

# Switch Anvil from instant-mine to 2-second block intervals.
# evm_setIntervalMining changes the mode at runtime — no restart needed.
cast rpc evm_setIntervalMining 2 --rpc-url "$RPC" &>/dev/null
ok "Anvil switched to 2-second block time"

# ── Parse addresses from broadcast JSON ───────────────────────────────────────
step "Reading contract addresses..."
if [ ! -f "$BROADCAST_JSON" ]; then
    echo "ERROR: Broadcast JSON not found at $BROADCAST_JSON"
    exit 1
fi

# Only match CREATE transactions — CALL transactions share the same contractName
# but have null contractAddress, and would produce extra lines in the variable.
FAKE_UNI_ADDRESS=$(jq -r '.transactions[] | select(.contractName=="FakeUNI" and .transactionType=="CREATE") | .contractAddress' "$BROADCAST_JSON")
PROFILE_REGISTRY_ADDRESS=$(jq -r '.transactions[] | select(.contractName=="ProfileRegistry" and .transactionType=="CREATE") | .contractAddress' "$BROADCAST_JSON")
REP_EMITTER_ADDRESS=$(jq -r '.transactions[] | select(.contractName=="RepEmitter" and .transactionType=="CREATE") | .contractAddress' "$BROADCAST_JSON")
ROOT_REGISTRY_ADDRESS=$(jq -r '.transactions[] | select(.contractName=="RootRegistry" and .transactionType=="CREATE") | .contractAddress' "$BROADCAST_JSON")
CHECKPOINT_VERIFIER_ADDRESS=$(jq -r '.transactions[] | select(.contractName=="CheckpointVerifier" and .transactionType=="CREATE") | .contractAddress' "$BROADCAST_JSON")
CHALLENGE_REGISTRY_ADDRESS=$(jq -r '.transactions[] | select(.contractName=="ChallengeRegistry" and .transactionType=="CREATE") | .contractAddress' "$BROADCAST_JSON")

echo "  FakeUNI:            $FAKE_UNI_ADDRESS"
echo "  ProfileRegistry:    $PROFILE_REGISTRY_ADDRESS"
echo "  RepEmitter:         $REP_EMITTER_ADDRESS"
echo "  RootRegistry:       $ROOT_REGISTRY_ADDRESS"
echo "  CheckpointVerifier: $CHECKPOINT_VERIFIER_ADDRESS"
echo "  ChallengeRegistry:  $CHALLENGE_REGISTRY_ADDRESS"

# ── Write addresses to .env.local ─────────────────────────────────────────────
step "Updating .env.local..."
# Use sed to replace empty var assignments in-place
sed_inplace() { sed -i.bak "$@" && rm -f "${@: -1}.bak"; }

sed_inplace "s|^FAKE_UNI_ADDRESS=.*|FAKE_UNI_ADDRESS=$FAKE_UNI_ADDRESS|" "$ENV_LOCAL"
sed_inplace "s|^PROFILE_REGISTRY_ADDRESS=.*|PROFILE_REGISTRY_ADDRESS=$PROFILE_REGISTRY_ADDRESS|" "$ENV_LOCAL"
sed_inplace "s|^REP_EMITTER_ADDRESS=.*|REP_EMITTER_ADDRESS=$REP_EMITTER_ADDRESS|" "$ENV_LOCAL"
sed_inplace "s|^ROOT_REGISTRY_ADDRESS=.*|ROOT_REGISTRY_ADDRESS=$ROOT_REGISTRY_ADDRESS|" "$ENV_LOCAL"
sed_inplace "s|^CHECKPOINT_VERIFIER_ADDRESS=.*|CHECKPOINT_VERIFIER_ADDRESS=$CHECKPOINT_VERIFIER_ADDRESS|" "$ENV_LOCAL"
sed_inplace "s|^CHALLENGE_REGISTRY_ADDRESS=.*|CHALLENGE_REGISTRY_ADDRESS=$CHALLENGE_REGISTRY_ADDRESS|" "$ENV_LOCAL"
sed_inplace "s|^PROTOCOL_GIVERS=.*|PROTOCOL_GIVERS=$CHALLENGE_REGISTRY_ADDRESS|" "$ENV_LOCAL"
ok ".env.local updated"

# ── Export env vars for subsequent steps ──────────────────────────────────────
export FAKE_UNI_ADDRESS PROFILE_REGISTRY_ADDRESS REP_EMITTER_ADDRESS
export ROOT_REGISTRY_ADDRESS CHECKPOINT_VERIFIER_ADDRESS CHALLENGE_REGISTRY_ADDRESS
export CHALLENGE_REGISTRY_ADDRESS PROTOCOL_GIVERS="$CHALLENGE_REGISTRY_ADDRESS"

# ── Start Postgres ────────────────────────────────────────────────────────────
step "Starting Postgres..."
docker compose -f "$REPO_ROOT/docker-compose.yml" up -d postgres
# Wait for Postgres to be healthy
for i in $(seq 1 30); do
    if docker compose -f "$REPO_ROOT/docker-compose.yml" exec -T postgres \
        pg_isready -U unity -d unity &>/dev/null 2>&1; then
        break
    fi
    sleep 1
done
ok "Postgres ready"

# ── Apply DB schema ───────────────────────────────────────────────────────────
step "Applying database schema..."
docker compose -f "$REPO_ROOT/docker-compose.yml" exec -T postgres \
    psql -U unity -d unity < "$REPO_ROOT/db/schema.sql" &>/dev/null
docker compose -f "$REPO_ROOT/docker-compose.yml" exec -T postgres \
    psql -U unity -d unity < "$REPO_ROOT/db/migrations/002_challenges.sql" &>/dev/null
ok "Schema applied"

# ── Start indexer ─────────────────────────────────────────────────────────────
step "Starting indexer (30-second epochs)..."
(
    cd "$REPO_ROOT/indexer"
    set -a && source "$ENV_LOCAL" && set +a
    DATABASE_URL="postgres://unity:unity@localhost:5432/unity" \
    bun run src/index.ts >> /tmp/unity-indexer.log 2>&1
) &
echo $! > "$INDEXER_PID_FILE"
ok "Indexer started → logs: tail -f /tmp/unity-indexer.log"

# ── Start API ─────────────────────────────────────────────────────────────────
step "Starting API on port 3001..."
(
    cd "$REPO_ROOT/api"
    set -a && source "$ENV_LOCAL" && set +a
    DATABASE_URL="postgres://unity:unity@localhost:5432/unity" \
    bun run src/index.ts >> /tmp/unity-api.log 2>&1
) &
echo $! > "$API_PID_FILE"

# Wait for API to respond
API_READY=0
for i in $(seq 1 20); do
    if curl -sf http://localhost:3001/api/health &>/dev/null; then
        API_READY=1
        break
    fi
    sleep 1
done
if [ "$API_READY" = "1" ]; then
    ok "API ready → http://localhost:3001"
else
    warn "API did not respond after 20 seconds — check logs: tail -f /tmp/unity-api.log"
fi

# ── Start ecosystem activity simulator ───────────────────────────────────────
step "Starting ecosystem activity simulator (20 wallets, 60-second rounds)..."
(
    cd "$REPO_ROOT/indexer"
    set -a && source "$ENV_LOCAL" && set +a
    bun run src/ecosystem-activity.ts >> /tmp/unity-ecosystem.log 2>&1
) &
echo $! > "$ECO_PID_FILE"
ok "Ecosystem activity started → logs: tail -f /tmp/unity-ecosystem.log"

# ── Wait for epoch 1 ──────────────────────────────────────────────────────────
step "Waiting for epoch 1 (indexer runs every 2 minutes)..."
for i in $(seq 1 120); do
    EPOCH=$(cast call "$ROOT_REGISTRY_ADDRESS" "currentEpoch()(uint256)" --rpc-url "$RPC" 2>/dev/null || echo "0")
    if [ "$EPOCH" != "0" ]; then
        ok "Epoch $EPOCH posted on chain"
        break
    fi
    sleep 2
done

EPOCH=$(cast call "$ROOT_REGISTRY_ADDRESS" "currentEpoch()(uint256)" --rpc-url "$RPC" 2>/dev/null || echo "0")
if [ "$EPOCH" = "0" ]; then
    warn "Epoch 1 not posted after 4 minutes. Skipping challenge seed."
    warn "You can run it manually later: forge script contracts/script/LocalChallenge.s.sol --rpc-url http://127.0.0.1:8545 --broadcast"
else
    # ── Run challenge script ──────────────────────────────────────────────────
    step "Seeding a sample challenge (Carol challenges epoch $EPOCH)..."
    cd "$REPO_ROOT/contracts"
    if CHALLENGE_REGISTRY_ADDRESS="$CHALLENGE_REGISTRY_ADDRESS" \
       ROOT_REGISTRY_ADDRESS="$ROOT_REGISTRY_ADDRESS" \
       forge script script/LocalChallenge.s.sol \
           --rpc-url "$RPC" \
           --broadcast 2>&1 | tail -5; then
        ok "Challenge submitted and accepted — Carol earns 1 000 Aura next epoch"
    else
        warn "Challenge seeding failed — stack is still running."
        warn "Run manually: cd contracts && forge script script/LocalChallenge.s.sol --rpc-url http://127.0.0.1:8545 --broadcast"
    fi
    cd "$REPO_ROOT"
fi

# ── Print summary ─────────────────────────────────────────────────────────────
echo ""
echo -e "${GREEN}════════════════════════════════════════════════════════${RESET}"
echo -e "${GREEN}  Project Unity local stack is running                  ${RESET}"
echo -e "${GREEN}════════════════════════════════════════════════════════${RESET}"
echo ""
echo "  RPC:  http://127.0.0.1:8545  (chain ID 31337)"
echo "  API:  http://localhost:3001"
echo ""
echo "  Dev wallets (10 000 ETH each, import via private key):"
echo ""
echo "  Alice  0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"
echo "         PK: 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"
echo "         fUNI: 10 000 000"
echo ""
echo "  Bob    0x70997970C51812dc3A010C7d01b50e0d17dc79C8"
echo "         PK: 0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d"
echo "         fUNI: 5 000 000"
echo ""
echo "  Carol  0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC"
echo "         PK: 0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a"
echo "         fUNI: 1 000 000"
echo ""
echo "  Dave   0x90F79bf6EB2c4f870365E785982E1f101E93b906"
echo "         PK: 0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6"
echo "         fUNI: 200 000"
echo ""
echo "  Ecosystem: 20 wallets (eco01–eco20) generating activity every 60 seconds"
echo "             Merkle trees saved to: indexer/artifacts/merkle-epoch-N.json"
echo ""
echo "  Logs:"
echo "    tail -f /tmp/unity-indexer.log    # epoch pipeline (every 2 min)"
echo "    tail -f /tmp/unity-ecosystem.log  # ecosystem activity (every 60s)"
echo "    tail -f /tmp/unity-api.log"
echo ""
echo "  To stop:  kill \$(cat /tmp/unity-anvil.pid)"
echo "            kill \$(cat /tmp/unity-ecosystem.pid)"
echo "            docker compose down"
echo ""
echo "  See LOCAL_DEV.md for full usage guide."
echo ""
