# Security Audit — streampay-402 / StreamEscrow

| | |
|---|---|
| Repo | `~/hack/audit/src` @ `7c35428` (main, clean) |
| Scope | `contracts/src/StreamEscrow.sol`, `contracts/test/StreamEscrow.t.sol`, `src/server.ts`, `src/agent.ts`, `src/chain.ts`, `src/deploy.ts`, `web/index.html` |
| Deployed | Monad testnet (chain 10143), address in `.env` / README |
| Date | 2026-10-13, 20:10 COT |
| Method | Manual line-by-line review. Git history checked for secrets (none found; `.env` was never committed). **Foundry/solc are not installed on the audit machine, so the PoC tests below were written but not executed.** Run them with `forge test -vv` before relying on them. |

## Severity overview

| ID | Sev | Title | Component |
|----|-----|-------|-----------|
| H-1 | **High** | Payee can block `close()` with a reverting/gas-burning receiver, freeze the refund and then take the whole deposit | Contract |
| H-2 | **High** | Stream IDs aren't tied to the requester, so anyone can use someone else's (or one) stream for unlimited parallel sessions | Server |
| H-3 | **High** | Agent trusts the `escrow`, `payTo` and `ratePerSec` that the 402 response sends, so a malicious endpoint can drain the agent wallet | Agent |
| M-1 | Medium | Agent never closes the stream on error paths, so the full deposit drains to the payee | Agent |
| M-2 | Medium | Server keeps serving when the RPC fails (`catch(() => null)` keeps streaming) | Server |
| M-3 | Medium | Unauthenticated `/api/log` plus `innerHTML` gives stored XSS in the dashboard; `/api/run-agent` lets anyone spend the payer wallet | Server/Web |
| M-4 | Medium | Every `/api/infer` call queues a `claim` tx from `PAYEE_KEY`, so anyone can burn the payee hot wallet's gas | Server |
| L-1 | Low | Hot payee key lives in the server env and leaks to the agent child process; `claim` requires the treasury key itself | Server/Contract |
| L-2 | Low | Advertised `minDeposit` isn't enforced; ~1–2 s of service overrun after close or exhaustion | Server |
| L-3 | Low | Timestamp granularity and skew; accrual starts at inclusion, not at service start | Contract/Design |
| L-4 | Low | Unvalidated `BigInt(sid)` returns 500; a global `current` session is shared across clients | Server |
| I-1 | Info | Reentrancy, CEI, overflow and double-claim: verified safe (with reasoning) | Contract |
| I-2 | Info | Events are thin (no closer or recipient; zero-amount `Claimed` spam) | Contract |
| I-3 | Info | Unchecked `uint128(msg.value)` downcast; storage packing; gas | Contract |
| I-4 | Info | Test coverage gaps | Tests |
| I-5 | Info | Front-running analysis: no profitable ordering attack | Contract |

---

## High

### H-1 — Payee-controlled receiver can block `close()`, freeze the refund and take the whole deposit

**Location:** `contracts/src/StreamEscrow.sol:62-80` (`close` → `_send(s.payee, …)` then `_send(s.payer, …)`, with `require(ok)` in `_send`)

**Impact.** `close()` pushes funds to **both** parties in one tx and reverts if either transfer fails. The payee is chosen by the provider (`payTo` in the 402 terms). A contract payee can therefore make every payer-initiated `close()` revert:
- `receive()` reverts (conditionally, e.g. `require(unlocked)`), or
- `receive()` burns all forwarded gas, or returns a huge returndata blob. `(bool ok,) = to.call{value:amt}("")` still copies returndata, and the agent hard-codes `gas: 150000n`.

The payer then can't stop the meter, which breaks the protocol's main promise ("payer can close any time for an instant refund"). Accrual continues until `owed == deposit`. The payee then unlocks its receiver and calls `claim()`, collecting **100% of the deposit** for service it can simply stop delivering. Funds are taken from every payer who opens a stream to that payee.

