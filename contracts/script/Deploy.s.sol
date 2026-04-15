// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script, console2} from "forge-std/Script.sol";
import {FakeUNI} from "../src/FakeUNI.sol";
import {RootRegistry} from "../src/RootRegistry.sol";
import {ProfileRegistry} from "../src/ProfileRegistry.sol";
import {RepEmitter} from "../src/RepEmitter.sol";
import {CheckpointVerifier} from "../src/CheckpointVerifier.sol";
import {ChallengeRegistry} from "../src/ChallengeRegistry.sol";

/// @notice Deploys the full Project Unity contract suite to the target network.
///
/// Usage:
///   forge script script/Deploy.s.sol \
///     --rpc-url $SEPOLIA_RPC_URL \
///     --broadcast \
///     --verify
///
/// Environment variables:
///   DEPLOYER_PRIVATE_KEY  — private key of the deploying account
///   POSTER_ADDRESS        — address authorized to post roots (defaults to deployer)
contract Deploy is Script {
    function run() external {
        uint256 deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address deployer = vm.addr(deployerKey);
        address poster = vm.envOr("POSTER_ADDRESS", deployer);

        console2.log("Deployer:         ", deployer);
        console2.log("Poster:           ", poster);
        console2.log("Network chain ID: ", block.chainid);

        vm.startBroadcast(deployerKey);

        // 1. Deploy FakeUNI (testnet token, replaces real UNI on Sepolia).
        FakeUNI fakeUni = new FakeUNI(deployer);
        console2.log("FakeUNI:          ", address(fakeUni));

        // 2. Deploy ProfileRegistry (username + wallet linking).
        ProfileRegistry profileRegistry = new ProfileRegistry();
        console2.log("ProfileRegistry:  ", address(profileRegistry));

        // 3. Deploy RepEmitter (event-only REP layer).
        RepEmitter repEmitter = new RepEmitter();
        console2.log("RepEmitter:       ", address(repEmitter));

        // 4. Deploy RootRegistry (epoch Merkle roots + dataset hashes).
        RootRegistry rootRegistry = new RootRegistry(poster);
        console2.log("RootRegistry:     ", address(rootRegistry));

        // 5. Deploy CheckpointVerifier (optional proof cache for hooks/apps).
        CheckpointVerifier verifier = new CheckpointVerifier(address(rootRegistry));
        console2.log("CheckpointVerifier:", address(verifier));

        // 6. Deploy ChallengeRegistry (root verification + challenger rewards).
        //    Owner = deployer so they can accept/reject challenges.
        ChallengeRegistry challengeRegistry = new ChallengeRegistry(
            address(rootRegistry),
            address(repEmitter)
        );
        console2.log("ChallengeRegistry:", address(challengeRegistry));

        // Seed: mint 100 000 fUNI to deployer for integration testing.
        fakeUni.mint(deployer, 100_000 ether);

        vm.stopBroadcast();

        // Output .env snippet for the indexer and API.
        console2.log("\n--- Copy to .env ---");
        console2.log("FAKE_UNI_ADDRESS=", address(fakeUni));
        console2.log("PROFILE_REGISTRY_ADDRESS=", address(profileRegistry));
        console2.log("REP_EMITTER_ADDRESS=", address(repEmitter));
        console2.log("ROOT_REGISTRY_ADDRESS=", address(rootRegistry));
        console2.log("CHECKPOINT_VERIFIER_ADDRESS=", address(verifier));
        console2.log("CHALLENGE_REGISTRY_ADDRESS=", address(challengeRegistry));
    }
}
