#!/usr/bin/env bash
# =============================================================================
# Project Unity — One-time setup script
# =============================================================================
# Run this once after cloning:
#   chmod +x setup.sh && ./setup.sh
#
# Pre-requisites: bun, git, docker (optional for local db)

set -euo pipefail

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

log()  { echo -e "${GREEN}[setup]${NC} $*"; }
warn() { echo -e "${YELLOW}[setup]${NC} $*"; }
err()  { echo -e "${RED}[setup]${NC} $*" >&2; exit 1; }

# ---------------------------------------------------------------------------
# 1. Check bun
# ---------------------------------------------------------------------------

if ! command -v bun &>/dev/null; then
  err "bun is not installed. Install it: curl -fsSL https://bun.sh/install | bash"
fi
log "bun $(bun --version) ✓"

# ---------------------------------------------------------------------------
# 2. Install Foundry (forge, cast, anvil)
# ---------------------------------------------------------------------------

if ! command -v forge &>/dev/null; then
  warn "Foundry not found — installing via foundryup..."
  curl -L https://foundry.paradigm.xyz | bash
  # Source the updated PATH
  export PATH="$HOME/.foundry/bin:$PATH"
  foundryup
  log "Foundry installed ✓"
else
  log "forge $(forge --version) ✓"
fi

# ---------------------------------------------------------------------------
# 3. Install contract dependencies (forge)
# ---------------------------------------------------------------------------

log "Installing Foundry submodules..."
cd contracts
forge install foundry-rs/forge-std --no-commit 2>/dev/null || true
forge install OpenZeppelin/openzeppelin-contracts@v5.2.0 --no-commit 2>/dev/null || true
cd ..
log "Contract dependencies installed ✓"

# ---------------------------------------------------------------------------
# 4. Install indexer dependencies
# ---------------------------------------------------------------------------

log "Installing indexer dependencies..."
cd indexer && bun install && cd ..
log "Indexer dependencies installed ✓"

# ---------------------------------------------------------------------------
# 5. Install API dependencies
# ---------------------------------------------------------------------------

log "Installing API dependencies..."
cd api && bun install && cd ..
log "API dependencies installed ✓"

# ---------------------------------------------------------------------------
# 6. Prepare .env
# ---------------------------------------------------------------------------

if [ ! -f .env ]; then
  cp .env.example .env
  warn ".env created from .env.example — fill in your RPC URL and contract addresses"
else
  log ".env already exists ✓"
fi

# ---------------------------------------------------------------------------
# 7. Start Postgres (Docker)
# ---------------------------------------------------------------------------

if command -v docker &>/dev/null; then
  log "Starting Postgres via Docker..."
  docker compose up -d postgres
  log "Waiting for Postgres to be healthy..."
  for i in {1..20}; do
    if docker compose exec postgres pg_isready -U unity -d unity &>/dev/null 2>&1; then
      log "Postgres is ready ✓"
      break
    fi
    sleep 1
  done
else
  warn "Docker not found — start Postgres manually and run: psql \$DATABASE_URL -f db/schema.sql"
fi

# ---------------------------------------------------------------------------
# 8. Build contracts (smoke test)
# ---------------------------------------------------------------------------

log "Building contracts..."
if command -v forge &>/dev/null; then
  cd contracts && forge build 2>&1 | tail -5 && cd ..
  log "Contracts compile ✓"
else
  warn "forge not in PATH — add ~/.foundry/bin to PATH and run: cd contracts && forge build"
fi

# ---------------------------------------------------------------------------
# Done
# ---------------------------------------------------------------------------

echo ""
echo -e "${GREEN}═══════════════════════════════════════════════${NC}"
echo -e "${GREEN}  Project Unity setup complete!${NC}"
echo -e "${GREEN}═══════════════════════════════════════════════${NC}"
echo ""
echo "Next steps:"
echo "  1. Edit .env — add SEPOLIA_RPC_URL and DEPLOYER_PRIVATE_KEY"
echo "  2. Deploy contracts:"
echo "       cd contracts && forge script script/Deploy.s.sol --rpc-url \$SEPOLIA_RPC_URL --broadcast"
echo "  3. Copy the deployed addresses into .env"
echo "  4. Start the indexer:"
echo "       cd indexer && bun run dev"
echo "  5. Start the API:"
echo "       cd api && bun run dev"
echo ""
echo "Or run everything with Docker:"
echo "  docker compose up"
echo ""