**Exploit sketch (Foundry PoC, add to `StreamEscrow.t.sol`):**
```solidity
contract EvilPayee {
    bool unlocked;
    function grab(StreamEscrow e, uint256 id) external { unlocked = true; e.claim(id); unlocked = false; }
    receive() external payable { require(unlocked, "no refunds for you"); }
}

function testPayeeBlocksRefundAndTakesAll() public {
    EvilPayee p = new EvilPayee();
    vm.prank(payer); uint256 id = e.open{value: 10 ether}(address(p), 1 ether);
    vm.warp(1002);
    vm.prank(payer);
    try e.close(id) { revert("close should be blocked"); } catch {}   // payer cannot stop the meter
    vm.warp(2000);                                                     // stream runs to exhaustion
    p.grab(e, id);
    require(address(p).balance == 10 ether, "payee took entire deposit");
}
```

**Fix.** Make the payee leg best-effort and gas-capped, without copying returndata. If it fails, the amount stays claimable through `claim()`. The payer refund always goes through. Keep CEI: write `claimed` **before** the external call and roll it back on failure. If `claimed` were written after the call, a payee could reenter `claim()` from `receive()` and get paid twice out of other streams' balances.
```diff
@@
     uint256 public nextId = 1;
     mapping(uint256 => Stream) public streams;
+    uint256 private constant PAYEE_GAS = 30_000; // enough for EOAs / Safe receive(); not enough to grief
@@
     function close(uint256 id) external {
         Stream storage s = streams[id];
         if (msg.sender != s.payer && msg.sender != s.payee) revert NotParty();
         if (s.stoppedAt != 0) revert Inactive();
         uint256 total = owed(id);
         s.stoppedAt = uint64(block.timestamp);
         uint256 toPayee = total - s.claimed;
         uint256 refund = s.deposit - total;
         s.claimed = uint128(total);
-        _send(s.payee, toPayee);
+        // payee leg must never block the payer's refund; on failure it stays claimable via claim()
+        if (!_trySend(s.payee, toPayee, PAYEE_GAS)) {
+            s.claimed -= uint128(toPayee);
+            toPayee = 0;
+        }
         _send(s.payer, refund);
         emit Closed(id, toPayee, refund);
     }
@@
     function _send(address to, uint256 amt) internal {
         if (amt == 0) return;
         (bool ok,) = to.call{value: amt}("");
         require(ok, "send");
     }
+
+    function _trySend(address to, uint256 amt, uint256 g) internal returns (bool ok) {
+        if (amt == 0) return true;
+        assembly { ok := call(g, to, amt, 0, 0, 0, 0) } // no returndata copy -> no returnbomb
+    }
```
The payer leg still uses `_send`. A payer whose own wallet rejects MON only hurts itself, and the payee can still collect with `claim()`. A full pull-payment design (`credit[addr] += …; withdraw()`) is the stronger long-term option. **This fix needs a redeploy.** See "Quick fixes" for whether it fits before the deadline.

---

### H-2 — Stream ID isn't tied to the requester: free-riding and unlimited parallel sessions

**Location:** `src/server.ts:47-60`. The server only checks `active`, `payee == PAYEE` and `rate >= RATE`.

**Impact.** The only proof of payment is `X-PAYMENT-STREAM: <id>`. Stream IDs are sequential (`nextId`) and public (`Opened` events). Anyone can therefore:
1. Read any open stream ID and get the paid service on **someone else's** deposit. Today the victim isn't charged extra (billing is per second, not per connection), but the provider is serving one stream's revenue to many consumers.
2. Open **one** minimal stream and attach N concurrent SSE sessions. Because billing is per stream-second, N sessions cost the same as one, so the provider loses N-1 sessions' worth of revenue. For real LLM inference that's direct cost exposure.

**Exploit sketch:**
```bash
ID=$(cast call $ESCROW "nextId()(uint256)" --rpc-url $RPC_URL); ID=$((ID-1))   # latest stream, anyone's
for i in $(seq 1 200); do curl -sN -H "X-PAYMENT-STREAM: $ID" http://<host>:4020/api/infer >/dev/null & done
```

