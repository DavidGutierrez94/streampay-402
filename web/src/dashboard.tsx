// Provider dashboard: email sign-in, then onchain services, streams, and payouts for that wallet.
import { Component, useEffect, useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { PrivyProvider, useCreateWallet, usePrivy, useWallets } from "@privy-io/react-auth";
import { BaseError, getAddress, isAddress, type Address } from "viem";
import { monadTestnet } from "viem/chains";
import { DashboardView } from "./dashboard-view.tsx";
import {
  DEFAULT_ESCROW,
  DEFAULT_REGISTRY,
  asAddress,
  loadActivity,
  loadProvider,
  makeClient,
  readDashboardCache,
  writeDashboardCache,
  payeeSet,
  type Activity,
  type ProviderSnapshot,
} from "./provider-data.ts";

const EXPL = "https://testnet.monadscan.com";

type Cfg = {
  registry: string;
  escrow?: string | null;
  chainId: number;
  privyAppId: string | null;
  rpc?: string | null;
};

function message(e: unknown): string {
  if (e instanceof BaseError) return e.shortMessage;
  if (e instanceof Error) return e.message;
  return "Could not read the chain";
}

function SignedIn({
  cfg,
  address,
  label,
  onLogout,
}: {
  cfg: Cfg;
  address: Address;
  label: string;
  onLogout?: () => void;
}) {
  const registry = asAddress(cfg.registry, DEFAULT_REGISTRY);
  const escrow = asAddress(cfg.escrow, DEFAULT_ESCROW);
  const client = makeClient(cfg.chainId, cfg.rpc);
  const [snap, setSnap] = useState<ProviderSnapshot | null>(null);
  const [activity, setActivity] = useState<Activity | null>(null);
  const [shownFor, setShownFor] = useState(address);
  if (shownFor !== address) {
    setShownFor(address);
    setSnap(null);
    setActivity(null);
  }
  const [err, setErr] = useState<string | null>(null);
  const [activityErr, setActivityErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [gen, setGen] = useState(0);

  useEffect(() => {
    let cancel = false;
    setLoading(true);
    setErr(null);
    setActivityErr(null);
    const emptyActivity = (): Activity => ({ payouts: [], openTx: {}, closeTx: {}, truncated: false });
    const show = (next: ProviderSnapshot, rows: Activity) => {
      if (cancel) return;
      setSnap(next);
      setActivity(rows);
      setLoading(false);
    };
    const loadChain = () =>
      loadProvider(client, address, { registry, escrow })
        .then((next) => {
          if (cancel) return;
          setSnap(next);
          setActivity(null);
          setLoading(false);
          if (next.streams.length === 0) {
            const rows = emptyActivity();
            setActivity(rows);
            void writeDashboardCache(address, next, rows);
            return;
          }
          loadActivity(client, escrow, next.streams, payeeSet(next))
            .then((rows) => {
              if (cancel) return;
              setActivity(rows);
              void writeDashboardCache(address, next, rows);
            })
            .catch((e: unknown) => {
              if (!cancel) setActivityErr(message(e));
            });
        })
        .catch((e: unknown) => {
          if (cancel) return;
          setErr(message(e));
          setLoading(false);
        });
    if (gen === 0) {
      readDashboardCache(address)
        .then((cached) => {
          if (cancel) return;
          if (cached) show(cached.snapshot, cached.activity);
          else void loadChain();
        })
        .catch(() => {
          if (!cancel) void loadChain();
        });
    } else {
      void loadChain();
    }
    return () => {
      cancel = true;
    };
  }, [address, registry, escrow, cfg.chainId, cfg.rpc, gen]);

  if (!snap && loading) {
    return (
      <p className="status" role="status">
        <span className="spinner" aria-hidden="true" />
        Reading services and streams for this wallet…
      </p>
    );
  }
  if (!snap) {
    return (
      <p className="err" role="alert">
        {err ?? "Could not read the chain."}{" "}
        <button type="button" className="link" onClick={() => setGen((n) => n + 1)}>
          Retry
        </button>
      </p>
    );
  }
  return (
    <>
      {err && (
        <p className="err" role="alert">
          {err}
        </p>
      )}
      <DashboardView
        label={label}
        snapshot={snap}
        activity={activity}
        activityError={activityErr}
        refreshing={loading}
        onLogout={onLogout}
        onRefresh={() => setGen((n) => n + 1)}
        registry={registry}
        escrow={escrow}
      />
    </>
  );
}

function PrivyFlow({ cfg }: { cfg: Cfg }) {
  const { ready, authenticated, login, logout, user } = usePrivy();
  const { wallets, ready: walletsReady } = useWallets();
  const { createWallet } = useCreateWallet();
  const wallet = wallets.find((item) => item.walletClientType === "privy") ?? wallets[0];
  const [err, setErr] = useState<string | null>(null);
  const [slow, setSlow] = useState(false);
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    if (!wallet) return;
    wallet.switchChain(monadTestnet.id).catch(() => {});
  }, [wallet?.address]);

  useEffect(() => {
    setSlow(false);
    if (authenticated && !wallet) {
      const t = window.setTimeout(() => setSlow(true), 6000);
      return () => window.clearTimeout(t);
    }
  }, [authenticated, wallet]);

  const create = async () => {
    if (creating) return;
    setCreating(true);
    setErr(null);
    try {
      await createWallet();
    } catch (e: unknown) {
      setErr(`${message(e)} Embedded wallets may be disabled for this app.`);
    }
    setCreating(false);
  };

  if (!ready) {
    return (
      <p className="status" role="status">
        <span className="spinner" aria-hidden="true" />
        Loading sign-in…
      </p>
    );
  }
  if (!authenticated) {
    return (
      <div className="gate">
        <p className="step">
          <b>Sign in</b> · Use the email you registered with. The dashboard only loads that wallet.
        </p>
        <button type="button" onClick={() => login()}>
          Continue with email
        </button>
        {err && (
          <p className="err" role="alert">
            {err}
          </p>
        )}
      </div>
    );
  }
  if (!wallet || !isAddress(wallet.address)) {
    return (
      <div className="gate">
        <p className="step">
          <b>Wallet</b> · Signed in{user?.email?.address ? ` as ${user.email.address}` : ""}.{" "}
          {walletsReady && !wallet ? "This account has no wallet yet." : "Opening your wallet…"}
        </p>
        {(slow || (walletsReady && !wallet)) && (
          <button type="button" disabled={creating} onClick={create}>
            {creating && <span className="spinner" aria-hidden="true" />}
            {creating ? "Creating wallet…" : "Create my wallet"}
          </button>
        )}
        {err && (
          <p className="err" role="alert">
            {err}
          </p>
        )}
        <button type="button" className="link" onClick={logout}>
          Log out
        </button>
      </div>
    );
  }
  return <SignedIn cfg={cfg} address={getAddress(wallet.address)} label="Email wallet" onLogout={logout} />;
}

