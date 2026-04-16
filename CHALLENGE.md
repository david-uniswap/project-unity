# Contesting a Root Hash

Every epoch, the indexer computes each profile's Aura and REP, builds a Merkle tree, and posts the root onchain. If you believe a root is wrong, you can challenge it and earn rewards for protecting the system.

## How it works

```
You (anyone)                         Protocol
    |                                    |
    |-- submitChallenge(epoch, root) --> |
    |                                    |-- re-runs snapshot computation
    |                                    |
    |   if your root is correct:         |
    |   <-- acceptChallenge(id) ---------|
    |   +1,000 Aura + 1,000 Builder REP |
    |                                    |
    |   if the posted root was correct:  |
    |   <-- rejectChallenge(id, reason) -|
```

## Step by step

### 1. Get the epoch data

Every root has a `datasetHash` posted alongside it. This is the keccak256 of the full sorted dataset that produced the tree. You can read it onchain:

```bash
cast call $ROOT_REGISTRY "getEpochInfo(uint256)(bytes32,bytes32,uint256)" 1 --rpc-url $RPC
```

Or fetch the artifact from the API:

```bash
curl http://localhost:3001/api/epochs/current | jq
```

### 2. Independently reconstruct the tree

The indexer publishes full epoch artifacts at `indexer/artifacts/epoch-N.json`. Each artifact contains every profile's Aura, REP totals, and Merkle proof. To verify:

1. Read onchain balances for all registered profiles (FakeUNI + LP positions)
2. Compute Aura using the published rate (1e18 / 1,440,000 per fUNI per epoch)
3. Validate REP events against Aura allowances
4. Build the Merkle tree using `@openzeppelin/merkle-tree` StandardMerkleTree
5. Compare your root against the posted root

If they differ, you have a valid challenge.

### 3. Submit the challenge

```bash
cast send $CHALLENGE_REGISTRY \
  "submitChallenge(uint256,bytes32,bytes32)(uint256)" \
  <epoch> <your-correct-root> <evidence-hash> \
  --rpc-url $RPC \
  --private-key $YOUR_KEY
```

- `epoch` -- the epoch number you're contesting
- `your-correct-root` -- the Merkle root you computed
- `evidence-hash` -- keccak256 of your evidence (link to writeup, IPFS CID, etc.)

### 4. Resolution

The protocol owner re-runs the snapshot computation. If your root is correct:

- **1,000 Aura** credited permanently to your profile (immune to sale resets)
- **1,000 Builder REP** granted via the RepEmitter contract
- Both rewards are automatic -- emitted as onchain events and indexed in the next epoch

## Why this works

**Everything is verifiable.** The `datasetHash` posted with each root is a deterministic hash of the full dataset (all profiles sorted by address, with Aura and REP values). Anyone can reconstruct the exact same tree from public onchain data (balances, events) and compare.

**Challengers are rewarded.** Finding a bad root earns meaningful Aura and REP. This creates a financial incentive to audit every epoch, turning the community into a distributed verification layer.

**The inputs are all onchain.** fUNI balances, profile registrations, REP events, and LP positions are all readable from public contract state and event logs. No hidden data, no trust assumptions beyond the snapshot computation logic itself (which is open source).

**Multiple challengers per epoch.** If a root is wrong, anyone can challenge it -- not just one person. Each challenge is resolved independently.

## Contracts

| Contract | Purpose |
|----------|---------|
| `RootRegistry` | Stores roots + dataset hashes per epoch |
| `ChallengeRegistry` | Submit/accept/reject challenges |
| `CheckpointVerifier` | Verify Merkle proofs onchain |

## API endpoints

```bash
# View all challenges
curl http://localhost:3001/api/challenges | jq

# View challenges for a specific epoch
curl "http://localhost:3001/api/challenges?epoch=1" | jq

# Get your Merkle proof (to verify your leaf is in the tree)
curl http://localhost:3001/api/profiles/alice/proof | jq
```
