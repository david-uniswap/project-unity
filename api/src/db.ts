/**
 * db.ts — Postgres connection and read queries for the API.
 * All queries are read-only (SELECT / views). Writes go through the indexer.
 */

import postgres from "postgres";

const DATABASE_URL = process.env["DATABASE_URL"];
if (!DATABASE_URL) throw new Error("Missing DATABASE_URL");

export const sql = postgres(DATABASE_URL, { max: 10, idle_timeout: 20 });

// ---------------------------------------------------------------------------
// Leaderboard
// ---------------------------------------------------------------------------

export async function getAuraLeaderboard(limit = 50, offset = 0) {
  return sql`
    SELECT
      profile_id   AS "profileId",
      username,
      primary_wallet AS "primaryWallet",
      linked_wallet  AS "linkedWallet",
      aura::text,
      epoch_number   AS "epochNumber",
      sale_detected  AS "saleDetected"
    FROM leaderboard_aura
    LIMIT ${limit} OFFSET ${offset}
  `;
}

export async function getRepLeaderboard(limit = 50, offset = 0) {
  return sql`
    SELECT
      profile_id           AS "profileId",
      username,
      primary_wallet       AS "primaryWallet",
      total_positive_rep::text AS "totalPositiveRep",
      net_rep::text        AS "netRep"
    FROM leaderboard_rep
    LIMIT ${limit} OFFSET ${offset}
  `;
}

export async function getRepLeaderboardByCategory(category: number, limit = 50, offset = 0) {
  return sql`
    SELECT
      profile_id    AS "profileId",
      username,
      primary_wallet AS "primaryWallet",
      total::text
    FROM leaderboard_rep_by_category
    WHERE category = ${category}
    ORDER BY total DESC
    LIMIT ${limit} OFFSET ${offset}
  `;
}

// ---------------------------------------------------------------------------
// Profiles
// ---------------------------------------------------------------------------

export async function getProfileByUsername(username: string) {
  // Usernames are enforced lowercase-only by the ProfileRegistry contract, so
  // lowercasing the input here means /api/profiles/Carol resolves to "carol".
  const lower = username.toLowerCase();
  const rows = await sql`
    SELECT
      p.id,
      p.username,
      p.primary_wallet  AS "primaryWallet",
      p.linked_wallet   AS "linkedWallet",
      p.created_at      AS "createdAt",
      s.aura::text,
      s.epoch_number    AS "epochNumber",
      s.sale_detected   AS "saleDetected"
    FROM profiles p
    LEFT JOIN LATERAL (
      SELECT aura, epoch_number, sale_detected
      FROM aura_snapshots
      WHERE profile_id = p.id
      ORDER BY epoch_number DESC
      LIMIT 1
    ) s ON TRUE
    WHERE p.username = ${lower}
    LIMIT 1
  `;
  return rows[0] ?? null;
}

export async function getProfileByWallet(wallet: string) {
  const lower = wallet.toLowerCase();
  const rows = await sql`
    SELECT
      p.id,
      p.username,
      p.primary_wallet  AS "primaryWallet",
      p.linked_wallet   AS "linkedWallet",
      p.created_at      AS "createdAt",
      s.aura::text,
      s.epoch_number    AS "epochNumber",
      s.sale_detected   AS "saleDetected"
    FROM profiles p
    LEFT JOIN LATERAL (
      SELECT aura, epoch_number, sale_detected
      FROM aura_snapshots
      WHERE profile_id = p.id
      ORDER BY epoch_number DESC
      LIMIT 1
    ) s ON TRUE
    WHERE p.primary_wallet = ${lower}
       OR p.linked_wallet  = ${lower}
    LIMIT 1
  `;
  return rows[0] ?? null;
}

export async function getProfileRepBreakdown(profileId: number) {
  return sql`
    SELECT category, total::text
    FROM rep_totals
    WHERE profile_id = ${profileId}
    ORDER BY category
  `;
}

