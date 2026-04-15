// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @title RootRegistry
/// @notice Stores one Merkle root per epoch produced by the offchain snapshot pipeline.
///         Each root encodes per-profile Aura and REP state for that epoch.
contract RootRegistry {
    // -------------------------------------------------------------------------
    // State
    // -------------------------------------------------------------------------

    address public owner;
    address public poster;

    uint256 public currentEpoch;
    bytes32 public currentRoot;
    uint256 public currentTimestamp;

    mapping(uint256 epoch => bytes32 root) public epochRoots;
    mapping(uint256 epoch => uint256 timestamp) public epochTimestamps;

    // -------------------------------------------------------------------------
    // Events
    // -------------------------------------------------------------------------

    event RootPosted(uint256 indexed epoch, bytes32 indexed root, uint256 timestamp);
    event PosterUpdated(address indexed oldPoster, address indexed newPoster);
    event OwnershipTransferred(address indexed oldOwner, address indexed newOwner);

    // -------------------------------------------------------------------------
    // Errors
    // -------------------------------------------------------------------------

    error Unauthorized();
    error InvalidEpoch(uint256 provided, uint256 current);
    error ZeroRoot();

    // -------------------------------------------------------------------------
    // Constructor
    // -------------------------------------------------------------------------

    constructor(address _poster) {
        owner = msg.sender;
        poster = _poster;
    }

    // -------------------------------------------------------------------------
    // External functions
    // -------------------------------------------------------------------------

    /// @notice Post a new Merkle root for the given epoch.
    ///         Epoch must be strictly greater than the last posted epoch.
    /// @param epoch  Epoch number (must be > currentEpoch, except for the first post).
    /// @param root   Merkle root bytes32.
    function postRoot(uint256 epoch, bytes32 root) external {
        if (msg.sender != poster) revert Unauthorized();
        if (root == bytes32(0)) revert ZeroRoot();
        if (currentEpoch != 0 && epoch <= currentEpoch) {
            revert InvalidEpoch(epoch, currentEpoch);
        }

        currentEpoch = epoch;
        currentRoot = root;
        currentTimestamp = block.timestamp;
        epochRoots[epoch] = root;
        epochTimestamps[epoch] = block.timestamp;

        emit RootPosted(epoch, root, block.timestamp);
    }

    /// @notice Transfer root-posting rights to a new address.
    function updatePoster(address newPoster) external {
        if (msg.sender != owner) revert Unauthorized();
        emit PosterUpdated(poster, newPoster);
        poster = newPoster;
    }

    /// @notice Transfer ownership of this registry.
    function transferOwnership(address newOwner) external {
        if (msg.sender != owner) revert Unauthorized();
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }

    // -------------------------------------------------------------------------
    // View helpers
    // -------------------------------------------------------------------------

    /// @notice Returns the root for a given epoch (zero bytes32 if not found).
    function getRoot(uint256 epoch) external view returns (bytes32) {
        return epochRoots[epoch];
    }

    /// @notice Returns the current state as a single call.
    function getCurrentState()
        external
        view
        returns (uint256 epoch, bytes32 root, uint256 timestamp)
    {
        return (currentEpoch, currentRoot, currentTimestamp);
    }
}
