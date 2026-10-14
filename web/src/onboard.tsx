// Onboarding: Privy email login -> embedded wallet -> onchain ServiceRegistry sign-up -> Stripe-style keys.
// Falls back to an injected wallet (window.ethereum) when PRIVY_APP_ID is not configured.
import React, { useEffect, useRef, useState } from "react";

const Spinner = () => <span className="spinner" aria-hidden="true" />;
function Status({ text, tx }: { text: string | null; tx?: string | null }) {
  if (!text) return null;
  return <p className="status" role="status" aria-live="polite">{text !== "Done" && <Spinner />}{text}{tx && <> · <a href={`https://testnet.monadscan.com/tx/${tx}`} target="_blank">view tx ↗</a></>}</p>;
}
import { createRoot } from "react-dom/client";
import { PrivyProvider, usePrivy, useWallets, useCreateWallet } from "@privy-io/react-auth";
import { createWalletClient, createPublicClient, custom, http, parseEther, keccak256, toBytes, decodeEventLog, formatEther } from "viem";
import { monadTestnet } from "viem/chains";

type Cfg = { registry: `0x${string}`; registryUrl: string; escrow: string; chainId: number; privyAppId: string | null; abi: any };
const EXPL = "https://testnet.monadscan.com";
const pub = createPublicClient({ chain: monadTestnet, transport: http() });
const newSk = () => "sk_test_" + Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) => b.toString(16).padStart(2, "0")).join("");

function Flow({ cfg, provider, address, onLogout, label }: { cfg: Cfg; provider: any; address?: `0x${string}`; onLogout?: () => void; label: string }) {
  const [log, setLog] = useState<{ m: string; tx?: string }[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const lock = useRef(false);
  const [stage, setStage] = useState<string | null>(null);
  const [curTx, setCurTx] = useState<string | null>(null);
  const [keys, setKeys] = useState<{ pk: string; sk: string } | null>(null);
  const [bal, setBal] = useState<string>("…");
  const [name, setName] = useState("my-gpu-session");
  const [rate, setRate] = useState("0.001");
  const add = (m: string, tx?: string) => setLog((l) => [...l, { m, tx }]);
  const [err, setErr] = useState<string | null>(null);
  const refresh = async () => address && setBal(formatEther(await pub.getBalance({ address })));
  useEffect(() => { refresh(); }, [address]);

  const wc = () => createWalletClient({ account: address!, chain: monadTestnet, transport: custom(provider) });
  const tx = async (functionName: string, args: any[]) => {
    setStage("Confirm in wallet…");
    const h = await wc().writeContract({ address: cfg.registry, abi: cfg.abi, functionName, args, gas: 300000n });
    add(`${functionName} sent`, h); setCurTx(h); setStage("Waiting for Monad confirmation…");
    const r = await pub.waitForTransactionReceipt({ hash: h });
    if (r.status !== "success") throw new Error(functionName + " reverted");
    return r;
  };
  const run = (id: string, f: () => Promise<void>) => async () => {
    if (lock.current) return; lock.current = true;
    setBusy(id); setErr(null); setCurTx(null); setStage(id === "drip" ? "Getting gas…" : "Confirm in wallet…");
    try { await f(); setStage("Done"); } catch (e: any) { const m = e.shortMessage ?? e.message; setErr(m); add("error: " + m); setStage(null); }
    lock.current = false; setBusy(null); refresh();
  };

  const drip = run("drip", async () => {
    const r = await fetch("/api/registry/drip", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ address }) }).then((r) => r.json());
    if (r.tx) { add("testnet gas drip received", r.tx); setCurTx(r.tx); setStage("Waiting for Monad confirmation…"); await pub.waitForTransactionReceipt({ hash: r.tx }).catch(() => {}); } else throw new Error(r.error ?? "drip failed");
  });
  const regService = run("svc", async () => {
    const sk = newSk();
    const r = await tx("registerService", [name, parseEther(rate), address, keccak256(toBytes(sk))]);
    const ev: any = r.logs.map((l) => { try { return decodeEventLog({ abi: cfg.abi, ...l }); } catch { return null; } }).find((e: any) => e?.eventName === "ServiceRegistered");
    if (!ev) throw new Error("registered, but no ServiceRegistered event found in the receipt");
    setKeys({ pk: `pk_test_${ev.args.serviceId}`, sk });
    add(`service #${ev.args.serviceId} registered onchain`);
  });
  const regAgent = run("agent", async () => { await tx("registerAgent", [name.replace(/-session$/, "") + "-agent"]); add("agent identity registered onchain"); });

  return (
    <div className="card">
      <p className="muted">{label}: <a href={`${EXPL}/address/${address}`} target="_blank">{address}</a> · {bal} MON {onLogout && <button className="link" onClick={onLogout}>log out</button>}</p>
      <p className="step"><b>Step 3 of 3</b> · Register your service onchain to get your API keys.{bal === "0" && " You need testnet gas first (button 1)."}</p>
      <label>Service name <input value={name} onChange={(e) => setName(e.target.value)} /></label>
      <label>Price (MON / second) <input value={rate} onChange={(e) => setRate(e.target.value)} /></label>
      <div className="row">
        <button disabled={!!busy} aria-busy={busy === "drip"} onClick={drip}>{busy === "drip" && <Spinner />}1. Get testnet gas</button>
        <button disabled={!!busy} aria-busy={busy === "svc"} onClick={regService}>{busy === "svc" && <Spinner />}{busy === "svc" ? "Registering service…" : "2. Register service + get API keys"}</button>
        <button disabled={!!busy} aria-busy={busy === "agent"} onClick={regAgent}>{busy === "agent" && <Spinner />}3. Register agent identity (optional)</button>
      </div>
      <Status text={stage} tx={curTx} />
      {err && <p className="err" role="alert">{err}</p>}
      {keys && (
        <div className="keys">
          <b>Your API keys</b> — the secret is shown once; only its keccak256 hash is onchain.
          {(["pk", "sk"] as const).map((k) => (
            <div key={k} className="key"><code>{keys[k]}</code><button onClick={() => navigator.clipboard.writeText(keys[k])}>copy</button></div>
          ))}
          <pre>{`# agents discover your per-second terms\ncurl $HOST/api/registry/terms/${keys.pk}\n# you authenticate as the provider\ncurl -H "Authorization: Bearer sk_test_…" -H "X-Publishable-Key: ${keys.pk}" $HOST/api/registry/me`}</pre>
          <div className="next"><a className="btn" href="/dashboard">Open your dashboard →</a><a className="btn ghost" href="/demo">Try it live →</a><a className="btn ghost" href="https://github.com/DavidGutierrez94/streampay-402#readme" target="_blank">Read the docs</a></div>
        </div>
      )}
      <ul>{log.map((l, i) => <li key={i}>{l.m} {l.tx && <a href={`${EXPL}/tx/${l.tx}`} target="_blank">tx ↗</a>}</li>)}</ul>
    </div>
  );
}