export async function getProfileAuraHistory(profileId: number, limit = 144) {
  return sql`
    SELECT
      epoch_number   AS "epochNumber",
      aura::text,
      sale_detected  AS "saleDetected",
      uni_balance::text   AS "uniBalance",
      lp_balance::text    AS "lpBalance",
      created_at
    FROM aura_snapshots
    WHERE profile_id = ${profileId}
    ORDER BY epoch_number DESC
    LIMIT ${limit}
  `;
}

// ---------------------------------------------------------------------------
// Epochs
// ---------------------------------------------------------------------------

export async function getCurrentEpoch() {
  const rows = await sql`
    SELECT
      epoch_number AS "epochNumber",
      root,
      posted_at    AS "postedAt",
      dataset_hash AS "datasetHash",
      config_hash  AS "configHash",
      leaf_count   AS "leafCount"
    FROM epochs
    ORDER BY epoch_number DESC
    LIMIT 1
  `;
  return rows[0] ?? null;
}

export async function getEpochByNumber(epochNumber: number) {
  const rows = await sql`
    SELECT
      epoch_number AS "epochNumber",
      root,
      posted_at    AS "postedAt",
      dataset_hash AS "datasetHash",
      config_hash  AS "configHash",
      leaf_count   AS "leafCount"
    FROM epochs
    WHERE epoch_number = ${epochNumber}
    LIMIT 1
  `;
  return rows[0] ?? null;
}

export async function listEpochs(limit = 20, offset = 0) {
  return sql`
    SELECT
      epoch_number AS "epochNumber",
      root,
      posted_at    AS "postedAt",
      leaf_count   AS "leafCount"
    FROM epochs
    ORDER BY epoch_number DESC
    LIMIT ${limit} OFFSET ${offset}
  `;
}

// ---------------------------------------------------------------------------
// Merkle proofs
// ---------------------------------------------------------------------------

export async function getMerkleProof(profileId: number, epochNumber?: number) {
  if (epochNumber !== undefined) {
    const rows = await sql`
      SELECT proof, leaf
      FROM merkle_proofs
      WHERE profile_id = ${profileId} AND epoch_number = ${epochNumber}
      LIMIT 1
    `;
    return rows[0] ?? null;
  }
  // Latest epoch.
  const rows = await sql`
    SELECT proof, leaf, epoch_number AS "epochNumber"
    FROM merkle_proofs
    WHERE profile_id = ${profileId}
    ORDER BY epoch_number DESC
    LIMIT 1
  `;
  return rows[0] ?? null;
}

// ---------------------------------------------------------------------------
// REP events
// ---------------------------------------------------------------------------

export async function listRepEvents(opts: {
  from?: string;
  to?: string;
  category?: number;
  limit?: number;
  offset?: number;
  countedOnly?: boolean;
}) {
  const { from, to, category, limit = 50, offset = 0, countedOnly = true } = opts;

  return sql`
    SELECT
      id,
      from_address   AS "fromAddress",
      to_address     AS "toAddress",
      category,
      amount::text,
      tx_hash        AS "txHash",
      block_number   AS "blockNumber",
      block_timestamp AS "blockTimestamp",
      counted,
      rejection_reason AS "rejectionReason"
    FROM rep_events
    WHERE
      (${from ?? null}::text IS NULL OR from_address = ${from?.toLowerCase() ?? ""})
      AND (${to ?? null}::text IS NULL OR to_address = ${to?.toLowerCase() ?? ""})
      AND (${category ?? null}::integer IS NULL OR category = ${category ?? 0})
      AND (${countedOnly ? true : null}::boolean IS NULL OR counted = ${countedOnly})
    ORDER BY block_number DESC, log_index DESC
    LIMIT ${limit} OFFSET ${offset}
  `;
}

// ---------------------------------------------------------------------------
// REP graph
// ---------------------------------------------------------------------------

