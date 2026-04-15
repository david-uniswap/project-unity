// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script, console2} from "forge-std/Script.sol";
import {FakeUNI} from "../src/FakeUNI.sol";
import {RootRegistry} from "../src/RootRegistry.sol";
import {ProfileRegistry} from "../src/ProfileRegistry.sol";
import {RepEmitter} from "../src/RepEmitter.sol";
import {CheckpointVerifier} from "../src/CheckpointVerifier.sol";
import {ChallengeRegistry} from "../src/ChallengeRegistry.sol";

/// @notice Deploys and seeds the full Project Unity contract suite on a local Anvil node.
///
/// Account assignments (all Anvil default BIP-39 accounts — local only):
///   Account #9  → Deployer / root poster  (kept separate from dev wallets)
///   Account #0  → Alice   10 000 000 fUNI → ~6.9 Aura after epoch 1
///   Account #1  → Bob      5 000 000 fUNI → ~3.5 Aura after epoch 1
///   Account #2  → Carol    1 000 000 fUNI → ~0.7 Aura after epoch 2
///   Account #3  → Dave       200 000 fUNI → ~0.1 Aura (slower accrual)
///
/// Usage (from repo root):
///   anvil --block-time 2                   # Terminal 1
///   cd contracts && forge script script/LocalSetup.s.sol \
///     --rpc-url http://127.0.0.1:8545 \
///     --broadcast                          # Terminal 2
///
/// Or use the convenience script (handles everything):
///   ./scripts/local-dev.sh
contract LocalSetup is Script {
    // ── Anvil BIP-39 mnemonic (public — local only) ───────────────────────
    // Used by vm.deriveKey to fund + register 20 ecosystem wallets (accounts #10–29).
    // The same mnemonic is used by the ecosystem-activity.ts script via mnemonicToAccount.
    string constant MNEMONIC = "test test test test test test test test test test test junk";

    // ── Deployer: Anvil account #9 (kept off the dev wallet list) ─────────
    uint256 constant DEPLOYER_KEY = 0x2a871d0798f97d79848a013d4936a73bf4cc922c825d33c1cf7073dff6d409c6;
    address constant DEPLOYER = 0xa0Ee7A142d267C1f36714E4a8F75612F20a79720;

    // ── Dev wallets: Anvil accounts #0-3 ──────────────────────────────────
    uint256 constant ALICE_KEY = 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80;
    address constant ALICE = 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266;

    uint256 constant BOB_KEY = 0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d;
    address constant BOB = 0x70997970C51812dc3A010C7d01b50e0d17dc79C8;

    uint256 constant CAROL_KEY = 0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a;
    address constant CAROL = 0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC;

    uint256 constant DAVE_KEY = 0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6;
    address constant DAVE = 0x90F79bf6EB2c4f870365E785982E1f101E93b906;

    function run() external {
        // ── Deploy all contracts ──────────────────────────────────────────────
        vm.startBroadcast(DEPLOYER_KEY);

        FakeUNI fakeUni = new FakeUNI(DEPLOYER);
        ProfileRegistry profileRegistry = new ProfileRegistry();
        RepEmitter repEmitter = new RepEmitter();
        RootRegistry rootRegistry = new RootRegistry(DEPLOYER); // DEPLOYER is the poster
        CheckpointVerifier verifier = new CheckpointVerifier(address(rootRegistry));
        ChallengeRegistry challengeRegistry = new ChallengeRegistry(
            address(rootRegistry),
            address(repEmitter)
        );

        // Mint fUNI to dev wallets.
        // Large amounts ensure Aura accrues fast enough to give REP within 1-2 epochs.
        // At the default rate (1e18 / 1_440_000 per fUNI per epoch):
        //   Alice  10M fUNI → ~6.9 Aura/epoch  (can give REP from epoch 2)
        //   Bob     5M fUNI → ~3.5 Aura/epoch  (can give REP from epoch 2)
        //   Carol   1M fUNI → ~0.7 Aura/epoch  (can give REP from epoch 3)
        //   Dave  200k fUNI → ~0.1 Aura/epoch  (low tier — visible in leaderboard)
        fakeUni.mint(ALICE, 10_000_000 ether);
        fakeUni.mint(BOB, 5_000_000 ether);
        fakeUni.mint(CAROL, 1_000_000 ether);
        fakeUni.mint(DAVE, 200_000 ether);

        // ── Mint fUNI to 20 ecosystem wallets (accounts #10–29) ──────────────
        // Log-distributed amounts span from whale tier (8M) to dust tier (8k),
        // creating a realistic leaderboard that covers every Aura bracket.
        uint256[] memory ecoAmounts = new uint256[](20);
        ecoAmounts[0]  = 8_000_000 ether;
        ecoAmounts[1]  = 6_500_000 ether;
        ecoAmounts[2]  = 5_000_000 ether;
        ecoAmounts[3]  = 3_500_000 ether;
        ecoAmounts[4]  = 2_500_000 ether;
        ecoAmounts[5]  = 1_800_000 ether;
        ecoAmounts[6]  = 1_200_000 ether;
        ecoAmounts[7]  =   900_000 ether;
        ecoAmounts[8]  =   650_000 ether;
        ecoAmounts[9]  =   450_000 ether;
        ecoAmounts[10] =   320_000 ether;
        ecoAmounts[11] =   220_000 ether;
        ecoAmounts[12] =   160_000 ether;
        ecoAmounts[13] =   120_000 ether;
        ecoAmounts[14] =    85_000 ether;
        ecoAmounts[15] =    60_000 ether;
        ecoAmounts[16] =    40_000 ether;
        ecoAmounts[17] =    25_000 ether;
        ecoAmounts[18] =    15_000 ether;
        ecoAmounts[19] =     8_000 ether;

        for (uint256 i = 0; i < 20; i++) {
            address eco = vm.addr(vm.deriveKey(MNEMONIC, uint32(10 + i)));
            fakeUni.mint(eco, ecoAmounts[i]);
        }

        vm.stopBroadcast();

        // ── Register profiles + seed REP events ──────────────────────────────
        // Each account gets ONE broadcast segment containing all its transactions
        // (register + giveRep). Forge tracks nonces per-segment, so splitting an
        // account across multiple segments causes "nonce too low" errors.

        vm.startBroadcast(ALICE_KEY);
        profileRegistry.registerName("alice");
        repEmitter.giveRep(BOB, 0, 5);   // alice → bob: 5 research
        repEmitter.giveRep(CAROL, 1, 2); // alice → carol: 2 builder
        vm.stopBroadcast();

        vm.startBroadcast(BOB_KEY);
        profileRegistry.registerName("bob");
        repEmitter.giveRep(ALICE, 5, 3); // bob → alice: 3 community
        repEmitter.giveRep(DAVE, 2, 1);  // bob → dave: 1 trader
        vm.stopBroadcast();

        vm.startBroadcast(CAROL_KEY);
        profileRegistry.registerName("carol");
        repEmitter.giveRep(BOB, 4, 1);   // carol → bob: 1 governance
        vm.stopBroadcast();

        vm.startBroadcast(DAVE_KEY);
        profileRegistry.registerName("dave");
        vm.stopBroadcast();

        // ── Register ecosystem profiles (accounts #10–29 → eco01–eco20) ───────
        for (uint256 i = 0; i < 20; i++) {
            uint256 key = vm.deriveKey(MNEMONIC, uint32(10 + i));
            string memory num = vm.toString(i + 1);
            string memory paddedNum = bytes(num).length == 1 ? string.concat("0", num) : num;
            string memory username = string.concat("eco", paddedNum);
            vm.startBroadcast(key);
            profileRegistry.registerName(username);
            vm.stopBroadcast();
        }

        // ── Print addresses for .env.local ────────────────────────────────────
        console2.log("=== Contract Addresses (paste into .env.local) ===");
        console2.log("FAKE_UNI_ADDRESS=", address(fakeUni));
        console2.log("PROFILE_REGISTRY_ADDRESS=", address(profileRegistry));
        console2.log("REP_EMITTER_ADDRESS=", address(repEmitter));
        console2.log("ROOT_REGISTRY_ADDRESS=", address(rootRegistry));
        console2.log("CHECKPOINT_VERIFIER_ADDRESS=", address(verifier));
        console2.log("CHALLENGE_REGISTRY_ADDRESS=", address(challengeRegistry));
        console2.log("PROTOCOL_GIVERS=", address(challengeRegistry));
    }
}
