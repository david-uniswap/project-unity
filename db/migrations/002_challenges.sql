-- =============================================================================
-- Migration 002: Challenge system + Aura bonus tables
-- =============================================================================
-- Run after schema.sql:
--   psql $DATABASE_URL -f db/migrations/002_challenges.sql

-- ---------------------------------------------------------------------------
-- challenges
-- ---------------------------------------------------------------------------
-- One row per onchain ChallengeSubmitted event. Status updated when
-- ChallengeAccepted or ChallengeRejected events are ingested.

CREATE TABLE IF NOT EXISTS challenges (
    id               BIGINT       PRIMARY KEY,   -- onchain challengeId
    challenger_address VARCHAR(42) NOT NULL,
    epoch_number     BIGINT       NOT NULL REFERENCES epochs(epoch_number) DEFERRABLE INITIALLY DEFERRED,
    claimed_correct_root CHAR(66),               -- what the challenger says the root should be
    evidence_hash    CHAR(66),                   -- keccak256 of off-chain evidence
    tx_hash          CHAR(66)     NOT NULL,       -- ChallengeSubmitted tx
    block_number     BIGINT       NOT NULL,
    submitted_at     TIMESTAMPTZ  NOT NULL,
    status           VARCHAR(20)  NOT NULL DEFAULT 'pending'  -- pending | accepted | rejected
                         CHECK (status IN ('pending', 'accepted', 'rejected')),
    resolved_tx_hash CHAR(66),
    resolved_at      TIMESTAMPTZ,
    rejection_reason TEXT,
    created_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_challenges_challenger ON challenges (LOWER(challenger_address));
CREATE INDEX IF NOT EXISTS idx_challenges_epoch      ON challenges (epoch_number);
CREATE INDEX IF NOT EXISTS idx_challenges_status     ON challenges (status);

-- ---------------------------------------------------------------------------
-- aura_bonuses
-- ---------------------------------------------------------------------------
-- Permanent Aura credits granted to challengers whose challenge was accepted.
-- These additions are NOT subject to sale resets — they persist forever.
-- The indexer reads these and adds them to a profile's total Aura in the Merkle leaf.

CREATE TABLE IF NOT EXISTS aura_bonuses (
    id           SERIAL       PRIMARY KEY,
    profile_id   INTEGER      REFERENCES profiles(id) ON DELETE CASCADE,
    -- For bonuses awarded before the challenger has a profile, store raw address.
    wallet_address VARCHAR(42) NOT NULL,
    amount       NUMERIC(78, 0) NOT NULL,    -- 1e18-scaled (1 000e18 = 1 000 Aura)
    challenge_id BIGINT       REFERENCES challenges(id),
    tx_hash      CHAR(66)     NOT NULL,
    granted_at   TIMESTAMPTZ  NOT NULL,
    created_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    UNIQUE(tx_hash)  -- deduplicate on the AuraBountyGranted tx
);

CREATE INDEX IF NOT EXISTS idx_aura_bonuses_profile ON aura_bonuses (profile_id) WHERE profile_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_aura_bonuses_wallet  ON aura_bonuses (LOWER(wallet_address));

-- ---------------------------------------------------------------------------
-- View: challenge summary per epoch
-- ---------------------------------------------------------------------------

CREATE OR REPLACE VIEW epoch_challenges AS
SELECT
    e.epoch_number,
    e.root,
    e.dataset_hash,
    COUNT(c.id)                                     AS total_challenges,
    COUNT(c.id) FILTER (WHERE c.status = 'pending')  AS pending_challenges,
    COUNT(c.id) FILTER (WHERE c.status = 'accepted') AS accepted_challenges,
    COUNT(c.id) FILTER (WHERE c.status = 'rejected') AS rejected_challenges
FROM epochs e
LEFT JOIN challenges c ON c.epoch_number = e.epoch_number
GROUP BY e.epoch_number, e.root, e.dataset_hash
ORDER BY e.epoch_number DESC;