export async function getRepGraph(opts: {
  profileId?: number;
  category?: number;
  minAmount?: number;
}) {
  const { profileId, category, minAmount = 0 } = opts;
  return sql`
    SELECT
      rg.from_profile_id  AS "fromProfileId",
      fp.username         AS "fromUsername",
      fp.primary_wallet   AS "fromWallet",
      rg.to_profile_id    AS "toProfileId",
      tp.username         AS "toUsername",
      tp.primary_wallet   AS "toWallet",
      rg.category,
      rg.net_amount::text AS "netAmount",
      rg.event_count      AS "eventCount",
      rg.last_event_at    AS "lastEventAt"
    FROM rep_graph rg
    JOIN profiles fp ON fp.id = rg.from_profile_id
    JOIN profiles tp ON tp.id = rg.to_profile_id
    WHERE
      (${profileId ?? null}::integer IS NULL
        OR rg.from_profile_id = ${profileId ?? 0}
        OR rg.to_profile_id   = ${profileId ?? 0})
      AND (${category ?? null}::integer IS NULL OR rg.category = ${category ?? 0})
      AND ABS(rg.net_amount) >= ${minAmount}
    ORDER BY ABS(rg.net_amount) DESC
    LIMIT 500
  `;
}

export async function searchProfiles(query: string, limit = 10) {
  return sql`
    SELECT
      id,
      username,
      primary_wallet AS "primaryWallet"
    FROM profiles
    WHERE username ILIKE ${"%" + query + "%"}
    ORDER BY username
    LIMIT ${limit}
  `;
}

// ---------------------------------------------------------------------------
// Challenges
// ---------------------------------------------------------------------------

export async function listChallenges(opts: {
  status?: string;
  epochNumber?: number;
  limit?: number;
  offset?: number;
}) {
  const { status, epochNumber, limit = 50, offset = 0 } = opts;
  return sql`
    SELECT
      id,
      challenger_address  AS "challengerAddress",
      epoch_number        AS "epochNumber",
      claimed_correct_root AS "claimedCorrectRoot",
      evidence_hash       AS "evidenceHash",
      tx_hash             AS "txHash",
      block_number        AS "blockNumber",
      submitted_at        AS "submittedAt",
      status,
      resolved_tx_hash    AS "resolvedTxHash",
      resolved_at         AS "resolvedAt",
      rejection_reason    AS "rejectionReason",
      created_at          AS "createdAt"
    FROM challenges
    WHERE
      (${status ?? null}::text IS NULL OR status = ${status ?? ""})
      AND (${epochNumber ?? null}::bigint IS NULL OR epoch_number = ${epochNumber ?? 0})
    ORDER BY submitted_at DESC
    LIMIT ${limit} OFFSET ${offset}
  `;
}

export async function getChallengeById(id: number | bigint) {
  const rows = await sql`
    SELECT
      id,
      challenger_address  AS "challengerAddress",
      epoch_number        AS "epochNumber",
      claimed_correct_root AS "claimedCorrectRoot",
      evidence_hash       AS "evidenceHash",
      tx_hash             AS "txHash",
      block_number        AS "blockNumber",
      submitted_at        AS "submittedAt",
      status,
      resolved_tx_hash    AS "resolvedTxHash",
      resolved_at         AS "resolvedAt",
      rejection_reason    AS "rejectionReason",
      created_at          AS "createdAt"
    FROM challenges
    WHERE id = ${id.toString()}
    LIMIT 1
  `;
  return rows[0] ?? null;
}

export async function getEpochChallengeSummary(epochNumber: number) {
  const rows = await sql`
    SELECT
      epoch_number        AS "epochNumber",
      root,
      dataset_hash        AS "datasetHash",
      total_challenges    AS "totalChallenges",
      pending_challenges  AS "pendingChallenges",
      accepted_challenges AS "acceptedChallenges",
      rejected_challenges AS "rejectedChallenges"
    FROM epoch_challenges
    WHERE epoch_number = ${epochNumber}
    LIMIT 1
  `;
  return rows[0] ?? null;
}
