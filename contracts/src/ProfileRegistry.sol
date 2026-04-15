// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @title ProfileRegistry
/// @notice Onchain source of truth for usernames and wallet-linking.
///         - Usernames: lowercase a-z and 0-9 only, max 20 chars, unique.
///         - Each profile has a primary wallet (registrant) and optionally one linked wallet.
///         - Transfers between linked wallets do not break Aura continuity (enforced offchain).
contract ProfileRegistry {
    // -------------------------------------------------------------------------
    // Types
    // -------------------------------------------------------------------------

    struct Profile {
        string username;
        address linkedWallet;
        uint256 createdAt;
    }

    // -------------------------------------------------------------------------
    // State
    // -------------------------------------------------------------------------

    /// @notice username -> primary wallet address
    mapping(string => address) public usernameToWallet;

    /// @notice primary wallet -> Profile
    mapping(address => Profile) internal _profiles;

    /// @notice linked wallet -> primary wallet (zero if not linked)
    mapping(address => address) public linkedToPrimary;

    // -------------------------------------------------------------------------
    // Events
    // -------------------------------------------------------------------------

    event NameRegistered(address indexed wallet, string name);
    event WalletLinked(address indexed primary, address indexed linked);
    event WalletUnlinked(address indexed primary, address indexed linked);

    // -------------------------------------------------------------------------
    // Errors
    // -------------------------------------------------------------------------

    error NameTaken();
    error InvalidName();
    error AlreadyRegistered();
    error NotRegistered();
    error WalletAlreadyLinked();
    error CannotLinkSelf();
    error WalletIsAlreadyPrimary();
    error NoLinkedWallet();
    error Unauthorized();
    error ZeroAddress();

    // -------------------------------------------------------------------------
    // External functions
    // -------------------------------------------------------------------------

    /// @notice Register a username for msg.sender. Caller must not already have one.
    /// @param name  Desired username (lowercase a-z 0-9, 1-20 chars).
    function registerName(string calldata name) external {
        _validateName(name);
        if (usernameToWallet[name] != address(0)) revert NameTaken();
        if (bytes(_profiles[msg.sender].username).length > 0) revert AlreadyRegistered();

        usernameToWallet[name] = msg.sender;
        _profiles[msg.sender] = Profile({
            username: name,
            linkedWallet: address(0),
            createdAt: block.timestamp
        });

        emit NameRegistered(msg.sender, name);
    }

    /// @notice Link a second wallet to the caller's profile.
    ///         The linked wallet must not have its own username or already be linked elsewhere.
    /// @param wallet  The secondary wallet address to link.
    function linkWallet(address wallet) external {
        if (wallet == address(0)) revert ZeroAddress();
        if (bytes(_profiles[msg.sender].username).length == 0) revert NotRegistered();
        if (_profiles[msg.sender].linkedWallet != address(0)) revert WalletAlreadyLinked();
        if (wallet == msg.sender) revert CannotLinkSelf();
        if (bytes(_profiles[wallet].username).length > 0) revert WalletIsAlreadyPrimary();
        if (linkedToPrimary[wallet] != address(0)) revert WalletAlreadyLinked();

        _profiles[msg.sender].linkedWallet = wallet;
        linkedToPrimary[wallet] = msg.sender;

        emit WalletLinked(msg.sender, wallet);
    }

    /// @notice Unlink the secondary wallet from the caller's profile.
    function unlinkWallet() external {
        if (bytes(_profiles[msg.sender].username).length == 0) revert NotRegistered();
        address linked = _profiles[msg.sender].linkedWallet;
        if (linked == address(0)) revert NoLinkedWallet();

        _profiles[msg.sender].linkedWallet = address(0);
        linkedToPrimary[linked] = address(0);

        emit WalletUnlinked(msg.sender, linked);
    }

    // -------------------------------------------------------------------------
    // View functions
    // -------------------------------------------------------------------------

    /// @notice Return the primary wallet for any wallet (primary or linked).
    ///         Returns address(0) if the wallet has no registered profile.
    function getPrimaryWallet(address wallet) external view returns (address) {
        address primary = linkedToPrimary[wallet];
        if (primary != address(0)) return primary;
        if (bytes(_profiles[wallet].username).length > 0) return wallet;
        return address(0);
    }

    /// @notice Return full profile data for a primary wallet.
    function getProfile(address primaryWallet)
        external
        view
        returns (string memory username, address linkedWallet, uint256 createdAt)
    {
        Profile storage p = _profiles[primaryWallet];
        return (p.username, p.linkedWallet, p.createdAt);
    }

    /// @notice Convenience: resolve any wallet to its profile username (empty if none).
    function getUsernameForWallet(address wallet) external view returns (string memory) {
        address primary = linkedToPrimary[wallet];
        if (primary != address(0)) return _profiles[primary].username;
        return _profiles[wallet].username;
    }

    // -------------------------------------------------------------------------
    // Internal helpers
    // -------------------------------------------------------------------------

    /// @dev Validates that name is 1-20 chars, all lowercase a-z or 0-9.
    function _validateName(string calldata name) internal pure {
        bytes memory b = bytes(name);
        if (b.length == 0 || b.length > 20) revert InvalidName();
        for (uint256 i = 0; i < b.length; i++) {
            bytes1 c = b[i];
            bool isLower = c >= 0x61 && c <= 0x7a; // a-z
            bool isDigit = c >= 0x30 && c <= 0x39; // 0-9
            if (!isLower && !isDigit) revert InvalidName();
        }
    }
}
