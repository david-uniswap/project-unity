// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {RootRegistry} from "../src/RootRegistry.sol";

contract RootRegistryTest is Test {
    RootRegistry registry;
    address poster = makeAddr("poster");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");

    bytes32 constant ROOT_1 = keccak256("root1");
    bytes32 constant ROOT_2 = keccak256("root2");
    bytes32 constant DATASET_1 = keccak256("dataset1");
    bytes32 constant DATASET_2 = keccak256("dataset2");

    function setUp() public {
        registry = new RootRegistry(poster);
    }

    // -------------------------------------------------------------------------
    // postRoot
    // -------------------------------------------------------------------------

    function test_postRoot_firstEpoch_succeeds() public {
        vm.prank(poster);
        registry.postRoot(1, ROOT_1, DATASET_1);

        assertEq(registry.currentEpoch(), 1);
        assertEq(registry.currentRoot(), ROOT_1);
        assertEq(registry.currentDatasetHash(), DATASET_1);
        assertEq(registry.epochRoots(1), ROOT_1);
        assertEq(registry.epochDatasetHashes(1), DATASET_1);
    }

    function test_postRoot_emitsEvent() public {
        vm.expectEmit(true, true, false, true);
        emit RootRegistry.RootPosted(1, ROOT_1, DATASET_1, block.timestamp);

        vm.prank(poster);
        registry.postRoot(1, ROOT_1, DATASET_1);
    }

    function test_postRoot_multipleEpochs_inOrder() public {
        vm.startPrank(poster);
        registry.postRoot(1, ROOT_1, DATASET_1);
        registry.postRoot(2, ROOT_2, DATASET_2);
        vm.stopPrank();

        assertEq(registry.currentEpoch(), 2);
        assertEq(registry.currentRoot(), ROOT_2);
        assertEq(registry.epochRoots(1), ROOT_1);
        assertEq(registry.epochRoots(2), ROOT_2);
        assertEq(registry.epochDatasetHashes(1), DATASET_1);
        assertEq(registry.epochDatasetHashes(2), DATASET_2);
    }

    function test_postRoot_revertWhen_notPoster() public {
        vm.prank(alice);
        vm.expectRevert(RootRegistry.Unauthorized.selector);
        registry.postRoot(1, ROOT_1, DATASET_1);
    }

    function test_postRoot_revertWhen_zeroRoot() public {
        vm.prank(poster);
        vm.expectRevert(RootRegistry.ZeroRoot.selector);
        registry.postRoot(1, bytes32(0), DATASET_1);
    }

    function test_postRoot_revertWhen_epochNotIncreasing() public {
        vm.startPrank(poster);
        registry.postRoot(5, ROOT_1, DATASET_1);

        vm.expectRevert(abi.encodeWithSelector(RootRegistry.InvalidEpoch.selector, 5, 5));
        registry.postRoot(5, ROOT_2, DATASET_2);

        vm.expectRevert(abi.encodeWithSelector(RootRegistry.InvalidEpoch.selector, 3, 5));
        registry.postRoot(3, ROOT_2, DATASET_2);
        vm.stopPrank();
    }

    // -------------------------------------------------------------------------
    // updatePoster
    // -------------------------------------------------------------------------

    function test_updatePoster_byOwner_succeeds() public {
        registry.updatePoster(alice);
        assertEq(registry.poster(), alice);

        vm.prank(alice);
        registry.postRoot(1, ROOT_1, DATASET_1);
        assertEq(registry.currentEpoch(), 1);
    }

    function test_updatePoster_revertWhen_notOwner() public {
        vm.prank(alice);
        vm.expectRevert(RootRegistry.Unauthorized.selector);
        registry.updatePoster(alice);
    }

    // -------------------------------------------------------------------------
    // getCurrentState / getEpochInfo
    // -------------------------------------------------------------------------

    function test_getCurrentState_returnsAll() public {
        vm.prank(poster);
        registry.postRoot(7, ROOT_1, DATASET_1);

        (uint256 epoch, bytes32 root, bytes32 datasetHash, uint256 ts) = registry.getCurrentState();
        assertEq(epoch, 7);
        assertEq(root, ROOT_1);
        assertEq(datasetHash, DATASET_1);
        assertEq(ts, block.timestamp);
    }

    function test_getEpochInfo_returnsAll() public {
        vm.prank(poster);
        registry.postRoot(3, ROOT_1, DATASET_1);

        (bytes32 root, bytes32 datasetHash, uint256 ts) = registry.getEpochInfo(3);
        assertEq(root, ROOT_1);
        assertEq(datasetHash, DATASET_1);
        assertEq(ts, block.timestamp);
    }

    // -------------------------------------------------------------------------
    // postRoot — additional edge cases
    // -------------------------------------------------------------------------

    function test_postRoot_allowsEpochGaps() public {
        vm.startPrank(poster);
        registry.postRoot(1, ROOT_1, DATASET_1);
        registry.postRoot(5, ROOT_2, DATASET_2); // skip 2-4
        vm.stopPrank();

        assertEq(registry.currentEpoch(), 5);
        assertEq(registry.epochRoots(1), ROOT_1);
        assertEq(registry.epochRoots(5), ROOT_2);
        // Skipped epochs return zero.
        assertEq(registry.epochRoots(2), bytes32(0));
        assertEq(registry.epochRoots(3), bytes32(0));
    }

    // -------------------------------------------------------------------------
    // transferOwnership
    // -------------------------------------------------------------------------

    function test_transferOwnership_succeeds() public {
        // Default owner is the deployer (address(this) in the test).
        registry.transferOwnership(alice);
        assertEq(registry.owner(), alice);

        // Old owner can no longer update the poster.
        vm.expectRevert(RootRegistry.Unauthorized.selector);
        registry.updatePoster(bob);

        // New owner can.
        vm.prank(alice);
        registry.updatePoster(bob);
        assertEq(registry.poster(), bob);
    }

    function test_transferOwnership_emitsEvent() public {
        address oldOwner = address(this);
        vm.expectEmit(true, true, false, false);
        emit RootRegistry.OwnershipTransferred(oldOwner, alice);
        registry.transferOwnership(alice);
    }

    function test_updatePoster_emitsEvent() public {
        vm.expectEmit(true, true, false, false);
        emit RootRegistry.PosterUpdated(poster, alice);
        registry.updatePoster(alice);
    }

    // -------------------------------------------------------------------------
    // Fuzz
    // -------------------------------------------------------------------------

    function test_postRoot_revertWhen_zeroDatasetHash() public {
        vm.prank(poster);
        vm.expectRevert(RootRegistry.ZeroDatasetHash.selector);
        registry.postRoot(1, ROOT_1, bytes32(0));
    }

    function test_transferOwnership_revertWhen_zeroAddress() public {
        vm.expectRevert(RootRegistry.ZeroAddress.selector);
        registry.transferOwnership(address(0));
    }

    function testFuzz_postRoot_anyValidRoot(bytes32 root, bytes32 datasetHash) public {
        vm.assume(root != bytes32(0));
        vm.assume(datasetHash != bytes32(0));
        vm.prank(poster);
        registry.postRoot(1, root, datasetHash);
        assertEq(registry.currentRoot(), root);
        assertEq(registry.currentDatasetHash(), datasetHash);
    }

    function testFuzz_postRoot_epochMustBeMonotonicallyIncreasing(
        uint256 first,
        uint256 second
    ) public {
        vm.assume(first > 0 && first < type(uint128).max);
        vm.assume(second <= first);

        vm.startPrank(poster);
        registry.postRoot(first, ROOT_1, DATASET_1);

        vm.expectRevert(
            abi.encodeWithSelector(RootRegistry.InvalidEpoch.selector, second, first)
        );
        registry.postRoot(second, ROOT_2, DATASET_2);
        vm.stopPrank();
    }
}
