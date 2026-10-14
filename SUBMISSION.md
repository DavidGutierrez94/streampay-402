# streampay-402 — submission (Consumer Products & Payments)

## Description (150 words)
streampay-402 lets AI agents pay by the second for time-based services: GPU and inference sessions, voice minutes, browser sessions, live data feeds. x402 solved pay-per-request; time-billed services still force agents into prepaid credits that strand balances or monthly plans that overcharge. streampay-402 is a thin x402 add-on, not a new protocol. An agent calls a paid endpoint and receives HTTP 402 with `stream-per-second` terms. It opens a capped escrow on Monad, and the provider streams the service while verifying the balance on-chain every second. When funds run out, service stops automatically. When the agent finishes early, it closes the stream: the provider receives rate × elapsed and the agent's unused deposit is refunded in the same transaction. Accounting comes straight from block timestamps, with no per-tick signatures or off-chain vouchers. Monad's fast, cheap blocks make opening and closing a session cost less than a few seconds of service, so per-second billing becomes practical for consumers and agents.

## On-chain proof (Monad testnet, chainId 10143)
- StreamEscrow: [`0xda46725e9559d87963349570da491a8f08547d27`](https://testnet.monadscan.com/address/0xda46725e9559d87963349570da491a8f08547d27)
- Deploy tx: [0xf3ed2bff…04ed](https://testnet.monadscan.com/tx/0xf3ed2bff1f3f142747130df4396636b1a9a1fa989b05e162ffb482511b3b04ed)

### Live end-to-end run (stream #1, 0.001 MON/s, 0.06 MON budget, agent stopped after 12 s)
| Step | Tx |
| --- | --- |
| Agent opens stream (0.06 MON deposit) | [0x5593ee4a…3b67](https://testnet.monadscan.com/tx/0x5593ee4a428fa3cd6f77c1878f369c793a35b5e0c8d44ec28cb4b90931aa3b67) |
| Provider claims accrued earnings mid-stream | [0x5c7352ef…48da](https://testnet.monadscan.com/tx/0x5c7352ef7a2a321c41cc03c2913dca8e0001779209a07250e95f14964f8448da) |
| Agent closes: 0.007 MON more to provider, 0.047 MON refunded in the same tx | [0x4837b24b…bb45](https://testnet.monadscan.com/tx/0x4837b24be1069f0ac47828ce22f89d4bcb90a9f139574504683133173bbabb45) |

## 3-minute technical demo
1. **0:00–0:20 — Problem.** Dashboard on screen. "x402 lets agents pay per request. But GPU, voice and inference are billed by time. Today that means prepaid credits or subscriptions."
2. **0:20–0:45 — Contract.** Show `StreamEscrow.sol`: `open(payee, rate)` payable, `owed = min(deposit, rate × elapsed)`, `close()` pays provider and refunds payer atomically. Show `forge test` passing (5 tests).
3. **0:45–1:10 — 402 handshake.** `curl -i localhost:4020/api/infer` → `402 Payment Required` + `X-PAYMENT-REQUIRED` header (x402-style `accepts[]`, scheme `stream-per-second`, escrow, payTo, ratePerSec).
4. **1:10–1:40 — Agent opens stream.** Click **Run agent**. Log: plan → `open` tx. Click the tx link → Monad testnet explorer shows deposit to escrow.
5. **1:40–2:15 — Metered service.** Tokens stream; cost counter ticks at 0.001 MON/s; server re-checks `isActive` on-chain every second.
6. **2:15–2:40 — Stop + refund.** Agent finishes early, calls `close`. Log shows paid vs refunded; click the close tx on explorer: two internal transfers in one tx.
7. **2:40–3:00 — Cutoff + Monad.** Re-run with a tiny budget: server logs "balance exhausted → service cut off". "Monad's fast blocks make open → use → close feel instant. Same scheme drops into any x402 server."

## 2-minute pitch
- **(0:00) Hook.** "Your agent rents a GPU for 47 seconds. Why does it pay for an hour, or prepay credits it never gets back?"
- **(0:20) Problem.** The agent economy is moving to x402 for per-request payments. But the most expensive things agents buy — inference, GPU, voice, browser sessions — are billed by time. Credits strand money; subscriptions overcharge; neither works for an autonomous agent with a budget.
- **(0:45) Solution.** streampay-402: one new x402 scheme, `stream-per-second`. Same 402 handshake. The agent opens a capped escrow, uses the service, and stops whenever it wants. The provider is paid exactly rate × seconds; the rest comes back in the same transaction.
- **(1:10) Why Monad.** Per-second billing only works if opening and closing a session is cheaper and faster than a few seconds of service. Monad's fast blocks and low fees make that true.
- **(1:30) Market + next.** Providers of inference, voice and GPU get pay-as-you-go without card rails or chargebacks; agents get hard budget caps. Next: ERC-20 stablecoins (USDC), an x402 facilitator plugin, and LatAm pay-per-call services.
- **(1:50) Close.** "x402 lets agents pay. streampay-402 lets them pay while they use."
