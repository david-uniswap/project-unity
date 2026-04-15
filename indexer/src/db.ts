/**
 * db.ts — Postgres connection and all database write/read operations for the indexer.
 */

import postgres from "postgres";
import { DATABASE_URL } from "./config.ts";
import type {
  Profile,
  AuraSnapshot,
  RepEvent,
  RepTotals,
  ProfileEpochData,
} from "./types.ts";
import { REP_CATEGORIES } from "./types.ts";

const sql = postgres(DATABASE_URL, { max: 5 });

// ---------------------------------------------------------------------------
// Indexer state
// ---------------------------------------------------------------------------

export async function getState(key: string): Promise<string | null> {
  const rows = await sql`SELECT value FROM indexer_state WHERE key = ${key}`;
  return rows[0]?.value ?? null;
}

export async function setState(key: string, value: string): Promise<void> {
  await sql`
    INSERT INTO indexer_state (key, value, updated_at)
    VALUES (${key}, ${value}, NOW())
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
  `;
}

// ---------------------------------------------------------------------------
// Profiles
// ---------------------------------------------------------------------------

export async function upsertProfile(profile: {
  username: string;
  primaryWallet: string;
  linkedWallet?: string | null;
}): Promise<Profile> {
  const rows = await sql<Profile[]>`
    INSERT INTO profiles (username, primary_wallet, linked_wallet)
    VALUES (${profile.username}, ${profile.primaryWallet.toLowerCase()}, ${profile.linkedWallet?.toLowerCase() ?? null})
    ON CONFLICT (primary_wallet) DO UPDATE SET
      username      = EXCLUDED.username,
      linked_wallet = EXCLUDED.linked_wallet,
      updated_at    = NOW()
    RETURNING id, username, primary_wallet AS "primaryWallet", linked_wallet AS "linkedWallet"
  `;
  return rows[0]!;
}

export async function updateLinkedWallet(
  primaryWallet: string,
  linkedWallet: string | null
): Promise<void> {
  await sql`
    UPDATE profiles
    SET linked_wallet = ${linkedWallet?.toLowerCase() ?? null}, updated_at = NOW()
    WHERE primary_wallet = ${primaryWallet.toLowerCase()}
  `;
}

export async function getAllProfiles(): Promise<Profile[]> {
  return sql<Profile[]>`
    SELECT id, username,
           primary_wallet AS "primaryWallet",
           linked_wallet  AS "linkedWallet"
    FROM profiles
    ORDER BY id
  `;
}

export async function getProfileByWallet(wallet: string): Promise<Profile | null> {
  const rows = await sql<Profile[]>`
    SELECT id, username,
           primary_wallet AS "primaryWallet",
           linked_wallet  AS "linkedWallet"
    FROM profiles
    WHERE primary_wallet = ${wallet.toLowerCase()}
       OR linked_wallet  = ${wallet.toLowerCase()}
    LIMIT 1
  `;
  return rows[0] ?? null;
}

// ---------------------------------------------------------------------------
// Epochs
// ---------------------------------------------------------------------------

export async function insertEpoch(epoch: {
  epochNumber: bigint;
  root: string;
  postedAt: Date;
  datasetHash: string;
  configHash: string;
  leafCount: number;
}): Promise<void> {
  await sql`
    INSERT INTO epochs (epoch_number, root, posted_at, dataset_hash, config_hash, leaf_count)
    VALUES (
      ${epoch.epochNumber.toString()},
      ${epoch.root},
      ${epoch.postedAt},
      ${epoch.datasetHash},
      ${epoch.configHash},
      ${epoch.leafCount}
    )
    ON CONFLICT (epoch_number) DO NOTHING
  `;
}

// ---------------------------------------------------------------------------
// Aura snapshots
// ---------------------------------------------------------------------------

export async function getPreviousAuraSnapshot(profileId: number): Promise<{
  aura: bigint;
  effectiveBalance: bigint;
} | null> {
  const rows = await sql`
    SELECT aura, effective_balance AS "effectiveBalance"
    FROM aura_snapshots
    WHERE profile_id = ${profileId}
    ORDER BY epoch_number DESC
    LIMIT 1
  `;
  if (!rows[0]) return null;
  return {
    aura: BigInt(rows[0].aura),
    effectiveBalance: BigInt(rows[0].effectiveBalance),
  };
}

export async function insertAuraSnapshots(snapshots: AuraSnapshot[]): Promise<void> {
  if (snapshots.length === 0) return;

  const values = snapshots.map((s) => ({
    profile_id: s.profileId,
    epoch_number: s.epochNumber.toString(),
    aura: s.aura.toString(),
    uni_balance: s.uniBalance.toString(),
    lp_balance: s.lpBalance.toString(),
    effective_balance: s.effectiveBalance.toString(),
    sale_detected: s.saleDetected,
  }));

  await sql`
    INSERT INTO aura_snapshots
      (profile_id, epoch_number, aura, uni_balance, lp_balance, effective_balance, sale_detected)
    SELECT
      v.profile_id::integer,
      v.epoch_number::bigint,
      v.aura::numeric,
      v.uni_balance::numeric,
      v.lp_balance::numeric,
      v.effective_balance::numeric,
      v.sale_detected::boolean
    FROM json_to_recordset(${JSON.stringify(values)}::json) AS v(
      profile_id text, epoch_number text, aura text,
      uni_balance text, lp_balance text, effective_balance text, sale_detected boolean
    )
    ON CONFLICT (profile_id, epoch_number) DO NOTHING
  `;
}

