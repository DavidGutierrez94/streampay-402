// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;
import {StreamEscrow} from "../src/StreamEscrow.sol";

interface Vm { function warp(uint256) external; function prank(address) external; function deal(address,uint256) external; function expectRevert(bytes4) external; }

contract EvilPayee {
    bool public unlocked;
    function grab(StreamEscrow e, uint256 id) external { unlocked = true; e.claim(id); unlocked = false; }
    function pull(StreamEscrow e) external { unlocked = true; e.withdraw(); unlocked = false; }
    receive() external payable { require(unlocked, "no refunds for you"); }
}

contract GasBurner { receive() external payable { while (true) {} } }

contract Reenter { StreamEscrow public e; uint256 public id; function set(StreamEscrow _e, uint256 _id) external { e=_e; id=_id; } receive() external payable { try e.claim(id) {} catch {} } }

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

    function testH1RevertingPayeeCannotBlockRefund() public {
        EvilPayee p = new EvilPayee();
        vm.prank(payer); uint256 id = e.open{value: 10 ether}(address(p), 1 ether);
        vm.warp(1002);
        vm.prank(payer); e.close(id);                       // must succeed
        require(payer.balance == 98 ether, "refund");
        require(e.credit(address(p)) == 2 ether, "credited");
        vm.warp(2000);
        require(e.owed(id) == 2 ether, "meter stopped");
        p.grab(e, id);                                       // claim pays 0 more
        require(address(p).balance == 0, "no extra");
        p.pull(e);
        require(address(p).balance == 2 ether, "pulled");
        require(address(e).balance == 0, "conserved");
    }

    function testH1GasBurnerPayee() public {
        GasBurner g = new GasBurner();
        vm.prank(payer); uint256 id = e.open{value: 10 ether}(address(g), 1 ether);
        vm.warp(1003);
        vm.prank(payer); e.close(id);
        require(payer.balance == 97 ether, "refund");
        require(e.credit(address(g)) == 3 ether, "credited");
    }

    function testReentrantPayeeGetsNoExtra() public {
        Reenter r = new Reenter();
        vm.prank(payer); uint256 id = e.open{value: 10 ether}(address(r), 1 ether);
        r.set(e, id);
        vm.warp(1004);
        vm.prank(payer); e.close(id);
        require(address(r).balance + e.credit(address(r)) == 4 ether, "exact");
        require(payer.balance == 96 ether, "refund");
    }

    function testDoubleCloseReverts() public {
        uint256 id = _open();
        vm.warp(1001); vm.prank(payer); e.close(id);
        vm.prank(payer); vm.expectRevert(StreamEscrow.Inactive.selector); e.close(id);
    }

    function testPayeeCanCloseAndExhaustedRefundZero() public {
        uint256 id = _open();
        vm.warp(5000); vm.prank(payee); e.close(id);
        require(payee.balance == 10 ether && payer.balance == 90 ether, "exhausted");
    }

    function testFuzzConservation(uint32 a, uint32 b) public {
        uint256 id = _open();
        vm.warp(1000 + (a % 20)); vm.prank(payee); e.claim(id);
        vm.warp(1000 + (a % 20) + (b % 20)); vm.prank(payer); e.close(id);
        require(payer.balance + payee.balance == 100 ether, "conserved");
    }
}