class SignInBoundary extends Component<{ children: ReactNode; fallback: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }
  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

function InjectedFlow({ cfg, emailFailed }: { cfg: Cfg; emailFailed?: boolean }) {
  const [address, setAddress] = useState<Address | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const eth = (window as Window & { ethereum?: { request: (args: { method: string; params?: unknown[] }) => Promise<unknown> } }).ethereum;
  if (!eth) {
    return (
      <div className="gate">
        <p className="err" role="alert">
          {emailFailed
            ? "Email sign-in failed to load, and no browser wallet was found."
            : "Email sign-in isn't configured on this server, and no browser wallet was found."}
        </p>
        <a className="btn" href="/onboard">
          Register a service
        </a>
      </div>
    );
  }
  const connect = async () => {
    setErr(null);
    try {
      const accounts = (await eth.request({ method: "eth_requestAccounts" })) as string[];
      const first = accounts[0];
      if (!first || !isAddress(first)) throw new Error("No account returned");
      await eth.request({ method: "wallet_switchEthereumChain", params: [{ chainId: "0x279f" }] }).catch(() =>
        eth.request({
          method: "wallet_addEthereumChain",
          params: [
            {
              chainId: "0x279f",
              chainName: "Monad Testnet",
              nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 },
              rpcUrls: ["https://rpc-testnet.monadinfra.com"],
              blockExplorerUrls: [EXPL],
            },
          ],
        }),
      );
      setAddress(getAddress(first));
    } catch (e: unknown) {
      setErr(message(e));
    }
  };
  if (!address) {
    return (
      <div className="gate">
        <p className="step">
          <b>Sign in</b> · Connect the wallet that registered your services.
        </p>
        <button type="button" onClick={connect}>
          Connect wallet
        </button>
        {err && (
          <p className="err" role="alert">
            {err}
          </p>
        )}
      </div>
    );
  }
  return <SignedIn cfg={cfg} address={address} label="Browser wallet" />;
}

function App() {
  const [cfg, setCfg] = useState<Cfg | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    fetch("/api/registry/config")
      .then((r) => r.json())
      .then(setCfg)
      .catch((e: unknown) => setErr(message(e)));
  }, []);
  if (err) {
    return (
      <p className="err" role="alert">
        Couldn't load dashboard config: {err}. <a href="/dashboard">Retry</a>
      </p>
    );
  }
  if (!cfg) {
    return (
      <p className="status" role="status">
        <span className="spinner" aria-hidden="true" />
        Loading…
      </p>
    );
  }
  if (!cfg.privyAppId) return <InjectedFlow cfg={cfg} />;
  return (
    <SignInBoundary fallback={<InjectedFlow cfg={cfg} emailFailed />}>
      <PrivyProvider
        appId={cfg.privyAppId}
        config={{
          loginMethods: ["email"],
          defaultChain: monadTestnet,
          supportedChains: [monadTestnet],
          embeddedWallets: { ethereum: { createOnLogin: "users-without-wallets" } },
          appearance: { theme: "light", accentColor: "#e8461e" },
        }}
      >
        <PrivyFlow cfg={cfg} />
      </PrivyProvider>
    </SignInBoundary>
  );
}

const root = document.getElementById("root");
if (root) createRoot(root).render(<App />);
