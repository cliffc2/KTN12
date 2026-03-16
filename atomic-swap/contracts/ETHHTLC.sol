// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

// Ethereum HTLC Contract for Kaspa ↔ ETH Atomic Swaps
// Based on Stroemnet paper Section 2.3

contract HTLC {
    bytes32 public hashlock;      // H = sha256(secret)
    uint256 public timelock;       // TB in seconds
    address public alice;          // Creator (Kaspa side)
    address public bob;            // Receiver (ETH side)
    bool public claimed;           // Claim status
    bool public refunded;          // Refund status
    uint256 public amount;         // Amount locked
    
    event Created(address indexed alice, address indexed bob, bytes32 hashlock, uint256 timelock, uint256 amount);
    event Claimed(bytes32 preimage, address indexed bob);
    event Refunded(address indexed alice);

    modifier notClaimed() {
        require(!claimed, "Already claimed");
        _;
    }

    modifier notRefunded() {
        require(!refunded, "Already refunded");
        _;
    }

    // Constructor - creates the HTLC
    constructor(
        bytes32 _hashlock,
        uint256 _timelock,
        address _bob
    ) {
        require(_timelock > block.timestamp, "Timelock must be in the future");
        
        hashlock = _hashlock;
        timelock = _timelock;
        alice = msg.sender;
        bob = _bob;
        claimed = false;
        refunded = false;
        amount = msg.value;
        
        emit Created(alice, bob, hashlock, timelock, amount);
    }

    // Fallback to receive ETH
    receive() external payable {
        amount += msg.value;
    }

    // Claim function - bob can claim with preimage
    // Only works if timelock hasn't expired and hash matches
    function claim(bytes32 preimage) external notClaimed notRefunded {
        require(msg.sender == bob, "Only bob can claim");
        
        // Verify hashlock
        require(sha256(abi.encodePacked(preimage)) == hashlock, "Invalid preimage");
        
        // Verify timelock hasn't expired
        require(block.timestamp < timelock, "Timelock expired");
        
        claimed = true;
        
        // Transfer funds to bob
        payable(bob).transfer(address(this).balance);
        
        emit Claimed(preimage, bob);
    }

    // Refund function - alice can refund after timelock
    function refund() external notClaimed notRefunded {
        require(msg.sender == alice, "Only alice can refund");
        
        // Verify timelock has expired
        require(block.timestamp >= timelock, "Timelock not yet expired");
        
        refunded = true;
        
        // Transfer funds back to alice
        payable(alice).transfer(address(this).balance);
        
        emit Refunded(alice);
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

    // Check if preimage is valid (view function)
    function verifyPreimage(bytes32 preimage) external view returns (bool) {
        return sha256(abi.encodePacked(preimage)) == hashlock;
    }
}
