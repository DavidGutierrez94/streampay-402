// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;
import {StreamEscrowV3} from "../src/StreamEscrowV3.sol";

interface Vm { function warp(uint256) external; function prank(address) external; function deal(address,uint256) external; function expectRevert(bytes4) external; }

contract V3EvilPayee {
    receive() external payable { revert("no"); }
}

contract StreamEscrowV3Test {
    Vm constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));
    StreamEscrowV3 e;
    address payer = address(0xA11CE);
    address payer2 = address(0xA11C2);
    address payee = address(0xB0B);
    bytes32 keyHash = keccak256("pk_test_1");

    function setUp() public {
        e = new StreamEscrowV3();
        vm.deal(payer, 100 ether);
        vm.deal(payer2, 100 ether);
        vm.warp(1000);
    }

    function _policy() internal {
        vm.prank(payer);
        e.setAgentPolicy(10 ether, 1 ether, 10);
    }

    function testNoPolicyMatchesV2Close() public {
        vm.prank(payer);
        uint256 id = e.open{value: 10 ether}(payee, 1 ether);
        vm.warp(1004);
        vm.prank(payer);
        e.close(id);
        require(payee.balance == 4 ether, "payee");
        require(payer.balance == 96 ether, "refund");
        require(e.agentSpent(payer) == 0 && e.agentReserved(payer) == 0, "uncapped");
    }

    function testRateCap() public {
        _policy();
        vm.prank(payer);
        vm.expectRevert(StreamEscrowV3.RateCap.selector);
        e.open{value: 4 ether}(payee, 2 ether);
    }

    function testDurationCap() public {
        _policy();
        vm.prank(payer);
        vm.expectRevert(StreamEscrowV3.DurationCap.selector);
        e.open{value: 11 ether}(payee, 1 ether);
    }

    function testSpendCapBlocksSecondStreamUntilCloseReleasesRefund() public {
        _policy();
        vm.prank(payer);
        uint256 id = e.open{value: 10 ether}(payee, 1 ether);
        require(e.agentReserved(payer) == 10 ether, "reserved");
        vm.prank(payer);
        vm.expectRevert(StreamEscrowV3.SpendCap.selector);
        e.open{value: 1 ether}(payee, 1 ether);

        vm.warp(1004);
        vm.prank(payer);
        e.close(id);
        require(e.agentSpent(payer) == 4 ether, "spent actual");
        require(e.agentReserved(payer) == 0, "released");
        require(payer.balance == 96 ether, "refund");

        vm.prank(payer);
        uint256 id2 = e.open{value: 6 ether}(payee, 1 ether);
        require(id2 != 0, "fits remaining budget");
        vm.prank(payer);
        vm.expectRevert(StreamEscrowV3.SpendCap.selector);
        e.open{value: 1 ether}(payee, 1 ether);
    }

    function testImmediateCloseRestoresFullBudget() public {
        _policy();
        vm.prank(payer);
        uint256 id = e.open{value: 10 ether}(payee, 1 ether);
        vm.prank(payer);
        e.close(id);
        require(e.agentSpent(payer) == 0, "nothing owed");
        vm.prank(payer);
        e.open{value: 10 ether}(payee, 1 ether);
    }

    function testClaimThenCloseCountsOwedOnce() public {
        _policy();
        vm.prank(payer);
        uint256 id = e.open{value: 10 ether}(payee, 1 ether);
        vm.warp(1002);
        vm.prank(payee);
        e.claim(id);
        vm.warp(1005);
        vm.prank(payer);
        e.close(id);
        require(e.agentSpent(payer) == 5 ether, "once");
        require(payee.balance == 5 ether, "payee");
    }

    function testOtherPayerIsNotCapped() public {
        _policy();
        vm.prank(payer2);
        e.open{value: 10 ether}(payee, 1 ether);
    }

    function testKeyPolicyOnOpenWithKeyOnly() public {
        vm.prank(payee);
        e.registerKey(keyHash);
        vm.prank(payee);
        e.setKeyPolicy(keyHash, 5 ether, 1 ether, 20);
        vm.prank(payer);
        e.open{value: 10 ether}(payee, 1 ether);
        vm.prank(payer);
        vm.expectRevert(StreamEscrowV3.SpendCap.selector);
        e.openWithKey{value: 6 ether}(payee, 1 ether, keyHash);
        vm.prank(payer);
        uint256 id = e.openWithKey{value: 5 ether}(payee, 1 ether, keyHash);
        vm.warp(1002);
        vm.prank(payer);
        e.close(id);
        require(e.keySpent(keyHash) == 2 ether, "key spent");
        require(e.keyReserved(keyHash) == 0, "key released");
    }

    function testStrangerCannotSetKeyPolicy() public {
        vm.prank(payee);
        e.registerKey(keyHash);
        vm.prank(payer);
        vm.expectRevert(StreamEscrowV3.NotKeyAdmin.selector);
        e.setKeyPolicy(keyHash, 1 ether, 1 ether, 1);
    }

    function testOpenWithKeyRequiresPolicy() public {
        vm.prank(payer);
        vm.expectRevert(StreamEscrowV3.BadParams.selector);
        e.openWithKey{value: 1 ether}(payee, 1 ether, keyHash);
    }

    function testRegisterKeyOnce() public {
        vm.prank(payee);
        e.registerKey(keyHash);
        vm.prank(payer);
        vm.expectRevert(StreamEscrowV3.BadParams.selector);
        e.registerKey(keyHash);
    }

    function testRevertingPayeeStillRefundsAndSettles() public {
        _policy();
        V3EvilPayee p = new V3EvilPayee();
        vm.prank(payer);
        uint256 id = e.open{value: 10 ether}(address(p), 1 ether);
        vm.warp(1003);
        vm.prank(payer);
        e.close(id);
        require(payer.balance == 97 ether, "refund");
        require(e.credit(address(p)) == 3 ether, "credited");
        require(e.agentSpent(payer) == 3 ether, "settled");
        require(address(e).balance == 3 ether, "conserved");
    }

    function testDoubleCloseDoesNotDoubleSpend() public {
        _policy();
        vm.prank(payer);
        uint256 id = e.open{value: 10 ether}(payee, 1 ether);
        vm.warp(1004);
        vm.prank(payer);
        e.close(id);
        vm.prank(payer);
        vm.expectRevert(StreamEscrowV3.Inactive.selector);
        e.close(id);
        require(e.agentSpent(payer) == 4 ether, "once");
    }
}
