// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {FakeUNI} from "../src/FakeUNI.sol";

contract FakeUNITest is Test {
    FakeUNI token;

    address owner = makeAddr("owner");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");

    function setUp() public {
        // Warp to a realistic timestamp — Foundry defaults to 1, which is inside
        // the faucet cooldown window (lastFaucetTime=0, cooldown=3600).
        vm.warp(1_000_000);
        vm.prank(owner);
        token = new FakeUNI(owner);
    }

    // -------------------------------------------------------------------------
    // Constructor
    // -------------------------------------------------------------------------

    function test_constructor_mintsInitialSupplyToOwner() public view {
        assertEq(token.balanceOf(owner), 1_000_000 ether);
    }

    function test_constructor_setsNameAndSymbol() public view {
        assertEq(token.name(), "Fake UNI");
        assertEq(token.symbol(), "fUNI");
    }

    function test_constructor_setsOwner() public view {
        assertEq(token.owner(), owner);
    }

    // -------------------------------------------------------------------------
    // Constants
    // -------------------------------------------------------------------------

    function test_faucetMax_is10000ether() public view {
        assertEq(token.FAUCET_MAX(), 10_000 ether);
    }

    function test_faucetCooldown_is1hour() public view {
        assertEq(token.FAUCET_COOLDOWN(), 1 hours);
    }

    // -------------------------------------------------------------------------
    // mint (owner-only)
    // -------------------------------------------------------------------------

    function test_mint_ownerCanMintToAnyAddress() public {
        vm.prank(owner);
        token.mint(alice, 500 ether);
        assertEq(token.balanceOf(alice), 500 ether);
    }

    function test_mint_revertWhen_callerIsNotOwner() public {
        vm.prank(alice);
        vm.expectRevert();
        token.mint(alice, 1 ether);
    }

    function test_mint_addsTotalSupply() public {
        uint256 before = token.totalSupply();
        vm.prank(owner);
        token.mint(bob, 100 ether);
        assertEq(token.totalSupply(), before + 100 ether);
    }

    // -------------------------------------------------------------------------
    // faucet — happy path
    // -------------------------------------------------------------------------

    function test_faucet_mintsRequestedAmount() public {
        vm.prank(alice);
        token.faucet(100 ether);
        assertEq(token.balanceOf(alice), 100 ether);
    }

    function test_faucet_recordsLastFaucetTime() public {
        vm.warp(1_000_000);
        vm.prank(alice);
        token.faucet(1 ether);
        assertEq(token.lastFaucetTime(alice), 1_000_000);
    }

    function test_faucet_maxAmountSucceeds() public {
        vm.prank(alice);
        token.faucet(10_000 ether);
        assertEq(token.balanceOf(alice), 10_000 ether);
    }

    function test_faucet_revertWhen_zeroAmount() public {
        vm.prank(alice);
        vm.expectRevert(FakeUNI.ZeroAmount.selector);
        token.faucet(0);
    }

    function test_faucet_differentAddressesIndependent() public {
        vm.prank(alice);
        token.faucet(500 ether);

        vm.prank(bob);
        token.faucet(1_000 ether);

        assertEq(token.balanceOf(alice), 500 ether);
        assertEq(token.balanceOf(bob), 1_000 ether);
    }

    // -------------------------------------------------------------------------
    // faucet — cooldown
    // -------------------------------------------------------------------------

    function test_faucet_succeedsAfterCooldownElapsed() public {
        vm.warp(1_000_000);
        vm.prank(alice);
        token.faucet(1 ether);

        // Advance exactly 1 hour.
        vm.warp(1_000_000 + 1 hours);
        vm.prank(alice);
        token.faucet(1 ether);

        assertEq(token.balanceOf(alice), 2 ether);
    }

    function test_faucet_revertWhen_cooldownActive() public {
        vm.prank(alice);
        token.faucet(1 ether);

        // Try again immediately.
        vm.prank(alice);
        uint256 expectedNext = block.timestamp + 1 hours;
        vm.expectRevert(
            abi.encodeWithSelector(FakeUNI.FaucetCooldownActive.selector, expectedNext)
        );
        token.faucet(1 ether);
    }

    function test_faucet_revertWhen_cooldownActiveOneSecondBefore() public {
        vm.warp(1_000_000);
        vm.prank(alice);
        token.faucet(1 ether);

        // One second before cooldown ends.
        vm.warp(1_000_000 + 1 hours - 1);
        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(FakeUNI.FaucetCooldownActive.selector, 1_000_000 + 1 hours)
        );
        token.faucet(1 ether);
    }

    // -------------------------------------------------------------------------
    // faucet — amount validation
    // -------------------------------------------------------------------------

    function test_faucet_revertWhen_amountExceedsMax() public {
        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(FakeUNI.FaucetAmountTooHigh.selector, 10_001 ether, 10_000 ether)
        );
        token.faucet(10_001 ether);
    }

    function test_faucet_revertWhen_maxPlusOne() public {
        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(FakeUNI.FaucetAmountTooHigh.selector, 10_000 ether + 1, 10_000 ether)
        );
        token.faucet(10_000 ether + 1);
    }

    // -------------------------------------------------------------------------
    // Fuzz
    // -------------------------------------------------------------------------

    function testFuzz_faucet_validAmountSucceeds(uint256 amount) public {
        amount = bound(amount, 1, 10_000 ether);
        vm.prank(alice);
        token.faucet(amount);
        assertEq(token.balanceOf(alice), amount);
    }

    function testFuzz_faucet_invalidAmountReverts(uint256 amount) public {
        amount = bound(amount, 10_001 ether, type(uint256).max);
        vm.prank(alice);
        vm.expectRevert();
        token.faucet(amount);
    }

    function testFuzz_mint_ownerCanMintAnyAmount(uint256 amount) public {
        amount = bound(amount, 0, type(uint128).max); // keep supply reasonable
        vm.prank(owner);
        token.mint(alice, amount);
        assertEq(token.balanceOf(alice), amount);
    }
}