**Fix.** Require a payer signature over a server-scoped message and allow one session per stream.
```diff
--- src/agent.ts
-const r2 = await fetch(`${SERVER}/api/infer`, { headers: { "X-PAYMENT-STREAM": streamId.toString() } });
+const sig = await w.signMessage({ message: `x402-stream:${terms.escrow}:${streamId}` });
+const r2 = await fetch(`${SERVER}/api/infer`, { headers: { "X-PAYMENT-STREAM": streamId.toString(), "X-PAYMENT-SIG": sig } });
--- src/server.ts
-import { parseEther, formatEther } from "viem";
+import { parseEther, formatEther, verifyMessage } from "viem";
+const sessions = new Set<string>();
@@ app.get("/api/infer"
-  if (!s.active || s.payee.toLowerCase() !== PAYEE.toLowerCase() || s.rate < RATE) {
+  const sig = c.req.header("X-PAYMENT-SIG") as `0x${string}` | undefined;
+  const owner = !!sig && await verifyMessage({ address: s.payer, message: `x402-stream:${ESCROW}:${sid}`, signature: sig }).catch(() => false);
+  if (!owner || sessions.has(sid)) return c.json({ error: "stream not owned by caller or already in use" }, 402);
+  if (!s.active || s.payee.toLowerCase() !== PAYEE.toLowerCase() || s.rate < RATE) {
@@
-  return streamSSE(c, async (st) => {
+  sessions.add(sid);
+  return streamSSE(c, async (st) => { try {
@@
-    if (current?.id === sid) current.stopped = Date.now();
-  });
+    if (current?.id === sid) current.stopped = Date.now();
+  } finally { sessions.delete(sid); } });
```
A captured signature can be replayed, but the one-session lock limits that to a single session. For production, add a server nonce from the 402 response to the signed message.

---

### H-3 — Agent blindly trusts the 402 terms, so a malicious endpoint drains the wallet

**Location:** `src/agent.ts:16-23`

**Impact.** `terms.escrow`, `terms.payTo` and `terms.ratePerSec` come from an unauthenticated HTTP response. The agent then sends `deposit = rate * DEPOSIT_SECONDS` to `terms.escrow` with no allowlist and no spending cap. An x402 agent exists to call third-party endpoints, so a hostile endpoint (or a MITM on plain `http://`) can:
- set `escrow` to its own EOA. `writeContract` to an EOA succeeds and the value is simply transferred. The agent then crashes at `rc.logs.find(...)!` with no refund.
- set `ratePerSec = balance/60`. The agent deposits almost its whole balance into a real escrow paying the attacker's `payTo`. Combined with H-1/M-1, it gets all of it.

**Fix.** Pin the escrow, allowlist the payee and cap the rate and budget.
```diff
--- src/agent.ts
-import { formatEther, getAddress } from "viem";
+import { formatEther, getAddress, parseEther } from "viem";
+const TRUSTED_ESCROW = getAddress(process.env.ESCROW_ADDRESS!);
+const TRUSTED_PAYEES = (process.env.TRUSTED_PAYEES ?? process.env.PAYEE_ADDRESS!).split(",").map((a) => getAddress(a.trim()));
+const MAX_RATE = parseEther(process.env.MAX_RATE_PER_SEC ?? "0.001");
@@
 terms.escrow = getAddress(terms.escrow.toLowerCase()); terms.payTo = getAddress(terms.payTo.toLowerCase());
+if (terms.escrow !== TRUSTED_ESCROW) throw new Error(`untrusted escrow ${terms.escrow}`);
+if (!TRUSTED_PAYEES.includes(terms.payTo)) throw new Error(`untrusted payee ${terms.payTo}`);
 const rate = BigInt(terms.ratePerSec);
+if (rate <= 0n || rate > MAX_RATE) throw new Error(`rate ${rate} above cap ${MAX_RATE}`);
```

---

## Medium

### M-1 — Agent leaves the stream open on any failure after `open()`

**Location:** `src/agent.ts:29-45`

