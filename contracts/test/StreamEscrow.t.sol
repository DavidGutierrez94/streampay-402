// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;
import {StreamEscrow} from "../src/StreamEscrow.sol";

interface Vm { function warp(uint256) external; function prank(address) external; function deal(address,uint256) external; function expectRevert(bytes4) external; }

contract StreamEscrowTest {
    Vm constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));
    StreamEscrow e;
    address payer = address(0xA11CE);
    address payee = address(0xB0B);

    function setUp() public { e = new StreamEscrow(); vm.deal(payer, 100 ether); vm.warp(1000); }

    function _open() internal returns (uint256 id) { vm.prank(payer); id = e.open{value: 10 ether}(payee, 1 ether); }

    function testAccrual() public {
        uint256 id = _open();
        vm.warp(1003);
        require(e.owed(id) == 3 ether, "owed");
        require(e.isActive(id), "active");
    }

    function testCapAtDeposit() public {
        uint256 id = _open();
        vm.warp(2000);
        require(e.owed(id) == 10 ether, "cap");
        require(!e.isActive(id), "exhausted");
    }

    function testCloseRefunds() public {
        uint256 id = _open();
        vm.warp(1004);
        vm.prank(payer); e.close(id);
        require(payee.balance == 4 ether, "payee");
        require(payer.balance == 96 ether, "refund");
        vm.warp(1100);
        require(e.owed(id) == 4 ether, "frozen");
    }

    function testClaimThenClose() public {
        uint256 id = _open();
        vm.warp(1002); vm.prank(payee); e.claim(id);
        require(payee.balance == 2 ether, "claim1");
        vm.warp(1005); vm.prank(payer); e.close(id);
        require(payee.balance == 5 ether, "total");
        require(payer.balance == 95 ether, "refund");
    }

    function testStrangerCannotClose() public {
        uint256 id = _open();
        vm.prank(address(0xBAD));
        vm.expectRevert(StreamEscrow.NotParty.selector);
        e.close(id);
    }
}
