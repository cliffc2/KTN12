// SilverScript HTLC Contract for Kaspa Atomic Swaps
// Based on Stroemnet paper Section 2.3
// ==============================================
// TN12 / v1.1.0 Features:
// - Covenants enabled (--netsuffix=12)
// - 10 BPS block time (Crescendo)
// - KIP-17 Native Assets support
// - VSPC API v2 for integrations
//
// Usage on TN12:
//   silverc KaspaHTLC.sl --compile
//   Deploy with: --testnet --netsuffix=12

contract HTLC {
    // Public fields
    bytes32 public hashlock;      // H = sha256(secret)
    uint256 public timelock;       // TA in blocks (10 BPS = ~2.5min/block)
    address public alice;          // Creator/sender
    address public bob;            // Receiver
    bool public claimed;           // Claim status
    bool public refunded;          // Refund status

    // Constructor - creates the HTLC
    // TN12: Uses block.height for timelock (not timestamp)
    constructor(
        bytes32 _hashlock,
        uint256 _timelock,
        address _bob
    ) {
        hashlock = _hashlock;
        timelock = _timelock;
        alice = tx.sender;
        bob = _bob;
        claimed = false;
        refunded = false;
    }

    // Claim function - bob can claim with preimage
    // Only works if timelock hasn't expired and hash matches
    // TN12: 10 BPS means ~2.5 minutes per block
    function claim(bytes calldata preimage) external {
        require(!claimed, "Already claimed");
        require(!refunded, "Already refunded");
        require(msg.sender == bob, "Only bob can claim");
        
        // Verify hashlock (SHA256)
        require(sha256(preimage) == hashlock, "Invalid preimage");
        
        // Verify timelock hasn't expired (using block height)
        require(block.height < timelock, "Timelock expired");
        
        claimed = true;
        
        // Transfer funds to bob
        payable(bob).transfer(address(this).balance);
    }

    // Refund function - alice can refund after timelock
    // TN12: Wait for ~timelock * 2.5 minutes
    function refund() external {
        require(!claimed, "Already claimed");
        require(!refunded, "Already refunded");
        require(msg.sender == alice, "Only alice can refund");
        
        // Verify timelock has expired (using block height)
        require(block.height >= timelock, "Timelock not yet expired");
        
        refunded = true;
        
        // Transfer funds back to alice
        payable(alice).transfer(address(this).balance);
    }

    // Get contract info
    function getInfo() external view returns (
        bytes32,
        uint256,
        address,
        address,
        bool,
        bool,
        uint256
    ) {
        return (
            hashlock,
            timelock,
            alice,
            bob,
            claimed,
            refunded,
            address(this).balance
        );
    }
}
