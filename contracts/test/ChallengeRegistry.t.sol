// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {RootRegistry} from "../src/RootRegistry.sol";
import {RepEmitter} from "../src/RepEmitter.sol";
import {ChallengeRegistry} from "../src/ChallengeRegistry.sol";

contract ChallengeRegistryTest is Test {
    RootRegistry rootRegistry;
    RepEmitter repEmitter;
    ChallengeRegistry challengeRegistry;

    address poster = makeAddr("poster");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");

    bytes32 constant ROOT_1 = keccak256("root1");
    bytes32 constant WRONG_ROOT = keccak256("wrongRoot");
    bytes32 constant CORRECT_ROOT = keccak256("correctRoot");
    bytes32 constant DATASET_HASH = keccak256("dataset1");
    bytes32 constant EVIDENCE = keccak256("evidence");

    function setUp() public {
        rootRegistry = new RootRegistry(poster);
        repEmitter = new RepEmitter();
        challengeRegistry = new ChallengeRegistry(
            address(rootRegistry),
            address(repEmitter)
        );

        // Post an epoch root so challenges have something to reference.
        vm.prank(poster);
        rootRegistry.postRoot(1, ROOT_1, DATASET_HASH);
    }

    // -------------------------------------------------------------------------
    // submitChallenge
    // -------------------------------------------------------------------------

    function test_submitChallenge_succeeds() public {
        vm.prank(alice);
        uint256 id = challengeRegistry.submitChallenge(1, CORRECT_ROOT, EVIDENCE);

        assertEq(id, 1);
        ChallengeRegistry.Challenge memory c = challengeRegistry.getChallenge(1);
        assertEq(c.challenger, alice);
        assertEq(c.epochNumber, 1);
        assertEq(c.claimedCorrectRoot, CORRECT_ROOT);
        assertEq(c.evidenceHash, EVIDENCE);
        assertEq(uint8(c.status), uint8(ChallengeRegistry.ChallengeStatus.Pending));
    }

    function test_submitChallenge_emitsEvent() public {
        vm.expectEmit(true, true, true, true);
        emit ChallengeRegistry.ChallengeSubmitted(1, alice, 1, CORRECT_ROOT, EVIDENCE);

        vm.prank(alice);
        challengeRegistry.submitChallenge(1, CORRECT_ROOT, EVIDENCE);
    }

    function test_submitChallenge_multiplePerEpoch() public {
        vm.prank(alice);
        challengeRegistry.submitChallenge(1, CORRECT_ROOT, EVIDENCE);

        vm.prank(bob);
        challengeRegistry.submitChallenge(1, CORRECT_ROOT, bytes32(0));

        uint256[] memory ids = challengeRegistry.getEpochChallengeIds(1);
        assertEq(ids.length, 2);
        assertEq(ids[0], 1);
        assertEq(ids[1], 2);
    }

    function test_submitChallenge_zeroEvidence_succeeds() public {
        vm.prank(alice);
        uint256 id = challengeRegistry.submitChallenge(1, CORRECT_ROOT, bytes32(0));
        assertEq(id, 1);
    }

    function test_submitChallenge_revertWhen_epochNotFound() public {
        vm.prank(alice);
        vm.expectRevert(ChallengeRegistry.EpochNotFound.selector);
        challengeRegistry.submitChallenge(99, CORRECT_ROOT, EVIDENCE);
    }

    function test_submitChallenge_revertWhen_sameRoot() public {
        vm.prank(alice);
        vm.expectRevert(ChallengeRegistry.RootMatchesPosted.selector);
        challengeRegistry.submitChallenge(1, ROOT_1, EVIDENCE);
    }

    // -------------------------------------------------------------------------
    // acceptChallenge
    // -------------------------------------------------------------------------

    function test_acceptChallenge_emitsAuraBounty() public {
        vm.prank(alice);
        challengeRegistry.submitChallenge(1, CORRECT_ROOT, EVIDENCE);

        vm.expectEmit(true, false, true, true);
        emit ChallengeRegistry.AuraBountyGranted(alice, 1_000e18, 1);

        challengeRegistry.acceptChallenge(1);
    }

    function test_acceptChallenge_emitsRepGiven() public {
        vm.prank(alice);
        challengeRegistry.submitChallenge(1, CORRECT_ROOT, EVIDENCE);

        vm.expectEmit(true, true, true, true);
        emit RepEmitter.RepGiven(
            address(challengeRegistry),
            alice,
            1,
            1_000,
            block.timestamp
        );

        challengeRegistry.acceptChallenge(1);
    }

    function test_acceptChallenge_emitsChallengeAccepted() public {
        vm.prank(alice);
        challengeRegistry.submitChallenge(1, CORRECT_ROOT, EVIDENCE);

        vm.expectEmit(true, true, true, true);
        emit ChallengeRegistry.ChallengeAccepted(1, alice, 1);

        challengeRegistry.acceptChallenge(1);
    }

    function test_acceptChallenge_setsStatusAccepted() public {
        vm.prank(alice);
        challengeRegistry.submitChallenge(1, CORRECT_ROOT, EVIDENCE);
        challengeRegistry.acceptChallenge(1);

        ChallengeRegistry.Challenge memory c = challengeRegistry.getChallenge(1);
        assertEq(uint8(c.status), uint8(ChallengeRegistry.ChallengeStatus.Accepted));
    }

    function test_acceptChallenge_revertWhen_notOwner() public {
        vm.prank(alice);
        challengeRegistry.submitChallenge(1, CORRECT_ROOT, EVIDENCE);

        vm.prank(bob);
        vm.expectRevert(ChallengeRegistry.Unauthorized.selector);
        challengeRegistry.acceptChallenge(1);
    }

    function test_acceptChallenge_revertWhen_notPending() public {
        vm.prank(alice);
        challengeRegistry.submitChallenge(1, CORRECT_ROOT, EVIDENCE);
        challengeRegistry.acceptChallenge(1);

        vm.expectRevert(ChallengeRegistry.NotPending.selector);
        challengeRegistry.acceptChallenge(1);
    }

    // -------------------------------------------------------------------------
    // rejectChallenge
    // -------------------------------------------------------------------------

    function test_rejectChallenge_setsStatusRejected() public {
        vm.prank(alice);
        challengeRegistry.submitChallenge(1, CORRECT_ROOT, EVIDENCE);
        challengeRegistry.rejectChallenge(1, "Root was correct");

        ChallengeRegistry.Challenge memory c = challengeRegistry.getChallenge(1);
        assertEq(uint8(c.status), uint8(ChallengeRegistry.ChallengeStatus.Rejected));
    }

    function test_rejectChallenge_emitsEvent() public {
        vm.prank(alice);
        challengeRegistry.submitChallenge(1, CORRECT_ROOT, EVIDENCE);

        vm.expectEmit(true, true, false, true);
        emit ChallengeRegistry.ChallengeRejected(1, alice, "Root was correct");

        challengeRegistry.rejectChallenge(1, "Root was correct");
    }

    function test_rejectChallenge_revertWhen_notOwner() public {
        vm.prank(alice);
        challengeRegistry.submitChallenge(1, CORRECT_ROOT, EVIDENCE);

        vm.prank(bob);
        vm.expectRevert(ChallengeRegistry.Unauthorized.selector);
        challengeRegistry.rejectChallenge(1, "");
    }

    function test_rejectChallenge_revertWhen_alreadyAccepted() public {
        vm.prank(alice);
        challengeRegistry.submitChallenge(1, CORRECT_ROOT, EVIDENCE);
        challengeRegistry.acceptChallenge(1);

        vm.expectRevert(ChallengeRegistry.NotPending.selector);
        challengeRegistry.rejectChallenge(1, "too late");
    }

    function test_rejectChallenge_revertWhen_alreadyRejected() public {
        vm.prank(alice);
        challengeRegistry.submitChallenge(1, CORRECT_ROOT, EVIDENCE);
        challengeRegistry.rejectChallenge(1, "Root was correct");

        vm.expectRevert(ChallengeRegistry.NotPending.selector);
        challengeRegistry.rejectChallenge(1, "double reject");
    }

    // -------------------------------------------------------------------------
    // challengeCount
    // -------------------------------------------------------------------------

    function test_challengeCount_incrementsPerSubmission() public {
        assertEq(challengeRegistry.challengeCount(), 0);

        vm.prank(alice);
        challengeRegistry.submitChallenge(1, CORRECT_ROOT, EVIDENCE);
        assertEq(challengeRegistry.challengeCount(), 1);

        vm.prank(bob);
        challengeRegistry.submitChallenge(1, WRONG_ROOT, bytes32(0));
        assertEq(challengeRegistry.challengeCount(), 2);
    }

    // -------------------------------------------------------------------------
    // transferOwnership
    // -------------------------------------------------------------------------

    function test_transferOwnership_succeeds() public {
        challengeRegistry.transferOwnership(alice);
        assertEq(challengeRegistry.owner(), alice);

        // Old owner can no longer accept challenges.
        vm.prank(bob);
        challengeRegistry.submitChallenge(1, CORRECT_ROOT, EVIDENCE);
        vm.expectRevert(ChallengeRegistry.Unauthorized.selector);
        challengeRegistry.acceptChallenge(1);

        // New owner can.
        vm.prank(alice);
        challengeRegistry.acceptChallenge(1);
    }

    function test_transferOwnership_revertWhen_notOwner() public {
        vm.prank(alice);
        vm.expectRevert(ChallengeRegistry.Unauthorized.selector);
        challengeRegistry.transferOwnership(alice);
    }

    // -------------------------------------------------------------------------
    // Reward amounts
    // -------------------------------------------------------------------------

    function test_constants_auraReward() public view {
        assertEq(challengeRegistry.AURA_REWARD(), 1_000e18);
    }

    function test_constants_repReward() public view {
        assertEq(challengeRegistry.REP_REWARD(), 1_000);
    }
}
