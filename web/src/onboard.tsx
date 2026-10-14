// Onboarding: Privy email login -> embedded wallet -> onchain ServiceRegistry sign-up -> Stripe-style keys.
// Falls back to an injected wallet (window.ethereum) when PRIVY_APP_ID is not configured.
import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { PrivyProvider, usePrivy, useWallets } from "@privy-io/react-auth";
import { createWalletClient, createPublicClient, custom, http, parseEther, keccak256, toBytes, decodeEventLog, formatEther } from "viem";
import { monadTestnet } from "viem/chains";

type Cfg = { registry: `0x${string}`; registryUrl: string; escrow: string; chainId: number; privyAppId: string | null; abi: any };
const EXPL = "https://testnet.monadscan.com";
const pub = createPublicClient({ chain: monadTestnet, transport: http() });
const newSk = () => "sk_test_" + Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) => b.toString(16).padStart(2, "0")).join("");

function Flow({ cfg, provider, address, onLogout, label }: { cfg: Cfg; provider: any; address?: `0x${string}`; onLogout?: () => void; label: string }) {
  const [log, setLog] = useState<{ m: string; tx?: string }[]>([]);
  const [busy, setBusy] = useState(false);
  const [keys, setKeys] = useState<{ pk: string; sk: string } | null>(null);
  const [bal, setBal] = useState<string>("…");
  const [name, setName] = useState("my-gpu-session");
  const [rate, setRate] = useState("0.001");
  const add = (m: string, tx?: string) => setLog((l) => [...l, { m, tx }]);
  const refresh = async () => address && setBal(formatEther(await pub.getBalance({ address })));
  useEffect(() => { refresh(); }, [address]);

  const wc = () => createWalletClient({ account: address!, chain: monadTestnet, transport: custom(provider) });
  const tx = async (functionName: string, args: any[]) => {
    const h = await wc().writeContract({ address: cfg.registry, abi: cfg.abi, functionName, args, gas: 300000n });
    add(`${functionName} sent`, h);
    const r = await pub.waitForTransactionReceipt({ hash: h });
    if (r.status !== "success") throw new Error(functionName + " reverted");
    return r;
  };
  const run = (f: () => Promise<void>) => async () => { setBusy(true); try { await f(); } catch (e: any) { add("error: " + (e.shortMessage ?? e.message)); } setBusy(false); refresh(); };

  const drip = run(async () => {
    const r = await fetch("/api/registry/drip", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ address }) }).then((r) => r.json());
    r.tx ? add("testnet gas drip received", r.tx) : add(r.error ?? "drip failed");
  });
  const regService = run(async () => {
    const sk = newSk();
    const r = await tx("registerService", [name, parseEther(rate), address, keccak256(toBytes(sk))]);
    const ev: any = r.logs.map((l) => { try { return decodeEventLog({ abi: cfg.abi, ...l }); } catch { return null; } }).find((e: any) => e?.eventName === "ServiceRegistered");
    setKeys({ pk: `pk_test_${ev.args.serviceId}`, sk });
    add(`service #${ev.args.serviceId} registered onchain`);
  });
  const regAgent = run(async () => { await tx("registerAgent", [name.replace(/-session$/, "") + "-agent"]); add("agent identity registered onchain"); });

  return (
    <div className="card">
      <p className="muted">{label}: <a href={`${EXPL}/address/${address}`} target="_blank">{address}</a> · {bal} MON {onLogout && <button className="link" onClick={onLogout}>log out</button>}</p>
      <label>Service name <input value={name} onChange={(e) => setName(e.target.value)} /></label>
      <label>Price (MON / second) <input value={rate} onChange={(e) => setRate(e.target.value)} /></label>
      <div className="row">
        <button disabled={busy} onClick={drip}>1. Get testnet gas</button>
        <button disabled={busy} onClick={regService}>2. Register service + get API keys</button>
        <button disabled={busy} onClick={regAgent}>3. Register agent identity</button>
      </div>
      {keys && (
        <div className="keys">
          <b>Your API keys</b> — the secret is shown once; only its keccak256 hash is onchain.
          {(["pk", "sk"] as const).map((k) => (
            <div key={k} className="key"><code>{keys[k]}</code><button onClick={() => navigator.clipboard.writeText(keys[k])}>copy</button></div>
          ))}
          <pre>{`# agents discover your per-second terms\ncurl $HOST/api/registry/terms/${keys.pk}\n# you authenticate as the provider\ncurl -H "Authorization: Bearer sk_test_…" -H "X-Publishable-Key: ${keys.pk}" $HOST/api/registry/me`}</pre>
        </div>
      )}
      <ul>{log.map((l, i) => <li key={i}>{l.m} {l.tx && <a href={`${EXPL}/tx/${l.tx}`} target="_blank">tx ↗</a>}</li>)}</ul>
    </div>
  );
}

function PrivyFlow({ cfg }: { cfg: Cfg }) {
  const { ready, authenticated, login, logout } = usePrivy();
  const { wallets } = useWallets();
  const w = wallets.find((x) => x.walletClientType === "privy") ?? wallets[0];
  const [prov, setProv] = useState<any>(null);
  useEffect(() => { (async () => { if (w) { await w.switchChain(monadTestnet.id).catch(() => {}); setProv(await w.getEthereumProvider()); } })(); }, [w?.address]);
  if (!ready) return <p>loading Privy…</p>;
  if (!authenticated) return <button onClick={login}>Sign up with email (Privy)</button>;
  if (!w || !prov) return <p>creating your embedded wallet…</p>;
  return <Flow cfg={cfg} provider={prov} address={w.address as `0x${string}`} onLogout={logout} label="Privy embedded wallet" />;
}

function InjectedFlow({ cfg }: { cfg: Cfg }) {
  const [addr, setAddr] = useState<`0x${string}`>();
  const eth = (window as any).ethereum;
  if (!eth) return <p>Privy is not configured (PRIVY_APP_ID) and no browser wallet was found.</p>;
  const connect = async () => {
    const [a] = await eth.request({ method: "eth_requestAccounts" });
    await eth.request({ method: "wallet_switchEthereumChain", params: [{ chainId: "0x279f" }] }).catch(() =>
      eth.request({ method: "wallet_addEthereumChain", params: [{ chainId: "0x279f", chainName: "Monad Testnet", nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 }, rpcUrls: ["https://testnet-rpc.monad.xyz"], blockExplorerUrls: [EXPL] }] }));
    setAddr(a);
  };
  return addr ? <Flow cfg={cfg} provider={eth} address={addr} label="Browser wallet" /> : <button onClick={connect}>Connect wallet</button>;
}

function App() {
  const [cfg, setCfg] = useState<Cfg | null>(null);
  useEffect(() => { fetch("/api/registry/config").then((r) => r.json()).then(setCfg); }, []);
  if (!cfg) return <p>loading…</p>;
  const head = <p className="muted">ServiceRegistry <a href={cfg.registryUrl} target="_blank">{cfg.registry}</a> on Monad testnet</p>;
  if (!cfg.privyAppId) return <>{head}<InjectedFlow cfg={cfg} /></>;
  return (
    <PrivyProvider appId={cfg.privyAppId} config={{
      loginMethods: ["email"], defaultChain: monadTestnet, supportedChains: [monadTestnet],
      embeddedWallets: { ethereum: { createOnLogin: "users-without-wallets" } }, appearance: { theme: "dark" },
    }}>{head}<PrivyFlow cfg={cfg} /></PrivyProvider>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