// ---------------------------------------------------------------------------
// REP events
// ---------------------------------------------------------------------------

export async function getLastProcessedBlock(): Promise<bigint> {
  const val = await getState("last_block");
  return BigInt(val ?? "0");
}

export async function insertRepEvents(events: RepEvent[]): Promise<void> {
  if (events.length === 0) return;
  for (const e of events) {
    await sql`
      INSERT INTO rep_events
        (from_address, to_address, category, amount, tx_hash, block_number, log_index, block_timestamp)
      VALUES (
        ${e.fromAddress.toLowerCase()},
        ${e.toAddress.toLowerCase()},
        ${e.category},
        ${e.amount.toString()},
        ${e.txHash.toLowerCase()},
        ${e.blockNumber.toString()},
        ${e.logIndex},
        ${e.blockTimestamp}
      )
      ON CONFLICT (tx_hash, log_index) DO NOTHING
    `;
  }
}

export async function getAllRepEvents(): Promise<RepEvent[]> {
  const rows = await sql`
    SELECT
      id,
      from_address  AS "fromAddress",
      to_address    AS "toAddress",
      category,
      amount::bigint  AS amount,
      tx_hash       AS "txHash",
      block_number::bigint AS "blockNumber",
      log_index     AS "logIndex",
      block_timestamp AS "blockTimestamp"
    FROM rep_events
    ORDER BY block_number, log_index
  `;
  return rows.map((r) => ({
    ...r,
    amount: BigInt(r.amount),
    blockNumber: BigInt(r.blockNumber),
  })) as RepEvent[];
}

// ---------------------------------------------------------------------------
// REP totals
// ---------------------------------------------------------------------------

export async function upsertRepTotals(totals: RepTotals[]): Promise<void> {
  if (totals.length === 0) return;
  for (const t of totals) {
    for (const cat of REP_CATEGORIES) {
      const catIndex = REP_CATEGORIES.indexOf(cat);
      const amount = t[cat];
      await sql`
        INSERT INTO rep_totals (profile_id, category, total, updated_at)
        VALUES (${t.profileId}, ${catIndex}, ${amount.toString()}, NOW())
        ON CONFLICT (profile_id, category) DO UPDATE SET
          total      = EXCLUDED.total,
          updated_at = NOW()
      `;
    }
  }
}

// ---------------------------------------------------------------------------
// REP allowances (Aura-based spending cap)
// ---------------------------------------------------------------------------

export async function getRepAllowance(profileId: number): Promise<{
  auraFloor: bigint;
  repSpent: bigint;
}> {
  const rows = await sql`
    SELECT aura_floor AS "auraFloor", rep_spent AS "repSpent"
    FROM rep_allowances
    WHERE profile_id = ${profileId}
  `;
  if (!rows[0]) return { auraFloor: 0n, repSpent: 0n };
  return {
    auraFloor: BigInt(rows[0].auraFloor),
    repSpent: BigInt(rows[0].repSpent),
  };
}

export async function upsertRepAllowance(
  profileId: number,
  auraFloor: bigint,
  repSpent: bigint
): Promise<void> {
  await sql`
    INSERT INTO rep_allowances (profile_id, aura_floor, rep_spent, updated_at)
    VALUES (${profileId}, ${auraFloor.toString()}, ${repSpent.toString()}, NOW())
    ON CONFLICT (profile_id) DO UPDATE SET
      aura_floor = EXCLUDED.aura_floor,
      rep_spent  = EXCLUDED.rep_spent,
      updated_at = NOW()
  `;
}

// ---------------------------------------------------------------------------
// REP graph
// ---------------------------------------------------------------------------

export async function upsertRepGraph(
  fromProfileId: number,
  toProfileId: number,
  category: number,
  netAmount: bigint,
  eventCount: number,
  lastEventAt: Date
): Promise<void> {
  await sql`
    INSERT INTO rep_graph
      (from_profile_id, to_profile_id, category, net_amount, event_count, last_event_at, updated_at)
    VALUES (${fromProfileId}, ${toProfileId}, ${category}, ${netAmount.toString()}, ${eventCount}, ${lastEventAt}, NOW())
    ON CONFLICT (from_profile_id, to_profile_id, category) DO UPDATE SET
      net_amount   = EXCLUDED.net_amount,
      event_count  = EXCLUDED.event_count,
      last_event_at = EXCLUDED.last_event_at,
      updated_at   = NOW()
  `;
}

// ---------------------------------------------------------------------------
// Merkle proofs
// ---------------------------------------------------------------------------

export async function upsertMerkleProof(
  profileId: number,
  epochNumber: bigint,
  proof: string[],
  leaf: string
): Promise<void> {
  await sql`
    INSERT INTO merkle_proofs (profile_id, epoch_number, proof, leaf)
    VALUES (${profileId}, ${epochNumber.toString()}, ${JSON.stringify(proof)}, ${leaf})
    ON CONFLICT (profile_id, epoch_number) DO UPDATE SET
      proof = EXCLUDED.proof,
      leaf  = EXCLUDED.leaf
  `;
}

export async function markRepEventCounted(
  txHash: string,
  logIndex: number,
  counted: boolean,
  reason?: string
): Promise<void> {
  await sql`
    UPDATE rep_events
    SET counted = ${counted}, rejection_reason = ${reason ?? null}
    WHERE tx_hash = ${txHash.toLowerCase()} AND log_index = ${logIndex}
  `;
}

export default sql;
