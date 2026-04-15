// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// @title FakeUNI
/// @notice Mintable ERC-20 for Sepolia testnet — used as the UNI stand-in for Project Unity demos.
///         Includes a public faucet so testers can self-mint without an owner key.
contract FakeUNI is ERC20, Ownable {
    /// @notice Max tokens claimable in a single faucet call (10 000 fUNI).
    uint256 public constant FAUCET_MAX = 10_000 ether;

    /// @notice Per-address faucet cooldown in seconds (1 hour).
    uint256 public constant FAUCET_COOLDOWN = 1 hours;

    mapping(address => uint256) public lastFaucetTime;

    error FaucetCooldownActive(uint256 nextAvailableAt);
    error FaucetAmountTooHigh(uint256 requested, uint256 max);

    constructor(address initialOwner) ERC20("Fake UNI", "fUNI") Ownable(initialOwner) {
        // Mint 1 000 000 fUNI to deployer for seeding liquidity / tests.
        _mint(initialOwner, 1_000_000 ether);
    }

    /// @notice Owner-only unrestricted mint.
    function mint(address to, uint256 amount) external onlyOwner {
        _mint(to, amount);
    }

    /// @notice Public faucet — anyone can call, up to FAUCET_MAX per FAUCET_COOLDOWN window.
    function faucet(uint256 amount) external {
        if (amount > FAUCET_MAX) revert FaucetAmountTooHigh(amount, FAUCET_MAX);
        uint256 next = lastFaucetTime[msg.sender] + FAUCET_COOLDOWN;
        if (block.timestamp < next) revert FaucetCooldownActive(next);
        lastFaucetTime[msg.sender] = block.timestamp;
        _mint(msg.sender, amount);
    }
}