**Impact.** After `open()` succeeds, any exception skips `close()`: a 402 from the server (e.g. a load-balanced public RPC node that hasn't seen the new stream yet, which is realistic on `rpc.ankr.com`), a network error, `reader.read()` throwing, SIGINT, or a crash. The stream then accrues until it hits `DEPOSIT_SECONDS`, and **the full deposit goes to the payee** for little or no service. The fixed `gas: 150000n` on `close` can also OOG against a contract payee (H-1), which has the same effect.

**Fix.**
```diff
-const r2 = await fetch(`${SERVER}/api/infer`, { headers: { "X-PAYMENT-STREAM": streamId.toString() } });
-if (r2.status !== 200) throw new Error("server rejected stream: " + (await r2.text()));
-...
-await reader.cancel().catch(() => {});
-await report("stop", `task done after ${TASK_SECONDS}s / ${tokens} tokens -> stopping mid-budget`);
-
-const closeHash = await w.writeContract({ address: terms.escrow, abi, functionName: "close", args: [streamId], gas: 150000n });
+let tokens = 0, text = "", closeHash: `0x${string}`;
+const closeNow = () => w.writeContract({ address: terms.escrow, abi, functionName: "close", args: [streamId] }); // let viem estimate gas
+process.once("SIGINT", async () => { await closeNow().catch(() => {}); process.exit(130); });
+try {
+  const r2 = await fetch(`${SERVER}/api/infer`, { headers: { "X-PAYMENT-STREAM": streamId.toString() } });
+  if (r2.status !== 200) throw new Error("server rejected stream: " + (await r2.text()));
+  // ... existing read loop unchanged ...
+  await reader.cancel().catch(() => {});
+  await report("stop", `task done after ${TASK_SECONDS}s / ${tokens} tokens -> stopping mid-budget`);
+} finally {
+  closeHash = await closeNow();   // always stop the meter, even on error
+}
```
(Move the `let tokens/text` declarations above the `try`, as shown.) If you want the server to wait for RPC sync instead of failing, also retry the first `/api/infer` 2–3 times with a ~1 s backoff.

### M-2 — Server fails open when the RPC fails

**Location:** `src/server.ts:76-77`. `readStream(id).catch(() => null)`, followed by `if (live && !live.active)`.

**Impact.** When the RPC call fails, `live` is `null`, so the cutoff check is skipped and tokens keep flowing. Errors include rate limits, timeouts and 5xx responses. The default `rpc.ankr.com/monad_testnet` is public and rate-limited, and H-2 lets an attacker open hundreds of sessions, each polling 3 RPC calls/s. That provokes rate-limit errors and turns them into **unmetered service** for every session, including sessions whose stream was already closed. The initial `readStream` (line 54) also has no catch and throws a 500.

**Fix.**
```diff
-    let i = 0, lastCheck = 0;
+    let i = 0, lastCheck = 0, fails = 0;
@@
         const live = await readStream(id).catch(() => null);
+        fails = live ? 0 : fails + 1;
+        if (fails >= 3) { push("cutoff", `stream #${sid} unverifiable (RPC) -> cut off`); await st.writeSSE({ event: "cutoff", data: "unverifiable" }); break; }
         if (live && !live.active) {
```
`readStream` also makes 3 RPC calls where 1 would do. `owed`/`isActive` can be computed locally from the `streams()` tuple, which cuts RPC load by 3x.

### M-3 — Unauthenticated `/api/log` and `/api/run-agent`, plus stored XSS in the dashboard

**Location:** `src/server.ts:91-106`, `web/index.html:18`, `src/server.ts:108` (Bun binds `0.0.0.0` by default)

**Impact.**
- `/api/log` accepts any `{kind,msg,hash}`. `web/index.html` renders `kind`/`msg` with `innerHTML`, and `hash` lands unescaped inside `href="…"`. Anyone who can reach the port can run JS in every dashboard viewer, e.g. judges during the demo: deface the page, show fake tx links to phishing sites, or loop `fetch('/api/run-agent')`.
  `curl -XPOST host:4020/api/log -d '{"kind":"x","msg":"<img src=x onerror=alert(document.domain)>"}' -H content-type:application/json`
- `/api/run-agent` lets any visitor start the agent, which signs with `PAYER_KEY`. The `running` flag serializes runs but doesn't rate-limit them, so an attacker can loop it to drain the payer wallet through gas plus ~12 s of rate per run. It also wipes `log` each time.
- `/api/log` with `kind:"close"` also lets anyone mark the current session stopped on the dashboard (spoofing).

**Fix (minimal).**
```diff
--- web/index.html
-log.innerHTML=s.log.map(e=>`<div><span class="k">${e.kind}</span> ${e.msg} ${e.link?`<a target=_blank href="${e.link}">tx ↗</a>`:''}</div>`).join('');}
+const h=x=>String(x??'').replace(/[&<>"']/g,c=>'&#'+c.charCodeAt(0)+';');
+log.innerHTML=s.log.map(e=>`<div><span class="k">${h(e.kind)}</span> ${h(e.msg)} ${/^https:\/\//.test(e.link||'')?`<a target=_blank rel=noopener href="${h(e.link)}">tx ↗</a>`:''}</div>`).join('');}
--- src/server.ts
 app.post("/api/log", async (c) => {
+  if (c.req.header("x-demo-token") !== process.env.DEMO_TOKEN) return c.json({ ok: false }, 403);
   const b = await c.req.json();
-  push(b.kind, b.msg, b.hash ? txUrl(b.hash) : undefined);
+  const hash = /^0x[0-9a-fA-F]{64}$/.test(b.hash ?? "") ? b.hash : undefined;
+  push(String(b.kind).slice(0, 16), String(b.msg).slice(0, 300), hash && txUrl(hash));
--- src/agent.ts (report)
-  return fetch(`${SERVER}/api/log`, { method: "POST", headers: { "content-type": "application/json" }, body: ...
+  return fetch(`${SERVER}/api/log`, { method: "POST", headers: { "content-type": "application/json", "x-demo-token": process.env.DEMO_TOKEN ?? "" }, body: ...
--- src/server.ts (run-agent)
+let lastRun = 0;
 app.post("/api/run-agent", (c) => {
-  if (running) return c.json({ ok: false, msg: "agent already running" });
+  if (running || Date.now() - lastRun < 30_000) return c.json({ ok: false, msg: "agent busy / cooling down" });
+  lastRun = Date.now();
```
Set `DEMO_TOKEN` to a random value in `.env`. The agent inherits it because it's spawned with `process.env`. Keep the payer wallet funded only with what the demo needs.

### M-4 — Claim-spam drains the payee hot wallet's gas

**Location:** `src/server.ts:62-68`

**Impact.** Every accepted `/api/infer` schedules a `claim` tx signed by `PAYEE_KEY` 5 s later, with no dedupe. Using H-2 (free reuse of any active stream ID), an attacker sends N requests and the server sends N `claim` txs. After the first, they pay ~0 MON but each still costs gas (`gas: 120000n`), and concurrent sends from one key also race on nonce. The attacker spends nothing.

**Fix.**
```diff
+const claimScheduled = new Set<string>();
@@
-  if (process.env.PAYEE_KEY) setTimeout(async () => {
+  if (process.env.PAYEE_KEY && !claimScheduled.has(sid)) { claimScheduled.add(sid); setTimeout(async () => {
@@
-  }, 5000);
+  }, 5000); }
```
For production, claim on a schedule or when `owed - claimed` passes a threshold, not per request.

---

## Low

### L-1 — Payee key handling
- `claim()` requires `msg.sender == s.payee` (`StreamEscrow.sol:54`). The key that receives all earnings must therefore be a hot key in the web server's env (`PAYEE_KEY`), and a server compromise exposes everything the payee has earned.
- `src/server.ts:103` spawns the agent with `{ ...process.env }`, so the payer's process also receives `PAYEE_KEY` (and the server process holds `PAYER_KEY`). The two roles' keys aren't separated.
- `src/deploy.ts` deploys with the payer key. That's fine for a testnet demo; a dedicated deployer is better.

**Fix.** Strip keys from the child env. Optionally make `claim` permissionless (funds always go to `s.payee`), so the server can use a gas-only relayer key and the payee can be a cold address or a Safe:
```diff
--- src/server.ts
-  const p = Bun.spawn(["bun", "src/agent.ts"], { env: { ...process.env, SERVER: `http://localhost:${PORT}` }, ...
+  const { PAYEE_KEY: _drop, ...childEnv } = process.env;
+  const p = Bun.spawn(["bun", "src/agent.ts"], { env: { ...childEnv, SERVER: `http://localhost:${PORT}` }, ...
--- contracts/src/StreamEscrow.sol (optional, needs redeploy)
     function claim(uint256 id) public {
         Stream storage s = streams[id];
-        if (msg.sender != s.payee) revert NotParty();
+        if (s.payee == address(0)) revert Inactive(); // anyone may trigger; funds always go to s.payee
         uint256 amt = owed(id) - s.claimed;
+        if (amt == 0) return;
```

### L-2 — `minDeposit` not enforced; service overrun window
`terms().minDeposit = RATE*10` (`server.ts:26`), but the server accepts any deposit `>= ratePerSec` (1 s, as enforced by the contract). The server polls only every ~1 s plus RPC latency (`server.ts:74`), and service is cut off only at the next poll. A payer can therefore get roughly 1–2 s more than they paid for, repeatedly, by opening 1-second streams or closing right after connecting. The loss per session is bounded but free.
**Fix:** `|| s.deposit < RATE * 10n` in the acceptance check on line 55. Optionally stop streaming once `now >= start + deposit/rate` computed locally, without waiting for the RPC.

### L-3 — Timestamp granularity and skew
`owed()` uses whole seconds of `block.timestamp`. On Monad several blocks share a timestamp and the leader sets it within consensus bounds. Effects:
(a) Open and close in the same second cost 0, which is acceptable because the server polls.
(b) The payer pays from `open` inclusion, not from when service starts, plus the time until `close` is included. That's a few seconds of rate per session, borne by the payer.
(c) A validator who is also a party can skew by at most the allowed drift (seconds).
Impact at `0.001 MON/s` is negligible. Document it. If rates get large, start accrual at the first server-signed "start" or add a short grace period.

### L-4 — Server robustness
- `BigInt(sid)` (`server.ts:53`) throws on non-numeric input, giving a 500 and a stack trace in logs. Validate with `/^\d{1,78}$/` and return 400.
- `current` (`server.ts:15,60`) is a single global, so concurrent sessions overwrite each other and the dashboard shows the wrong stream. It's cosmetic but misleading in a demo with several visitors.

---

## Informational

### I-1 — Verified safe: reentrancy, CEI, overflow, rounding, double claim, access control
- **Reentrancy/CEI.** `claim` writes `s.claimed += amt` before `_send`, so reentering `claim` pays 0. `close` writes `stoppedAt` and `claimed = total` before either send: reentering `close` reverts `Inactive`, and reentering `claim` during the payee callback pays `total - total = 0`. No cross-function path reads stale state. A `nonReentrant` guard isn't required, though it costs little as defense in depth (and would make the H-1 fix more robust to future edits).
- **Overflow.** `uint256(rate ≤ 2^128-1) * (end - start < 2^64)` is less than 2^192, so it can't overflow. `end >= start` always holds, since `stoppedAt` and `block.timestamp` are both ≥ `start`.
- **Underflow.** `owed ≤ deposit`, so `remaining()` is safe. `claimed` is only ever set to a past `owed()` value and `owed()` is monotonic (frozen after close), so `owed - claimed ≥ 0` in `claim` and `close`.
- **Rounding.** Accrual is integer `rate * seconds`, capped at `deposit`. When `deposit % rate != 0`, the payee gets the remainder in the final second. No dust is ever locked: `toPayee + refund + claimed_before == deposit` in every path.
- **Double claim or double close.** Impossible (see above). `close` is one-shot via `stoppedAt != 0`. `block.timestamp` is never 0, so `stoppedAt == 0` is a sound "open" sentinel.
- **Access control.** `close` is limited to the payer or payee, and `claim` to the payee. Unknown IDs revert `NotParty` (payee/payer are `address(0)`). There's no owner, admin, upgradeability or `selfdestruct`, so there's no admin rug vector.
- **Native transfers.** `.call{value:}` is used rather than `transfer` (good). Failure handling is what goes wrong, in H-1.

### I-2 — Events
- `Closed(id, paidToPayee, refunded)` doesn't record **who** closed. Add `address indexed by`.
- `Claimed` doesn't index the recipient, and it is emitted with `amount == 0` on no-op claims, including any claim after close. Return early when `amt == 0`.
- The agent parses `Closed` by byte offset from the first escrow log (`agent.ts:46-47`). Use `parseEventLogs({ abi, logs, eventName: "Closed" })` so it doesn't break silently if events change.

### I-3 — Types, gas, storage
- `uint128(msg.value)` (`:31`) is an unchecked downcast. It's unreachable in practice, but `if (msg.value > type(uint128).max) revert BadParams();` makes it explicit.
- `Stream` uses 4 slots. `owed()` loads the whole struct into memory, and `isActive()` loads it twice. Reading only the needed fields saves ~4–6k gas per call.
- There's no top-up or extend function, and no cap on the number of streams per payee. The cap doesn't matter since lookups are by ID.
- `open` allows `payee == msg.sender`. That's harmless but pointless.

### I-4 — Test gaps (`contracts/test/StreamEscrow.t.sol`)
Missing tests: a reverting or gas-burning payee or payer (H-1); reentrant payee during `claim` and during `close`; double `claim`; `claim` after `close`; `close` by the payee; `close` after exhaustion (refund 0); a second `close` reverting `Inactive`; `deposit % rate != 0`; a fuzz invariant `payee.balance + payer.balance == initial` across random warps, claims and closes; `open` param validation.

### I-5 — Front-running and ordering
- If the payee claims ahead of the payer's `close`, totals are unchanged: `close` pays `total - claimed`.
- The payer can't close ahead of a payee claim to dodge payment, because `close` pays accrued time first.
- Front-running `open` gains nothing. Stream IDs differ, but the agent reads its ID from its own receipt (good).
- The only ordering-sensitive surface is off-chain (H-2): the stream ID is a bearer token.

---

## Summary

The contract is small and its accounting is correct. CEI holds, there's no overflow or underflow, double claims are impossible, and value is conserved on every path. Its one real flaw is **H-1**: `close()` pushes to both parties atomically, so a contract payee can veto the refund and take the whole deposit. That breaks the main user guarantee ("close any time, instant refund"). The fix is about 10 lines and keeps the same happy-path behavior and events, but it needs a redeploy.

Most of the remaining risk is **off-chain**. The server treats a public, sequential stream ID as a bearer token (**H-2**), keeps serving when the RPC fails (**M-2**), and exposes unauthenticated control and logging endpoints feeding an `innerHTML` dashboard (**M-3**, **M-4**). The agent trusts whatever escrow, payee and rate the endpoint sends (**H-3**), and it leaks its deposit to the payee on any error after `open` (**M-1**). None of these let a third party steal funds already sitting in the deployed escrow. They do let a malicious provider drain agents, let clients get unpaid service, and let anyone deface the demo or burn its wallets.

## Quick fixes safe before 22:15 COT tonight

All of these are off-chain only. **No redeploy, and the README/SUBMISSION tx links stay valid.** Listed in priority order with rough effort. After applying them, re-run one end-to-end `bun src/agent.ts` to confirm the demo still works.

1. **XSS escape in `web/index.html`** (M-3), ~3 min. Add the `h()` escaper and the `https://` link check. Zero behavior change.
2. **Fail closed on RPC errors** (M-2), ~3 min. Add the `fails >= 3` cutoff in the SSE loop. Wrap the initial `readStream` in `.catch` and return 503.
3. **Agent `try/finally` close + SIGINT handler** (M-1), ~10 min. Drop the fixed `gas: 150000n` on `close`.
4. **Agent allowlist + rate cap** (H-3), ~5 min. `ESCROW_ADDRESS`/`PAYEE_ADDRESS` are already in `.env`.
5. **Dedupe mid-stream claim per stream ID** (M-4), ~2 min.
6. **One active session per stream ID** (part of H-2), ~5 min. Use a `sessions` Set with `delete` in `finally`.
7. **Payer signature on `X-PAYMENT-STREAM`** (rest of H-2), ~15 min. Uses viem `signMessage`/`verifyMessage`. Low risk, but it touches both server and agent, so do it after 1–6 and re-test.
8. **`/api/log` token + `/api/run-agent` cooldown** (M-3), ~5 min. Remember to set `DEMO_TOKEN` in `.env`.
9. **Strip `PAYEE_KEY` from the spawned agent env** (L-1), ~1 min.
10. **Enforce `minDeposit` and validate `sid`** (L-2, L-4), ~2 min.

**Not recommended tonight unless ≥45 min remain:** the H-1 contract fix. It needs the new tests, `forge test`, a redeploy, a fresh e2e run and updated tx links in README/SUBMISSION. If you skip it, add one line to the README: *"Known issue: `close()` pushes to both parties; a contract payee that rejects MON can block refunds. A pull/try-send fix is designed (see AUDIT.md H-1)."* Disclosing it beats having a judge find it.
