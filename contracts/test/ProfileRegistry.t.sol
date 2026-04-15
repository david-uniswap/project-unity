// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {ProfileRegistry} from "../src/ProfileRegistry.sol";

contract ProfileRegistryTest is Test {
    ProfileRegistry registry;

    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    address carol = makeAddr("carol");

    function setUp() public {
        registry = new ProfileRegistry();
    }

    // -------------------------------------------------------------------------
    // registerName
    // -------------------------------------------------------------------------

    function test_registerName_validName_succeeds() public {
        vm.prank(alice);
        registry.registerName("alice123");

        assertEq(registry.usernameToWallet("alice123"), alice);
        (string memory username,, uint256 createdAt) = registry.getProfile(alice);
        assertEq(username, "alice123");
        assertGt(createdAt, 0);
    }

    function test_registerName_emitsEvent() public {
        vm.expectEmit(true, false, false, true);
        emit ProfileRegistry.NameRegistered(alice, "alice");

        vm.prank(alice);
        registry.registerName("alice");
    }

    function test_registerName_revertWhen_nameTaken() public {
        vm.prank(alice);
        registry.registerName("uni");

        vm.prank(bob);
        vm.expectRevert(ProfileRegistry.NameTaken.selector);
        registry.registerName("uni");
    }

    function test_registerName_revertWhen_alreadyRegistered() public {
        vm.startPrank(alice);
        registry.registerName("alice");

        vm.expectRevert(ProfileRegistry.AlreadyRegistered.selector);
        registry.registerName("alice2");
        vm.stopPrank();
    }

    function test_registerName_revertWhen_emptyName() public {
        vm.prank(alice);
        vm.expectRevert(ProfileRegistry.InvalidName.selector);
        registry.registerName("");
    }

    function test_registerName_revertWhen_nameTooLong() public {
        vm.prank(alice);
        vm.expectRevert(ProfileRegistry.InvalidName.selector);
        registry.registerName("averylongnamethatexceedslimit");
    }

    function test_registerName_revertWhen_uppercaseLetter() public {
        vm.prank(alice);
        vm.expectRevert(ProfileRegistry.InvalidName.selector);
        registry.registerName("Alice");
    }

    function test_registerName_revertWhen_hyphen() public {
        vm.prank(alice);
        vm.expectRevert(ProfileRegistry.InvalidName.selector);
        registry.registerName("alice-bob");
    }

    function test_registerName_allowsAllDigits() public {
        vm.prank(alice);
        registry.registerName("12345");
        assertEq(registry.usernameToWallet("12345"), alice);
    }

    function test_registerName_maxLength() public {
        vm.prank(alice);
        registry.registerName("abcdefghij0123456789"); // exactly 20
        assertEq(registry.usernameToWallet("abcdefghij0123456789"), alice);
    }

    // -------------------------------------------------------------------------
    // linkWallet / unlinkWallet
    // -------------------------------------------------------------------------

    function test_linkWallet_succeeds() public {
        vm.prank(alice);
        registry.registerName("alice");

        vm.prank(alice);
        registry.linkWallet(bob);

        (, address linked,) = registry.getProfile(alice);
        assertEq(linked, bob);
        assertEq(registry.linkedToPrimary(bob), alice);
    }

    function test_linkWallet_emitsEvent() public {
        vm.prank(alice);
        registry.registerName("alice");

        vm.expectEmit(true, true, false, false);
        emit ProfileRegistry.WalletLinked(alice, bob);

        vm.prank(alice);
        registry.linkWallet(bob);
    }

    function test_linkWallet_revertWhen_notRegistered() public {
        vm.prank(alice);
        vm.expectRevert(ProfileRegistry.NotRegistered.selector);
        registry.linkWallet(bob);
    }

    function test_linkWallet_revertWhen_alreadyHasLinked() public {
        vm.prank(alice);
        registry.registerName("alice");

        vm.prank(alice);
        registry.linkWallet(bob);

        vm.prank(alice);
        vm.expectRevert(ProfileRegistry.WalletAlreadyLinked.selector);
        registry.linkWallet(carol);
    }

    function test_linkWallet_revertWhen_linkSelf() public {
        vm.prank(alice);
        registry.registerName("alice");

        vm.prank(alice);
        vm.expectRevert(ProfileRegistry.CannotLinkSelf.selector);
        registry.linkWallet(alice);
    }

    function test_linkWallet_revertWhen_targetIsPrimary() public {
        vm.prank(alice);
        registry.registerName("alice");
        vm.prank(bob);
        registry.registerName("bob");

        vm.prank(alice);
        vm.expectRevert(ProfileRegistry.WalletIsAlreadyPrimary.selector);
        registry.linkWallet(bob);
    }

    function test_unlinkWallet_succeeds() public {
        vm.prank(alice);
        registry.registerName("alice");
        vm.prank(alice);
        registry.linkWallet(bob);

        vm.prank(alice);
        registry.unlinkWallet();

        (, address linked,) = registry.getProfile(alice);
        assertEq(linked, address(0));
        assertEq(registry.linkedToPrimary(bob), address(0));
    }

    function test_unlinkWallet_revertWhen_noLinked() public {
        vm.prank(alice);
        registry.registerName("alice");

        vm.prank(alice);
        vm.expectRevert(ProfileRegistry.NoLinkedWallet.selector);
        registry.unlinkWallet();
    }

    // -------------------------------------------------------------------------
    // getPrimaryWallet / getUsernameForWallet
    // -------------------------------------------------------------------------

    function test_getPrimaryWallet_fromLinked_returnsPrimary() public {
        vm.prank(alice);
        registry.registerName("alice");
        vm.prank(alice);
        registry.linkWallet(bob);

        assertEq(registry.getPrimaryWallet(bob), alice);
        assertEq(registry.getPrimaryWallet(alice), alice);
    }

    function test_getPrimaryWallet_unknownWallet_returnsZero() public view {
        assertEq(registry.getPrimaryWallet(carol), address(0));
    }

    function test_getUsernameForWallet_fromLinked() public {
        vm.prank(alice);
        registry.registerName("alice");
        vm.prank(alice);
        registry.linkWallet(bob);

        assertEq(registry.getUsernameForWallet(bob), "alice");
        assertEq(registry.getUsernameForWallet(alice), "alice");
    }
}
