// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @title StreamEscrow — per-second metering escrow for x402 time-based services
/// @notice Payer deposits native MON, payee accrues rate*elapsed, payer can close any time for an instant refund.
contract StreamEscrow {
    struct Stream {
        address payer;
        address payee;
        uint128 ratePerSec;
        uint128 deposit;
        uint64 start;
        uint64 stoppedAt; // 0 while open
        uint128 claimed;
    }

    uint256 public nextId = 1;
    mapping(uint256 => Stream) public streams;

    event Opened(uint256 indexed id, address indexed payer, address indexed payee, uint256 ratePerSec, uint256 deposit);
    event Claimed(uint256 indexed id, uint256 amount);
    event Closed(uint256 indexed id, uint256 paidToPayee, uint256 refunded);

    error NotParty();
    error Inactive();
    error BadParams();

    function open(address payee, uint128 ratePerSec) external payable returns (uint256 id) {
        if (payee == address(0) || ratePerSec == 0 || msg.value < ratePerSec) revert BadParams();
        id = nextId++;
        streams[id] = Stream(msg.sender, payee, ratePerSec, uint128(msg.value), uint64(block.timestamp), 0, 0);
        emit Opened(id, msg.sender, payee, ratePerSec, msg.value);
    }

    /// @notice total accrued to payee so far (capped by deposit)
    function owed(uint256 id) public view returns (uint256) {
        Stream memory s = streams[id];
        uint256 end = s.stoppedAt == 0 ? block.timestamp : s.stoppedAt;
        uint256 accrued = uint256(s.ratePerSec) * (end - s.start);
        return accrued > s.deposit ? s.deposit : accrued;
    }

    function remaining(uint256 id) external view returns (uint256) {
        return streams[id].deposit - owed(id);
    }

    function isActive(uint256 id) public view returns (bool) {
        Stream memory s = streams[id];
        return s.payer != address(0) && s.stoppedAt == 0 && owed(id) < s.deposit;
    }

    function claim(uint256 id) public {
        Stream storage s = streams[id];
        if (msg.sender != s.payee) revert NotParty();
        uint256 amt = owed(id) - s.claimed;
        s.claimed += uint128(amt);
        _send(s.payee, amt);
        emit Claimed(id, amt);
    }

    /// @notice either party stops the stream; payee gets accrued, payer gets the rest immediately
    function close(uint256 id) external {
        Stream storage s = streams[id];
        if (msg.sender != s.payer && msg.sender != s.payee) revert NotParty();
        if (s.stoppedAt != 0) revert Inactive();
        uint256 total = owed(id);
        s.stoppedAt = uint64(block.timestamp);
        uint256 toPayee = total - s.claimed;
        uint256 refund = s.deposit - total;
        s.claimed = uint128(total);
        _send(s.payee, toPayee);
        _send(s.payer, refund);
        emit Closed(id, toPayee, refund);
    }

    function _send(address to, uint256 amt) internal {
        if (amt == 0) return;
        (bool ok,) = to.call{value: amt}("");
        require(ok, "send");
    }
}
