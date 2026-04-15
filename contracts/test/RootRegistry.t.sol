// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {RootRegistry} from "../src/RootRegistry.sol";

contract RootRegistryTest is Test {
    RootRegistry registry;
    address poster = makeAddr("poster");
    address alice = makeAddr("alice");

    bytes32 constant ROOT_1 = keccak256("root1");
    bytes32 constant ROOT_2 = keccak256("root2");

    function setUp() public {
        registry = new RootRegistry(poster);
    }

    // -------------------------------------------------------------------------
    // postRoot
    // -------------------------------------------------------------------------

    function test_postRoot_firstEpoch_succeeds() public {
        vm.prank(poster);
        registry.postRoot(1, ROOT_1);

        assertEq(registry.currentEpoch(), 1);
        assertEq(registry.currentRoot(), ROOT_1);
        assertEq(registry.epochRoots(1), ROOT_1);
    }

    function test_postRoot_emitsEvent() public {
        vm.expectEmit(true, true, false, true);
        emit RootRegistry.RootPosted(1, ROOT_1, block.timestamp);

        vm.prank(poster);
        registry.postRoot(1, ROOT_1);
    }

    function test_postRoot_multipleEpochs_inOrder() public {
        vm.startPrank(poster);
        registry.postRoot(1, ROOT_1);
        registry.postRoot(2, ROOT_2);
        vm.stopPrank();

        assertEq(registry.currentEpoch(), 2);
        assertEq(registry.currentRoot(), ROOT_2);
        assertEq(registry.epochRoots(1), ROOT_1);
        assertEq(registry.epochRoots(2), ROOT_2);
    }

    function test_postRoot_revertWhen_notPoster() public {
        vm.prank(alice);
        vm.expectRevert(RootRegistry.Unauthorized.selector);
        registry.postRoot(1, ROOT_1);
    }

    function test_postRoot_revertWhen_zeroRoot() public {
        vm.prank(poster);
        vm.expectRevert(RootRegistry.ZeroRoot.selector);
        registry.postRoot(1, bytes32(0));
    }

    function test_postRoot_revertWhen_epochNotIncreasing() public {
        vm.startPrank(poster);
        registry.postRoot(5, ROOT_1);

        vm.expectRevert(abi.encodeWithSelector(RootRegistry.InvalidEpoch.selector, 5, 5));
        registry.postRoot(5, ROOT_2);

        vm.expectRevert(abi.encodeWithSelector(RootRegistry.InvalidEpoch.selector, 3, 5));
        registry.postRoot(3, ROOT_2);
        vm.stopPrank();
    }

    // -------------------------------------------------------------------------
    // updatePoster
    // -------------------------------------------------------------------------

    function test_updatePoster_byOwner_succeeds() public {
        registry.updatePoster(alice);
        assertEq(registry.poster(), alice);

        vm.prank(alice);
        registry.postRoot(1, ROOT_1);
        assertEq(registry.currentEpoch(), 1);
    }

    function test_updatePoster_revertWhen_notOwner() public {
        vm.prank(alice);
        vm.expectRevert(RootRegistry.Unauthorized.selector);
        registry.updatePoster(alice);
    }

    // -------------------------------------------------------------------------
    // getCurrentState
    // -------------------------------------------------------------------------

    function test_getCurrentState_returnsAll() public {
        vm.prank(poster);
        registry.postRoot(7, ROOT_1);

        (uint256 epoch, bytes32 root, uint256 ts) = registry.getCurrentState();
        assertEq(epoch, 7);
        assertEq(root, ROOT_1);
        assertEq(ts, block.timestamp);
    }

    // -------------------------------------------------------------------------
    // Fuzz
    // -------------------------------------------------------------------------

    function testFuzz_postRoot_anyValidRoot(bytes32 root) public {
        vm.assume(root != bytes32(0));
        vm.prank(poster);
        registry.postRoot(1, root);
        assertEq(registry.currentRoot(), root);
    }
}
