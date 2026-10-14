// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;
import {ServiceRegistry} from "../src/ServiceRegistry.sol";

interface Vm { function prank(address) external; function expectRevert(bytes4) external; }

contract ServiceRegistryTest {
    Vm constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));
    ServiceRegistry r;
    address alice = address(0xA11CE);
    bytes32 h = keccak256(bytes("sk_test_secret"));

    function setUp() public { r = new ServiceRegistry(); }

    function test_registerService() public {
        vm.prank(alice);
        uint256 id = r.registerService("gpu", 1e15, alice, h);
        require(id == 0 && r.serviceCount() == 1, "id");
        ServiceRegistry.Service memory s = r.service(0);
        require(s.owner == alice && s.payee == alice && s.ratePerSec == 1e15 && s.active, "fields");
        require(r.verifyKey(0, h), "key ok");
        require(!r.verifyKey(0, keccak256("wrong")), "key bad");
        require(!r.verifyKey(9, h), "oob");
    }

    function test_rotateAndDeactivate() public {
        vm.prank(alice); r.registerService("gpu", 1, alice, h);
        bytes32 h2 = keccak256("sk2");
        vm.prank(address(0xBAD)); vm.expectRevert(ServiceRegistry.NotOwner.selector); r.rotateKey(0, h2);
        vm.prank(alice); r.rotateKey(0, h2);
        require(r.verifyKey(0, h2) && !r.verifyKey(0, h), "rotated");
        vm.prank(alice); r.setActive(0, false);
        require(!r.verifyKey(0, h2), "inactive");
    }

    function test_badInput() public {
        vm.expectRevert(ServiceRegistry.BadInput.selector); r.registerService("", 1, alice, h);
        vm.expectRevert(ServiceRegistry.BadInput.selector); r.registerService("x", 0, alice, h);
        vm.expectRevert(ServiceRegistry.BadInput.selector); r.registerService("x", 1, address(0), h);
        vm.expectRevert(ServiceRegistry.BadInput.selector); r.registerService("x", 1, alice, bytes32(0));
    }

    function test_agent() public {
        vm.prank(alice); uint256 id = r.registerAgent("bot");
        require(id == 0 && r.agentOf(alice) == 1, "agent");
        vm.prank(alice); vm.expectRevert(ServiceRegistry.AlreadyRegistered.selector); r.registerAgent("bot2");
    }
}
