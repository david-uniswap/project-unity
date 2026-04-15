// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @title RootRegistry
/// @notice Stores one Merkle root per epoch produced by the offchain snapshot pipeline.
///         Each root encodes per-profile Aura and REP state for that epoch.
///         A `datasetHash` is posted alongside each root so third parties can verify
///         that the dataset used to construct the tree matches the posted root.
contract RootRegistry {
    // -------------------------------------------------------------------------
    // State
    // -------------------------------------------------------------------------

    address public owner;
    address public poster;

    /// @notice True once the first root has been posted — prevents epoch 0 re-posting.
    bool public initialized;

    uint256 public currentEpoch;
    bytes32 public currentRoot;
    bytes32 public currentDatasetHash;
    uint256 public currentTimestamp;

    mapping(uint256 epoch => bytes32 root) public epochRoots;
    mapping(uint256 epoch => bytes32 datasetHash) public epochDatasetHashes;
    mapping(uint256 epoch => uint256 timestamp) public epochTimestamps;

    // -------------------------------------------------------------------------
    // Events
    // -------------------------------------------------------------------------

    /// @notice Emitted when a new root is posted. `datasetHash` is the keccak256
    ///         of the sorted leaf dataset JSON — challengers use this to re-derive
    ///         the tree and verify correctness.
    event RootPosted(
        uint256 indexed epoch,
        bytes32 indexed root,
        bytes32 datasetHash,
        uint256 timestamp
    );

    event PosterUpdated(address indexed oldPoster, address indexed newPoster);
    event OwnershipTransferred(address indexed oldOwner, address indexed newOwner);

    // -------------------------------------------------------------------------
    // Errors
    // -------------------------------------------------------------------------

    error Unauthorized();
    error InvalidEpoch(uint256 provided, uint256 current);
    error ZeroRoot();
    error ZeroDatasetHash();
    error ZeroAddress();

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
    /// @param epoch        Epoch number (must be > currentEpoch, except for the first post).
    /// @param root         Merkle root bytes32.
    /// @param datasetHash  keccak256 of the sorted leaf dataset JSON used to build the tree.
    function postRoot(uint256 epoch, bytes32 root, bytes32 datasetHash) external {
        if (msg.sender != poster) revert Unauthorized();
        if (root == bytes32(0)) revert ZeroRoot();
        if (datasetHash == bytes32(0)) revert ZeroDatasetHash();
        if (initialized && epoch <= currentEpoch) {
            revert InvalidEpoch(epoch, currentEpoch);
        }
        initialized = true;

        currentEpoch = epoch;
        currentRoot = root;
        currentDatasetHash = datasetHash;
        currentTimestamp = block.timestamp;
        epochRoots[epoch] = root;
        epochDatasetHashes[epoch] = datasetHash;
        epochTimestamps[epoch] = block.timestamp;

        emit RootPosted(epoch, root, datasetHash, block.timestamp);
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
        if (newOwner == address(0)) revert ZeroAddress();
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

    /// @notice Returns root + datasetHash for a given epoch.
    function getEpochInfo(uint256 epoch)
        external
        view
        returns (bytes32 root, bytes32 datasetHash, uint256 timestamp)
    {
        return (epochRoots[epoch], epochDatasetHashes[epoch], epochTimestamps[epoch]);
    }

    /// @notice Returns the current state as a single call.
    function getCurrentState()
        external
        view
        returns (uint256 epoch, bytes32 root, bytes32 datasetHash, uint256 timestamp)
    {
        return (currentEpoch, currentRoot, currentDatasetHash, currentTimestamp);
    }
}
