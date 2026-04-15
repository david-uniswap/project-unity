// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @title RepEmitter
/// @notice Append-only REP signal layer. Any wallet can call giveRep to emit a REP event.
///         The offchain indexer ingests these events and enforces Aura-based allowances —
///         specifically, a giver's cumulative abs(REP given) must not exceed their current Aura.
///         REP can be positive or negative. Negative REP is how givers offset prior positive REP.
///
///         Categories:
///           0 — Research
///           1 — Builder
///           2 — Trader
///           3 — Liquidity
///           4 — Governance
///           5 — Community
contract RepEmitter {
    // -------------------------------------------------------------------------
    // Constants
    // -------------------------------------------------------------------------

    uint8 public constant CATEGORY_RESEARCH = 0;
    uint8 public constant CATEGORY_BUILDER = 1;
    uint8 public constant CATEGORY_TRADER = 2;
    uint8 public constant CATEGORY_LIQUIDITY = 3;
    uint8 public constant CATEGORY_GOVERNANCE = 4;
    uint8 public constant CATEGORY_COMMUNITY = 5;

    uint8 public constant MAX_CATEGORY = 5;

    // -------------------------------------------------------------------------
    // Events
    // -------------------------------------------------------------------------

    /// @notice Emitted on every giveRep call that passes basic validation.
    ///         The indexer is authoritative on which of these actually count toward REP totals.
    event RepGiven(
        address indexed from,
        address indexed to,
        uint8 indexed category,
        int256 amount,
        uint256 timestamp
    );

    // -------------------------------------------------------------------------
    // Errors
    // -------------------------------------------------------------------------

    error SelfRep();
    error InvalidCategory(uint8 category);
    error ZeroAmount();
    error ZeroAddress();

    // -------------------------------------------------------------------------
    // External functions
    // -------------------------------------------------------------------------

    /// @notice Emit a REP signal from caller to `to` in the given category.
    ///         Amount is a signed integer — positive grants REP, negative offsets prior grants.
    ///         The indexer validates that abs(total REP given) ≤ giver's Aura from last epoch.
    ///
    /// @param to        Recipient address (must not be caller, must not be zero).
    /// @param category  REP category (0-5).
    /// @param amount    Signed REP units. Must be non-zero.
    function giveRep(address to, uint8 category, int256 amount) external {
        if (to == address(0)) revert ZeroAddress();
        if (to == msg.sender) revert SelfRep();
        if (category > MAX_CATEGORY) revert InvalidCategory(category);
        if (amount == 0) revert ZeroAmount();

        emit RepGiven(msg.sender, to, category, amount, block.timestamp);
    }
}
