// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {CheckpointVerifier} from "../src/CheckpointVerifier.sol";
import {RootRegistry} from "../src/RootRegistry.sol";

/// @notice Tests for CheckpointVerifier.
///
/// Proof generation strategy:
///   CheckpointVerifier uses StandardMerkleTree-compatible double keccak256 leaf hashing:
///     leaf = keccak256(bytes.concat(keccak256(abi.encode(fields...))))
///
///   For a single-leaf tree, root == leaf and proof == [].
///   This lets us post a deterministically computed root and call verifyAndCache
///   with an empty proof, fully testing the verification path in Solidity.
contract CheckpointVerifierTest is Test {
    RootRegistry rootReg;
    CheckpointVerifier verifier;

    address poster = makeAddr("poster");
    address alice = makeAddr("alice");

    // Fixed test data for constructing a valid leaf.
    uint256 constant EPOCH = 1;
    address constant PRIMARY = address(0xAAAA);
    address constant LINKED_1 = address(0);
    address constant LINKED_2 = address(0);
    bytes32 constant USERNAME_HASH = keccak256("alice");
    uint256 constant AURA = 500e18;
    int256[6] REP = [int256(10), 20, -5, 0, 3, 7];

    bytes32 validLeafHash;

    function setUp() public {
        rootReg = new RootRegistry(poster);
        verifier = new CheckpointVerifier(address(rootReg));

        // Compute the leaf hash exactly as CheckpointVerifier does.
        validLeafHash = keccak256(
            bytes.concat(
                keccak256(
                    abi.encode(
                        EPOCH,
                        PRIMARY,
                        LINKED_1,
                        LINKED_2,
                        USERNAME_HASH,
                        AURA,
                        REP[0], REP[1], REP[2], REP[3], REP[4], REP[5]
                    )
                )
            )
        );

        // For a single-leaf tree root == leaf; proof is empty.
        bytes32 datasetHash = keccak256("dataset");
        vm.prank(poster);
        rootReg.postRoot(EPOCH, validLeafHash, datasetHash);
    }

    // -------------------------------------------------------------------------
    // verifyAndCache — happy path
    // -------------------------------------------------------------------------

    function test_verifyAndCache_succeeds_withValidSingleLeafProof() public {
        bytes32[] memory proof = new bytes32[](0);
        verifier.verifyAndCache(PRIMARY, LINKED_1, LINKED_2, USERNAME_HASH, AURA, REP, proof);

        // Checkpoint was stored.
        assertEq(verifier.getAura(PRIMARY), AURA);
    }

    function test_verifyAndCache_emitsCheckpointCached() public {
        bytes32[] memory proof = new bytes32[](0);

        vm.expectEmit(true, true, false, true);
        emit CheckpointVerifier.CheckpointCached(PRIMARY, EPOCH, AURA);

        verifier.verifyAndCache(PRIMARY, LINKED_1, LINKED_2, USERNAME_HASH, AURA, REP, proof);
    }

    function test_verifyAndCache_storesAllRepCategories() public {
        bytes32[] memory proof = new bytes32[](0);
        verifier.verifyAndCache(PRIMARY, LINKED_1, LINKED_2, USERNAME_HASH, AURA, REP, proof);

        assertEq(verifier.getRep(PRIMARY, 0), REP[0]); // research
        assertEq(verifier.getRep(PRIMARY, 1), REP[1]); // builder
        assertEq(verifier.getRep(PRIMARY, 2), REP[2]); // trader
        assertEq(verifier.getRep(PRIMARY, 3), REP[3]); // liquidity
        assertEq(verifier.getRep(PRIMARY, 4), REP[4]); // governance
        assertEq(verifier.getRep(PRIMARY, 5), REP[5]); // community
    }

    function test_verifyAndCache_storesCorrectEpoch() public {
        bytes32[] memory proof = new bytes32[](0);
        verifier.verifyAndCache(PRIMARY, LINKED_1, LINKED_2, USERNAME_HASH, AURA, REP, proof);

        (uint256 epoch,,,,,,,) = verifier.checkpoints(PRIMARY);
        assertEq(epoch, EPOCH);
    }

    function test_verifyAndCache_updatesExistingCheckpoint() public {
        // First checkpoint at epoch 1.
        bytes32[] memory proof = new bytes32[](0);
        verifier.verifyAndCache(PRIMARY, LINKED_1, LINKED_2, USERNAME_HASH, AURA, REP, proof);
        assertEq(verifier.getAura(PRIMARY), AURA);

        // Advance to epoch 2: compute a NEW leaf hash (epoch is part of the leaf encoding).
        uint256 epoch2 = EPOCH + 1;
        uint256 newAura = AURA + 500e18;
        bytes32 leafEpoch2 = keccak256(
            bytes.concat(
                keccak256(
                    abi.encode(
                        epoch2,
                        PRIMARY, LINKED_1, LINKED_2,
                        USERNAME_HASH, newAura,
                        REP[0], REP[1], REP[2], REP[3], REP[4], REP[5]
                    )
                )
            )
        );

        vm.prank(poster);
        rootReg.postRoot(epoch2, leafEpoch2, keccak256("ds2"));

        // Verify again with epoch-2 data — should overwrite the cached checkpoint.
        verifier.verifyAndCache(PRIMARY, LINKED_1, LINKED_2, USERNAME_HASH, newAura, REP, proof);

        assertEq(verifier.getAura(PRIMARY), newAura);
        (uint256 cachedEpoch,,,,,,,) = verifier.checkpoints(PRIMARY);
        assertEq(cachedEpoch, epoch2);
    }

    function test_verifyAndCache_differentWalletsAreIndependent() public {
        address bob = makeAddr("bob");

        // Epoch 2: compute bob's leaf using the NEW epoch number (epoch is encoded in the leaf).
        uint256 epoch2 = EPOCH + 1;
        uint256 bobAura = 100e18;
        int256[6] memory bobRep;
        bytes32 bobLeaf = keccak256(
            bytes.concat(
                keccak256(
                    abi.encode(
                        epoch2, bob, LINKED_1, LINKED_2,
                        keccak256("bob"),
                        bobAura,
                        bobRep[0], bobRep[1], bobRep[2], bobRep[3], bobRep[4], bobRep[5]
                    )
                )
            )
        );

        vm.prank(poster);
        rootReg.postRoot(epoch2, bobLeaf, keccak256("ds-bob"));

        bytes32[] memory proof = new bytes32[](0);
        verifier.verifyAndCache(bob, LINKED_1, LINKED_2, keccak256("bob"), bobAura, bobRep, proof);

        assertEq(verifier.getAura(bob), bobAura);
        // Alice's checkpoint is untouched (she never called verifyAndCache).
        assertEq(verifier.getAura(PRIMARY), 0);
    }

    // -------------------------------------------------------------------------
    // verifyAndCache — invalid proof
    // -------------------------------------------------------------------------

    function test_verifyAndCache_revertWhen_wrongAura() public {
        bytes32[] memory proof = new bytes32[](0);
        vm.expectRevert(CheckpointVerifier.InvalidProof.selector);
        verifier.verifyAndCache(
            PRIMARY, LINKED_1, LINKED_2, USERNAME_HASH,
            AURA + 1,   // wrong aura
            REP, proof
        );
    }

    function test_verifyAndCache_revertWhen_wrongWallet() public {
        bytes32[] memory proof = new bytes32[](0);
        vm.expectRevert(CheckpointVerifier.InvalidProof.selector);
        verifier.verifyAndCache(
            makeAddr("impostor"), LINKED_1, LINKED_2, USERNAME_HASH,
            AURA, REP, proof
        );
    }

    function test_verifyAndCache_revertWhen_wrongUsernameHash() public {
        bytes32[] memory proof = new bytes32[](0);
        vm.expectRevert(CheckpointVerifier.InvalidProof.selector);
        verifier.verifyAndCache(
            PRIMARY, LINKED_1, LINKED_2,
            keccak256("wrong-name"),
            AURA, REP, proof
        );
    }

    function test_verifyAndCache_revertWhen_wrongRepCategory() public {
        int256[6] memory badRep = REP;
        badRep[0] = REP[0] + 1; // tamper research REP

        bytes32[] memory proof = new bytes32[](0);
        vm.expectRevert(CheckpointVerifier.InvalidProof.selector);
        verifier.verifyAndCache(
            PRIMARY, LINKED_1, LINKED_2, USERNAME_HASH,
            AURA, badRep, proof
        );
    }

    function test_verifyAndCache_revertWhen_wrongSiblingInProof() public {
        bytes32[] memory proof = new bytes32[](1);
        proof[0] = keccak256("garbage sibling");

        vm.expectRevert(CheckpointVerifier.InvalidProof.selector);
        verifier.verifyAndCache(PRIMARY, LINKED_1, LINKED_2, USERNAME_HASH, AURA, REP, proof);
    }

    // -------------------------------------------------------------------------
    // getAura — unverified state
    // -------------------------------------------------------------------------

    function test_getAura_returnsZeroForNeverVerifiedAddress() public view {
        assertEq(verifier.getAura(alice), 0);
    }

    // -------------------------------------------------------------------------
    // getRep — category dispatch
    // -------------------------------------------------------------------------

    function test_getRep_returnsZeroForNeverVerifiedAddress() public view {
        for (uint8 i = 0; i < 6; i++) {
            assertEq(verifier.getRep(alice, i), 0);
        }
    }

    function test_getRep_returnsZeroForUnknownCategory() public view {
        // Categories 6+ are out of range — contract returns 0.
        assertEq(verifier.getRep(alice, 6), 0);
        assertEq(verifier.getRep(alice, 255), 0);
    }

    function testFuzz_getRep_outOfRangeCategory_returnsZero(uint8 category) public view {
        vm.assume(category > 5);
        assertEq(verifier.getRep(alice, category), 0);
    }

    // -------------------------------------------------------------------------
    // rootRegistry immutable
    // -------------------------------------------------------------------------

    function test_rootRegistry_isSetCorrectly() public view {
        assertEq(address(verifier.rootRegistry()), address(rootReg));
    }
}