function PrivyFlow({ cfg }: { cfg: Cfg }) {
  const { ready, authenticated, login, logout, user } = usePrivy();
  const { wallets, ready: wReady } = useWallets();
  const { createWallet } = useCreateWallet();
  const w = wallets.find((x) => x.walletClientType === "privy") ?? wallets[0];
  const [prov, setProv] = useState<any>(null);
  const [err, setErr] = useState<string | null>(null);
  const [slow, setSlow] = useState(false);
  const [creating, setCreating] = useState(false);
  useEffect(() => { (async () => { if (!w) return; setErr(null); try { await w.switchChain(monadTestnet.id).catch(() => {}); setProv(await w.getEthereumProvider()); } catch (e: any) { setErr("Could not open your wallet: " + (e?.message ?? e)); } })(); }, [w?.address]);
  useEffect(() => { setSlow(false); if (authenticated && !prov) { const t = setTimeout(() => setSlow(true), 6000); return () => clearTimeout(t); } }, [authenticated, prov]);
  const mk = async () => { if (creating) return; setCreating(true); setErr(null); try { await createWallet(); } catch (e: any) { setErr("Wallet creation failed: " + (e?.message ?? e) + ". Check that embedded wallets are enabled in the auth provider dashboard."); } setCreating(false); };
  const doLogin = () => { setErr(null); try { login(); } catch (e: any) { setErr("Login failed: " + (e?.message ?? e)); } };
  if (!ready) return <p className="status">Loading sign-in…</p>;
  if (!authenticated) return <><p className="step"><b>Step 1 of 3</b> · Sign up or log in with your email. We create a wallet for you.</p><button onClick={doLogin}>Continue with email</button>{err && <p className="err" role="alert">{err}</p>}</>;
  if (!w || !prov) return (<>
    <p className="step"><b>Step 2 of 3</b> · Signed in{user?.email?.address ? ` as ${user.email.address}` : ""}. {wReady && !w ? "You don't have a wallet yet." : "Setting up your embedded wallet…"}</p>
    {(slow || (wReady && !w)) && <button disabled={creating} onClick={mk}>{creating && <Spinner />}{creating ? "Creating wallet…" : "Create my wallet"}</button>}
    <Status text={creating ? "Creating your wallet…" : null} />
    {err && <p className="err" role="alert">{err}</p>}
    <button className="link" onClick={logout}>Log out and start over</button>
  </>);
  return <Flow cfg={cfg} provider={prov} address={w.address as `0x${string}`} onLogout={logout} label="Email wallet" />;
}

function InjectedFlow({ cfg }: { cfg: Cfg }) {
  const [addr, setAddr] = useState<`0x${string}`>();
  const eth = (window as any).ethereum;
  if (!eth) return <><p className="err" role="alert">Email sign-up isn't configured on this server and no browser wallet was found.</p><a className="btn" href="/demo">See the live demo instead →</a></>;
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
  const [cerr, setCerr] = useState<string | null>(null);
  useEffect(() => { fetch("/api/registry/config").then((r) => r.json()).then(setCfg).catch((e) => setCerr(String(e))); }, []);
  if (cerr) return <p className="err" role="alert">Couldn't load the registry config: {cerr}. <a href="/onboard">Retry</a></p>;
  if (!cfg) return <p className="status">Loading…</p>;
  const head = <p className="muted">ServiceRegistry <a href={cfg.registryUrl} target="_blank">{cfg.registry}</a> on Monad testnet</p>;
  if (!cfg.privyAppId) return <>{head}<InjectedFlow cfg={cfg} /></>;
  return (
    <PrivyProvider appId={cfg.privyAppId} config={{
      loginMethods: ["email"], defaultChain: monadTestnet, supportedChains: [monadTestnet],
      embeddedWallets: { ethereum: { createOnLogin: "users-without-wallets" } }, appearance: { theme: "light", accentColor: "#e8461e" },
    }}>{head}<PrivyFlow cfg={cfg} /></PrivyProvider>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
