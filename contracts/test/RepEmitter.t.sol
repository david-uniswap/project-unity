// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {RepEmitter} from "../src/RepEmitter.sol";

contract RepEmitterTest is Test {
    RepEmitter emitter;

    address alice = makeAddr("alice");
    address bob = makeAddr("bob");

    function setUp() public {
        emitter = new RepEmitter();
    }

    // -------------------------------------------------------------------------
    // giveRep — happy path
    // -------------------------------------------------------------------------

    function test_giveRep_positiveAmount_emitsEvent() public {
        vm.expectEmit(true, true, true, true);
        emit RepEmitter.RepGiven(alice, bob, 0, 3, block.timestamp);

        vm.prank(alice);
        emitter.giveRep(bob, 0, 3);
    }

    function test_giveRep_negativeAmount_emitsEvent() public {
        vm.expectEmit(true, true, true, true);
        emit RepEmitter.RepGiven(alice, bob, 4, -2, block.timestamp);

        vm.prank(alice);
        emitter.giveRep(bob, 4, -2);
    }

    function test_giveRep_allCategories_succeed() public {
        vm.startPrank(alice);
        for (uint8 i = 0; i <= 5; i++) {
            emitter.giveRep(bob, i, 1);
        }
        vm.stopPrank();
    }

    // -------------------------------------------------------------------------
    // giveRep — reverts
    // -------------------------------------------------------------------------

    function test_giveRep_revertWhen_selfRep() public {
        vm.prank(alice);
        vm.expectRevert(RepEmitter.SelfRep.selector);
        emitter.giveRep(alice, 0, 1);
    }

    function test_giveRep_revertWhen_zeroAddress() public {
        vm.prank(alice);
        vm.expectRevert(RepEmitter.ZeroAddress.selector);
        emitter.giveRep(address(0), 0, 1);
    }

    function test_giveRep_revertWhen_invalidCategory() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(RepEmitter.InvalidCategory.selector, 6));
        emitter.giveRep(bob, 6, 1);
    }

    function test_giveRep_revertWhen_zeroAmount() public {
        vm.prank(alice);
        vm.expectRevert(RepEmitter.ZeroAmount.selector);
        emitter.giveRep(bob, 0, 0);
    }

    // -------------------------------------------------------------------------
    // Fuzz
    // -------------------------------------------------------------------------

    function testFuzz_giveRep_validInputs(
        address from,
        address to,
        uint8 category,
        int256 amount
    ) public {
        vm.assume(from != to);
        vm.assume(to != address(0));
        vm.assume(from != address(0));
        vm.assume(category <= 5);
        vm.assume(amount != 0);

        vm.prank(from);
        emitter.giveRep(to, category, amount);
    }
}
