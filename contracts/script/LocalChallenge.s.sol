// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script, console2} from "forge-std/Script.sol";

interface IChallengeRegistry {
    function submitChallenge(
        uint256 epochNumber,
        bytes32 claimedCorrectRoot,
        bytes32 evidenceHash
    ) external returns (uint256 challengeId);

    function acceptChallenge(uint256 challengeId) external;
}

interface IRootRegistry {
    function currentEpoch() external view returns (uint256);
    function currentRoot() external view returns (bytes32);
}

/// @notice Seeds a challenge and acceptance on a running local Anvil stack.
///
/// Run this AFTER the indexer has posted at least one epoch root (wait ~35 seconds
/// after starting the indexer). The script reads contract addresses from env vars
/// and produces a resolved challenge visible in the API and indexer logs.
///
/// Result:
///   Carol (account #2) submits a challenge against epoch 1.
///   Deployer (account #9) accepts the challenge.
///   Carol earns 1 000 Aura bonus + 1 000 Builder REP in the next epoch snapshot.
///
/// Usage:
///   source .env.local   # loads CHALLENGE_REGISTRY_ADDRESS, ROOT_REGISTRY_ADDRESS
///   forge script contracts/script/LocalChallenge.s.sol \
///     --rpc-url http://127.0.0.1:8545 \
///     --broadcast
contract LocalChallenge is Script {
    // Deployer: Anvil account #9
    uint256 constant DEPLOYER_KEY = 0x2a871d0798f97d79848a013d4936a73bf4cc922c825d33c1cf7073dff6d409c6;

    // Carol: Anvil account #2
    uint256 constant CAROL_KEY = 0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a;
    address constant CAROL = 0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC;

    function run() external {
        address challengeAddr = vm.envAddress("CHALLENGE_REGISTRY_ADDRESS");
        address rootAddr = vm.envAddress("ROOT_REGISTRY_ADDRESS");

        IChallengeRegistry challengeRegistry = IChallengeRegistry(challengeAddr);
        IRootRegistry rootRegistry = IRootRegistry(rootAddr);

        uint256 epoch = rootRegistry.currentEpoch();
        require(epoch >= 1, "No epoch posted yet -- wait for the indexer to run one epoch (~35s)");

        bytes32 postedRoot = rootRegistry.currentRoot();
        // Must differ from the posted root to pass RootMatchesPosted guard.
        bytes32 claimedCorrectRoot = keccak256(abi.encodePacked("carol-challenge", postedRoot));
        bytes32 evidenceHash = keccak256("https://github.com/example/challenge-evidence");

        console2.log("Challenging epoch:", epoch);
        console2.log("Challenger: Carol (", CAROL, ")");

        // Carol submits a challenge.
        vm.startBroadcast(CAROL_KEY);
        uint256 challengeId = challengeRegistry.submitChallenge(epoch, claimedCorrectRoot, evidenceHash);
        vm.stopBroadcast();

        console2.log("Challenge submitted. ID:", challengeId);

        // Deployer accepts the challenge (Carol earns 1 000 Aura + 1 000 Builder REP).
        vm.startBroadcast(DEPLOYER_KEY);
        challengeRegistry.acceptChallenge(challengeId);
        vm.stopBroadcast();

        console2.log("Challenge accepted. Carol earns 1 000 Aura + 1 000 Builder REP next epoch.");
        console2.log("Check via API: curl http://localhost:3001/api/challenges");
    }
}
