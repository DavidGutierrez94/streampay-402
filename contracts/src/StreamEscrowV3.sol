// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @title StreamEscrowV3 — per-second escrow plus optional spend caps. NOT DEPLOYED.
/// @notice Live payments use StreamEscrow v2 at 0x51ff24a504b2f7446df1767fea43063d7dd525eb.
///         v3 is a new contract, not an in-place upgrade. src/deploy.ts still deploys v2.
///         Settlement matches v2 (gas-capped payee leg, pull-credit fallback). On top of that,
///         a payer may setAgentPolicy and a key admin may registerKey + setKeyPolicy.
///         open() enforces the payer's policy when one is set. openWithKey() also enforces
///         the key policy. close() releases the unused deposit reservation so refunds return budget.
/// @dev Unaudited. Do not point the running server at a v3 address unless you deploy it yourself.
contract StreamEscrowV3 {
    struct Stream {
        address payer;
        address payee;
        uint128 ratePerSec;
        uint128 deposit;
        uint64 start;
        uint64 stoppedAt;
        uint128 claimed;
    }

    struct Policy {
        uint128 maxTotalSpend;
        uint128 maxRatePerSec;
        uint64 maxSessionDuration;
        bool set;
    }

    uint256 public nextId = 1;
    uint256 private constant PAYEE_GAS = 30_000;
    mapping(address => uint256) public credit;
    mapping(uint256 => Stream) public streams;

    mapping(address => Policy) public agentPolicy;
    mapping(bytes32 => Policy) public keyPolicy;
    mapping(bytes32 => address) public keyAdmin;
    mapping(address => uint256) public agentSpent;
    mapping(address => uint256) public agentReserved;
    mapping(bytes32 => uint256) public keySpent;
    mapping(bytes32 => uint256) public keyReserved;
    mapping(uint256 => bytes32) public streamKey;
    mapping(uint256 => uint256) public streamReservedAgent;
    mapping(uint256 => uint256) public streamReservedKey;

    event Opened(uint256 indexed id, address indexed payer, address indexed payee, uint256 ratePerSec, uint256 deposit);
    event Claimed(uint256 indexed id, uint256 amount);
    event Closed(uint256 indexed id, address indexed by, uint256 paidToPayee, uint256 refunded);
    event Credited(address indexed payee, uint256 amount);
    event Withdrawn(address indexed payee, uint256 amount);
    event AgentPolicySet(address indexed agent, uint128 maxTotalSpend, uint128 maxRatePerSec, uint64 maxSessionDuration);
    event KeyRegistered(bytes32 indexed keyHash, address indexed admin);
    event KeyPolicySet(bytes32 indexed keyHash, uint128 maxTotalSpend, uint128 maxRatePerSec, uint64 maxSessionDuration);
    event PolicyReserved(uint256 indexed id, address indexed payer, bytes32 keyHash, uint256 reserved);
    event PolicySettled(uint256 indexed id, uint256 spent, uint256 released);

    error NotParty();
    error NotKeyAdmin();
    error Inactive();
    error BadParams();
    error RateCap();
    error DurationCap();
    error SpendCap();

    function setAgentPolicy(uint128 maxTotalSpend, uint128 maxRatePerSec, uint64 maxSessionDuration) external {
        agentPolicy[msg.sender] = Policy(maxTotalSpend, maxRatePerSec, maxSessionDuration, true);
        emit AgentPolicySet(msg.sender, maxTotalSpend, maxRatePerSec, maxSessionDuration);
    }

    function registerKey(bytes32 keyHash) external {
        if (keyHash == bytes32(0) || keyAdmin[keyHash] != address(0)) revert BadParams();
        keyAdmin[keyHash] = msg.sender;
        emit KeyRegistered(keyHash, msg.sender);
    }

    function setKeyPolicy(bytes32 keyHash, uint128 maxTotalSpend, uint128 maxRatePerSec, uint64 maxSessionDuration) external {
        if (keyAdmin[keyHash] != msg.sender) revert NotKeyAdmin();
        keyPolicy[keyHash] = Policy(maxTotalSpend, maxRatePerSec, maxSessionDuration, true);
        emit KeyPolicySet(keyHash, maxTotalSpend, maxRatePerSec, maxSessionDuration);
    }

    function open(address payee, uint128 ratePerSec) external payable returns (uint256 id) {
        return _open(payee, ratePerSec, bytes32(0));
    }

    /// @notice open and enforce the policy registered for keyHash, plus the payer's own policy if set
    function openWithKey(address payee, uint128 ratePerSec, bytes32 keyHash) external payable returns (uint256 id) {
        if (!keyPolicy[keyHash].set) revert BadParams();
        return _open(payee, ratePerSec, keyHash);
    }

    function _open(address payee, uint128 ratePerSec, bytes32 keyHash) internal returns (uint256 id) {
        if (payee == address(0) || payee == msg.sender || ratePerSec == 0 || msg.value < ratePerSec || msg.value > type(uint128).max) revert BadParams();
        Policy memory ap = agentPolicy[msg.sender];
        if (ap.set) _enforce(ap, agentSpent[msg.sender], agentReserved[msg.sender], ratePerSec, msg.value);
        if (keyHash != bytes32(0)) {
            Policy memory kp = keyPolicy[keyHash];
            _enforce(kp, keySpent[keyHash], keyReserved[keyHash], ratePerSec, msg.value);
        }
        id = nextId++;
        streams[id] = Stream(msg.sender, payee, ratePerSec, uint128(msg.value), uint64(block.timestamp), 0, 0);
        if (ap.set) {
            agentReserved[msg.sender] += msg.value;
            streamReservedAgent[id] = msg.value;
        }
        if (keyHash != bytes32(0)) {
            keyReserved[keyHash] += msg.value;
            streamReservedKey[id] = msg.value;
            streamKey[id] = keyHash;
        }
        emit Opened(id, msg.sender, payee, ratePerSec, msg.value);
        if (ap.set || keyHash != bytes32(0)) emit PolicyReserved(id, msg.sender, keyHash, msg.value);
    }

    function _enforce(Policy memory p, uint256 spent, uint256 reserved, uint128 ratePerSec, uint256 value) internal pure {
        if (ratePerSec > p.maxRatePerSec) revert RateCap();
        if (uint256(ratePerSec) * uint256(p.maxSessionDuration) < value) revert DurationCap();
        if (spent + reserved + value > p.maxTotalSpend) revert SpendCap();
    }

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
        if (amt == 0) return;
        s.claimed += uint128(amt);
        _send(s.payee, amt);
        emit Claimed(id, amt);
    }

    function close(uint256 id) external {
        Stream storage s = streams[id];
        if (msg.sender != s.payer && msg.sender != s.payee) revert NotParty();
        if (s.stoppedAt != 0) revert Inactive();
        uint256 total = owed(id);
        s.stoppedAt = uint64(block.timestamp);
        uint256 toPayee = total - s.claimed;
        uint256 refund = s.deposit - total;
        s.claimed = uint128(total);
        _settle(id, total, refund);
        if (!_trySend(s.payee, toPayee)) {
            credit[s.payee] += toPayee;
            emit Credited(s.payee, toPayee);
        }
        _send(s.payer, refund);
        emit Closed(id, msg.sender, toPayee, refund);
    }

    function _settle(uint256 id, uint256 spent, uint256 released) internal {
        uint256 reservedAgent = streamReservedAgent[id];
        uint256 reservedKey = streamReservedKey[id];
        if (reservedAgent == 0 && reservedKey == 0) return;
        if (reservedAgent != 0) {
            address payer = streams[id].payer;
            agentReserved[payer] -= reservedAgent;
            agentSpent[payer] += spent;
            streamReservedAgent[id] = 0;
        }
        if (reservedKey != 0) {
            bytes32 keyHash = streamKey[id];
            keyReserved[keyHash] -= reservedKey;
            keySpent[keyHash] += spent;
            streamReservedKey[id] = 0;
        }
        emit PolicySettled(id, spent, released);
    }

    function withdraw() external {
        uint256 amt = credit[msg.sender];
        credit[msg.sender] = 0;
        _send(msg.sender, amt);
        emit Withdrawn(msg.sender, amt);
    }

    function _trySend(address to, uint256 amt) internal returns (bool ok) {
        if (amt == 0) return true;
        assembly { ok := call(PAYEE_GAS, to, amt, 0, 0, 0, 0) }
    }

    function _send(address to, uint256 amt) internal {
        if (amt == 0) return;
        (bool ok,) = to.call{value: amt}("");
        require(ok, "send");
    }
}
