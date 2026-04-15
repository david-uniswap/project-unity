-- =============================================================================
-- Project Unity — PostgreSQL Schema
-- =============================================================================
-- Run once against an empty database:
--   psql $DATABASE_URL -f db/schema.sql

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------

CREATE EXTENSION IF NOT EXISTS "pg_trgm"; -- for fuzzy username search

-- ---------------------------------------------------------------------------
-- profiles
-- ---------------------------------------------------------------------------
-- One row per registered profile. primary_wallet is the profile identity key —
-- it must match what ProfileRegistry emits in NameRegistered events.

CREATE TABLE IF NOT EXISTS profiles (
    id               SERIAL PRIMARY KEY,
    username         VARCHAR(20)  UNIQUE NOT NULL,
    primary_wallet   VARCHAR(42)  UNIQUE NOT NULL,  -- checksummed EIP-55
    linked_wallet    VARCHAR(42)  UNIQUE,            -- null if no second wallet
    created_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_profiles_primary_wallet ON profiles (LOWER(primary_wallet));
CREATE INDEX IF NOT EXISTS idx_profiles_linked_wallet  ON profiles (LOWER(linked_wallet)) WHERE linked_wallet IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_profiles_username_trgm  ON profiles USING gin (username gin_trgm_ops);

-- ---------------------------------------------------------------------------
-- epochs
-- ---------------------------------------------------------------------------
-- One row per posted epoch. root is the Merkle root posted to RootRegistry.

CREATE TABLE IF NOT EXISTS epochs (
    epoch_number   BIGINT       PRIMARY KEY,
    root           CHAR(66)     NOT NULL,    -- '0x' + 64 hex chars
    posted_at      TIMESTAMPTZ  NOT NULL,    -- block.timestamp of the onchain post
    dataset_hash   CHAR(66),                 -- keccak256 of the full dataset JSON
    config_hash    CHAR(66),                 -- keccak256 of the config used
    leaf_count     INTEGER      NOT NULL DEFAULT 0,
    created_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- ---------------------------------------------------------------------------
-- aura_snapshots
-- ---------------------------------------------------------------------------
-- Aura state per profile per epoch. All token amounts stored as NUMERIC(38,0)
-- to represent uint256 values (wei-scale integers); aura is scaled by 1e18.

CREATE TABLE IF NOT EXISTS aura_snapshots (
    id                 SERIAL       PRIMARY KEY,
    profile_id         INTEGER      NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    epoch_number       BIGINT       NOT NULL REFERENCES epochs(epoch_number),
    aura               NUMERIC(78, 0)  NOT NULL DEFAULT 0,  -- scaled by 1e18
    uni_balance        NUMERIC(78, 0)  NOT NULL DEFAULT 0,  -- raw wallet balance, wei-scale
    lp_balance         NUMERIC(78, 0)  NOT NULL DEFAULT 0,  -- UNI in approved LP positions, wei-scale
    effective_balance  NUMERIC(78, 0)  NOT NULL DEFAULT 0,  -- wallet + lp + lending (for sale detection)
    sale_detected      BOOLEAN      NOT NULL DEFAULT FALSE,
    created_at         TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    UNIQUE(profile_id, epoch_number)
);

CREATE INDEX IF NOT EXISTS idx_aura_snapshots_epoch   ON aura_snapshots (epoch_number);
CREATE INDEX IF NOT EXISTS idx_aura_snapshots_profile ON aura_snapshots (profile_id);

-- ---------------------------------------------------------------------------
-- rep_events
-- ---------------------------------------------------------------------------
-- Raw REP events ingested from RepEmitter contract logs.
-- The indexer validates and filters these before counting toward rep_totals.

CREATE TABLE IF NOT EXISTS rep_events (
    id               SERIAL       PRIMARY KEY,
    from_address     VARCHAR(42)  NOT NULL,
    to_address       VARCHAR(42)  NOT NULL,
    category         SMALLINT     NOT NULL CHECK (category BETWEEN 0 AND 5),
    amount           BIGINT       NOT NULL,   -- signed integer REP units
    tx_hash          CHAR(66)     NOT NULL,
    block_number     BIGINT       NOT NULL,
    log_index        INTEGER      NOT NULL,
    block_timestamp  TIMESTAMPTZ  NOT NULL,
    counted          BOOLEAN      NOT NULL DEFAULT FALSE,  -- true if indexer accepted it
    rejection_reason TEXT,                                  -- non-null if not counted
    created_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    UNIQUE(tx_hash, log_index)
);

CREATE INDEX IF NOT EXISTS idx_rep_events_from    ON rep_events (LOWER(from_address));
CREATE INDEX IF NOT EXISTS idx_rep_events_to      ON rep_events (LOWER(to_address));
CREATE INDEX IF NOT EXISTS idx_rep_events_block   ON rep_events (block_number);
CREATE INDEX IF NOT EXISTS idx_rep_events_category ON rep_events (category);

-- ---------------------------------------------------------------------------
-- rep_totals
-- ---------------------------------------------------------------------------
-- Aggregated REP per profile per category. Recomputed each epoch from rep_events.

CREATE TABLE IF NOT EXISTS rep_totals (
    profile_id   INTEGER   NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    category     SMALLINT  NOT NULL CHECK (category BETWEEN 0 AND 5),
    total        BIGINT    NOT NULL DEFAULT 0,  -- net sum (can be negative)
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (profile_id, category)
);

-- ---------------------------------------------------------------------------
-- rep_allowances
-- ---------------------------------------------------------------------------
-- Tracks how much REP each giver has spent vs their Aura allowance.
-- The indexer updates this each epoch after computing Aura.

CREATE TABLE IF NOT EXISTS rep_allowances (
    profile_id    INTEGER   NOT NULL REFERENCES profiles(id) ON DELETE CASCADE PRIMARY KEY,
    aura_floor    NUMERIC(78, 0)  NOT NULL DEFAULT 0,  -- Aura at last epoch (1e18 scaled)
    rep_spent     BIGINT    NOT NULL DEFAULT 0,         -- sum of abs(amount) for counted events
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ---------------------------------------------------------------------------
-- rep_graph
-- ---------------------------------------------------------------------------
-- Directional REP relationships between profiles for the graph view.
-- Net amount = sum of signed REP from one profile to another per category.

CREATE TABLE IF NOT EXISTS rep_graph (
    from_profile_id  INTEGER   NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    to_profile_id    INTEGER   NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    category         SMALLINT  NOT NULL CHECK (category BETWEEN 0 AND 5),
    net_amount       BIGINT    NOT NULL DEFAULT 0,
    event_count      INTEGER   NOT NULL DEFAULT 0,
    last_event_at    TIMESTAMPTZ,
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (from_profile_id, to_profile_id, category)
);

CREATE INDEX IF NOT EXISTS idx_rep_graph_to      ON rep_graph (to_profile_id);
CREATE INDEX IF NOT EXISTS idx_rep_graph_from    ON rep_graph (from_profile_id);

-- ---------------------------------------------------------------------------
-- merkle_proofs
-- ---------------------------------------------------------------------------
-- Cached Merkle proofs per profile per epoch. Served by the API.

CREATE TABLE IF NOT EXISTS merkle_proofs (
    profile_id    INTEGER   NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    epoch_number  BIGINT    NOT NULL REFERENCES epochs(epoch_number),
    proof         JSONB     NOT NULL,   -- array of 0x-prefixed hex strings
    leaf          CHAR(66)  NOT NULL,   -- the leaf hash
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (profile_id, epoch_number)
);

-- ---------------------------------------------------------------------------
-- indexer_state
-- ---------------------------------------------------------------------------
-- Key-value store for the indexer's checkpointing state.
-- Keys used:
--   "last_block"         — last block fully processed for events
--   "last_epoch"         — last epoch number processed by pipeline
--   "pipeline_running"   — "1" if pipeline is currently running (advisory lock)

CREATE TABLE IF NOT EXISTS indexer_state (
    key         VARCHAR(64)  PRIMARY KEY,
    value       TEXT         NOT NULL,
    updated_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- Seed the initial indexer state.
INSERT INTO indexer_state (key, value)
VALUES ('last_block', '0'), ('last_epoch', '0')
ON CONFLICT (key) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Views
-- ---------------------------------------------------------------------------

-- Leaderboard view: latest aura per profile (most recent snapshot only).
CREATE OR REPLACE VIEW leaderboard_aura AS
SELECT
    p.id          AS profile_id,
    p.username,
    p.primary_wallet,
    p.linked_wallet,
    s.aura,
    s.epoch_number,
    s.sale_detected
FROM profiles p
JOIN LATERAL (
    SELECT aura, epoch_number, sale_detected
    FROM aura_snapshots
    WHERE profile_id = p.id
    ORDER BY epoch_number DESC
    LIMIT 1
) s ON TRUE
ORDER BY s.aura DESC;

-- REP leaderboard: total positive REP received per profile.
CREATE OR REPLACE VIEW leaderboard_rep AS
SELECT
    p.id          AS profile_id,
    p.username,
    p.primary_wallet,
    SUM(GREATEST(rt.total, 0)) AS total_positive_rep,
    SUM(rt.total)               AS net_rep
FROM profiles p
JOIN rep_totals rt ON rt.profile_id = p.id
GROUP BY p.id, p.username, p.primary_wallet
ORDER BY total_positive_rep DESC;

-- Per-category REP leaderboard.
CREATE OR REPLACE VIEW leaderboard_rep_by_category AS
SELECT
    p.id          AS profile_id,
    p.username,
    p.primary_wallet,
    rt.category,
    rt.total
FROM profiles p
JOIN rep_totals rt ON rt.profile_id = p.id
ORDER BY rt.category, rt.total DESC;
