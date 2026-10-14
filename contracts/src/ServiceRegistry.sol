// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @title ServiceRegistry - onchain sign-up for streampay-402 providers and agents.
/// Providers register a per-second priced service and the keccak256 hash of a
/// Stripe-style secret key (sk_...). The secret itself never touches the chain.
/// The publishable key (pk_...) is derived from the serviceId.
contract ServiceRegistry {
    struct Service { address owner; address payee; uint128 ratePerSec; bytes32 keyHash; bool active; string name; }
    struct Agent { address owner; string name; }

    Service[] internal _services;
    Agent[] internal _agents;
    mapping(address => uint256[]) public servicesOf;
    mapping(address => uint256) public agentOf; // owner => agentId+1 (0 = none)

    event ServiceRegistered(uint256 indexed serviceId, address indexed owner, address indexed payee, uint128 ratePerSec, string name);
    event KeyRotated(uint256 indexed serviceId, bytes32 keyHash);
    event ServiceStatus(uint256 indexed serviceId, bool active);
    event AgentRegistered(uint256 indexed agentId, address indexed owner, string name);

    error NotOwner();
    error BadInput();
    error AlreadyRegistered();

    function registerService(string calldata name, uint128 ratePerSec, address payee, bytes32 keyHash) external returns (uint256 id) {
        if (bytes(name).length == 0 || bytes(name).length > 64 || ratePerSec == 0 || payee == address(0) || keyHash == bytes32(0)) revert BadInput();
        id = _services.length;
        _services.push(Service(msg.sender, payee, ratePerSec, keyHash, true, name));
        servicesOf[msg.sender].push(id);
        emit ServiceRegistered(id, msg.sender, payee, ratePerSec, name);
        emit KeyRotated(id, keyHash);
    }

    function rotateKey(uint256 id, bytes32 keyHash) external {
        if (_services[id].owner != msg.sender) revert NotOwner();
        if (keyHash == bytes32(0)) revert BadInput();
        _services[id].keyHash = keyHash;
        emit KeyRotated(id, keyHash);
    }

    function setActive(uint256 id, bool active) external {
        if (_services[id].owner != msg.sender) revert NotOwner();
        _services[id].active = active;
        emit ServiceStatus(id, active);
    }

    function registerAgent(string calldata name) external returns (uint256 id) {
        if (bytes(name).length == 0 || bytes(name).length > 64) revert BadInput();
        if (agentOf[msg.sender] != 0) revert AlreadyRegistered();
        id = _agents.length;
        _agents.push(Agent(msg.sender, name));
        agentOf[msg.sender] = id + 1;
        emit AgentRegistered(id, msg.sender, name);
    }

    function service(uint256 id) external view returns (Service memory) { return _services[id]; }
    function agent(uint256 id) external view returns (Agent memory) { return _agents[id]; }
    function serviceCount() external view returns (uint256) { return _services.length; }
    function agentCount() external view returns (uint256) { return _agents.length; }
    /// @notice Check a secret key against the stored hash (hash = keccak256(bytes(sk))).
    function verifyKey(uint256 id, bytes32 keyHash) external view returns (bool) {
        return id < _services.length && _services[id].active && _services[id].keyHash == keyHash;
    }
}
