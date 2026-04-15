// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @dev Minimal interface — only the functions ChallengeRegistry needs.
interface IRootRegistry {
    function epochRoots(uint256 epoch) external view returns (bytes32);
    function epochDatasetHashes(uint256 epoch) external view returns (bytes32);
    function currentEpoch() external view returns (uint256);
}

/// @dev Minimal interface — ChallengeRegistry calls giveRep as the protocol sender.
interface IRepEmitter {
    function giveRep(address to, uint8 category, int256 amount) external;
}

/// @title ChallengeRegistry
/// @notice Allows anyone to challenge a posted Merkle root they believe is incorrect.
///
///         Flow:
///           1. Challenger calls submitChallenge(epoch, claimedCorrectRoot, evidenceHash)
///              where evidenceHash is a keccak256 reference to an off-chain document
///              (e.g. IPFS CID, URL hash) explaining the discrepancy.
///           2. The protocol owner investigates by re-running the snapshot computation.
///           3. If the root was wrong, owner calls acceptChallenge(id) — the challenger
///              receives 1 000 Aura and 1 000 Builder REP automatically.
///           4. If the root was correct, owner calls rejectChallenge(id, reason).
///
///         Rewards:
///           - 1 000 Aura bonus (credited by the indexer reading AuraBountyGranted events).
///           - 1 000 Builder REP (the registry calls RepEmitter.giveRep on behalf of the
///             protocol — the indexer whitelists this address and bypasses Aura allowance
///             checks for it).
///
///         Multiple challenges per epoch are allowed; each is resolved independently.
contract ChallengeRegistry {
    // -------------------------------------------------------------------------
    // Constants
    // -------------------------------------------------------------------------

    /// @notice Aura bonus awarded to a successful challenger (1 000 Aura, 1e18-scaled).
    uint256 public constant AURA_REWARD = 1_000e18;

    /// @notice Builder REP awarded to a successful challenger.
    int256 public constant REP_REWARD = 1_000;

    /// @notice Builder category index in RepEmitter.
    uint8 public constant BUILDER_CATEGORY = 1;

    // -------------------------------------------------------------------------
    // Types
    // -------------------------------------------------------------------------

    enum ChallengeStatus {
        Pending,
        Accepted,
        Rejected
    }

    struct Challenge {
        address challenger;
        uint256 epochNumber;
        /// @dev What the challenger believes the correct root should be.
        bytes32 claimedCorrectRoot;
        /// @dev keccak256 of off-chain evidence (IPFS CID, URL, or document hash).
        bytes32 evidenceHash;
        uint256 submittedAt;
        ChallengeStatus status;
    }

    // -------------------------------------------------------------------------
    // State
    // -------------------------------------------------------------------------

    address public owner;
    IRootRegistry public immutable rootRegistry;
    IRepEmitter public immutable repEmitter;

    uint256 public challengeCount;
    mapping(uint256 challengeId => Challenge) public challenges;

    /// @notice All challenge IDs submitted against a given epoch.
    mapping(uint256 epoch => uint256[]) public epochChallengeIds;

    // -------------------------------------------------------------------------
    // Events
    // -------------------------------------------------------------------------

    /// @notice Emitted when a new challenge is submitted.
    event ChallengeSubmitted(
        uint256 indexed challengeId,
        address indexed challenger,
        uint256 indexed epochNumber,
        bytes32 claimedCorrectRoot,
        bytes32 evidenceHash
    );

    /// @notice Emitted when the owner confirms a challenge is valid.
    ///         The indexer reads this event to credit 1 000 Aura to the challenger.
    event ChallengeAccepted(
        uint256 indexed challengeId,
        address indexed challenger,
        uint256 indexed epochNumber
    );

    /// @notice Emitted when the owner dismisses a challenge.
    event ChallengeRejected(
        uint256 indexed challengeId,
        address indexed challenger,
        string reason
    );

    /// @notice Emitted on challenge acceptance. The indexer reads this to add
    ///         `amount` (1e18-scaled) of permanent bonus Aura to `recipient`.
    event AuraBountyGranted(
        address indexed recipient,
        uint256 amount,
        uint256 indexed challengeId
    );

    // -------------------------------------------------------------------------
    // Errors
    // -------------------------------------------------------------------------

    error Unauthorized();
    error EpochNotFound();
    error RootMatchesPosted();
    error NotPending();
    error ZeroAddress();

    // -------------------------------------------------------------------------
    // Constructor
    // -------------------------------------------------------------------------

    constructor(address _rootRegistry, address _repEmitter) {
        owner = msg.sender;
        rootRegistry = IRootRegistry(_rootRegistry);
        repEmitter = IRepEmitter(_repEmitter);
    }

    // -------------------------------------------------------------------------
    // External functions — challenge submission
    // -------------------------------------------------------------------------

    /// @notice Submit a challenge against a posted epoch root.
    ///
    /// @param epochNumber         The epoch whose root is being challenged.
    /// @param claimedCorrectRoot  The root the challenger believes is correct.
    /// @param evidenceHash        keccak256 of off-chain evidence explaining the discrepancy.
    ///                            Pass bytes32(0) if evidence is submitted off-chain separately.
    /// @return challengeId        The assigned challenge ID.
    function submitChallenge(
        uint256 epochNumber,
        bytes32 claimedCorrectRoot,
        bytes32 evidenceHash
    ) external returns (uint256 challengeId) {
        bytes32 postedRoot = rootRegistry.epochRoots(epochNumber);
        if (postedRoot == bytes32(0)) revert EpochNotFound();
        if (postedRoot == claimedCorrectRoot) revert RootMatchesPosted();

        challengeId = ++challengeCount;
        challenges[challengeId] = Challenge({
            challenger: msg.sender,
            epochNumber: epochNumber,
            claimedCorrectRoot: claimedCorrectRoot,
            evidenceHash: evidenceHash,
            submittedAt: block.timestamp,
            status: ChallengeStatus.Pending
        });
        epochChallengeIds[epochNumber].push(challengeId);

        emit ChallengeSubmitted(
            challengeId,
            msg.sender,
            epochNumber,
            claimedCorrectRoot,
            evidenceHash
        );
    }

    // -------------------------------------------------------------------------
    // External functions — challenge resolution (owner only)
    // -------------------------------------------------------------------------

    /// @notice Accept a challenge: the posted root was wrong.
    ///         Grants the challenger 1 000 Aura (via AuraBountyGranted event read by indexer)
    ///         and 1 000 Builder REP (via direct RepEmitter call).
    function acceptChallenge(uint256 challengeId) external {
        if (msg.sender != owner) revert Unauthorized();
        Challenge storage c = challenges[challengeId];
        if (c.status != ChallengeStatus.Pending) revert NotPending();

        // Effects first.
        c.status = ChallengeStatus.Accepted;

        // Emit all events before external calls (CEI pattern).
        emit AuraBountyGranted(c.challenger, AURA_REWARD, challengeId);
        emit ChallengeAccepted(challengeId, c.challenger, c.epochNumber);

        // External interaction last — RepEmitter call.
        repEmitter.giveRep(c.challenger, BUILDER_CATEGORY, REP_REWARD);
    }

    /// @notice Reject a challenge: the posted root was correct.
    /// @param reason  Human-readable reason stored onchain for transparency.
    function rejectChallenge(uint256 challengeId, string calldata reason) external {
        if (msg.sender != owner) revert Unauthorized();
        Challenge storage c = challenges[challengeId];
        if (c.status != ChallengeStatus.Pending) revert NotPending();

        c.status = ChallengeStatus.Rejected;
        emit ChallengeRejected(challengeId, c.challenger, reason);
    }

    // -------------------------------------------------------------------------
    // View helpers
    // -------------------------------------------------------------------------

    /// @notice Returns all challenge IDs against a given epoch.
    function getEpochChallengeIds(uint256 epochNumber)
        external
        view
        returns (uint256[] memory)
    {
        return epochChallengeIds[epochNumber];
    }

    /// @notice Returns a challenge by ID.
    function getChallenge(uint256 challengeId)
        external
        view
        returns (Challenge memory)
    {
        return challenges[challengeId];
    }

    // -------------------------------------------------------------------------
    // Admin
    // -------------------------------------------------------------------------

    event OwnershipTransferred(address indexed oldOwner, address indexed newOwner);

    function transferOwnership(address newOwner) external {
        if (msg.sender != owner) revert Unauthorized();
        if (newOwner == address(0)) revert ZeroAddress();
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }
}
