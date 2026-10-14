import { useEffect, useRef, useState, type ReactNode } from "react";
import type { Address, Hex } from "viem";
import {
  EXPLORER,
  formatMon,
  shortId,
  streamStatus,
  owedAt,
  type Activity,
  type PayoutKind,
  type ProviderSnapshot,
  type ServiceRow,
  type StreamRow,
} from "./provider-data.ts";

export function DashboardView({
  label,
  snapshot,
  activity,
  activityError,
  refreshing,
  onLogout,
  onRefresh,
  registry,
  escrow,
}: {
  label: string;
  snapshot: ProviderSnapshot;
  activity: Activity | null;
  activityError: string | null;
  refreshing: boolean;
  onLogout?: () => void;
  onRefresh: () => void;
  registry: Address;
  escrow: Address;
}) {
  const anchor = useRef({ block: snapshot.blockNumber, at: Date.now(), time: snapshot.blockTime });
  if (anchor.current.block !== snapshot.blockNumber) {
    anchor.current = { block: snapshot.blockNumber, at: Date.now(), time: snapshot.blockTime };
  }
  const [tick, setTick] = useState(0);
  const open = snapshot.streams.some((s) => s.stoppedAt === 0n);
  useEffect(() => {
    if (!open) return;
    const id = window.setInterval(() => setTick((n) => n + 1), 1000);
    return () => window.clearInterval(id);
  }, [open]);
  void tick;
  const now = snapshot.blockTime + BigInt(Math.max(0, Math.floor((Date.now() - anchor.current.at) / 1000)));

  const byRecent = (a: StreamRow, b: StreamRow) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);
  const active = snapshot.streams.filter((s) => streamStatus(s, now) !== "closed").sort(byRecent);
  const closed = snapshot.streams.filter((s) => streamStatus(s, now) === "closed").sort(byRecent);
  const live = active.filter((s) => streamStatus(s, now) === "active").length;
  const exhausted = active.length - live;
  const claimed = snapshot.streams.reduce((sum, s) => sum + s.claimed, 0n);
  const accruing = active.reduce((sum, s) => {
    const owed = owedAt(s, now);
    return sum + (owed > s.claimed ? owed - s.claimed : 0n);
  }, 0n);

  return (
    <div className="dash">
      <div className="wallet">
        <p>
          <span className="who">{label}</span>{" "}
          <a className="mono" href={`${EXPLORER}/address/${snapshot.address}`} target="_blank" rel="noopener noreferrer">
            {snapshot.address}
          </a>
          <span className="bal mono">· {formatMon(snapshot.balance, 4)} MON</span>
        </p>
        <p className="wallet-actions">
          <button type="button" className="link" onClick={onRefresh} disabled={refreshing} aria-busy={refreshing}>
            {refreshing ? "Refreshing…" : "Refresh"}
          </button>
          {onLogout && (
            <button type="button" className="link" onClick={onLogout}>
              Log out
            </button>
          )}
        </p>
      </div>
      <p className="asof">
        Read at block <span className="mono">{snapshot.blockNumber.toString()}</span>
        {" · "}
        {formatWhen(snapshot.blockTime)}
      </p>

      <dl className="stats" aria-live="polite">
        <Stat k="Services" v={String(snapshot.services.length)} />
        <Stat k="Active streams" v={String(live)} />
        <Stat k="Closed streams" v={String(closed.length)} />
        <Stat k="Claimed earnings" v={formatMon(claimed)} unit="MON" hot />
        <Stat k="Still accruing" v={formatMon(accruing)} unit="MON" />
        <Stat k="Available to withdraw" v={formatMon(snapshot.credit)} unit="MON" />
      </dl>

      <Section
        title="Services"
        meta={String(snapshot.services.length)}
        lead="Registered to this wallet in the service registry."
      >
        {snapshot.services.length === 0 ? (
          <Empty
            title="No services yet"
            body="Register a service and it will show up here, priced per second."
            href="/onboard"
            action="Register a service"
          />
        ) : (
          <ul className="rows services">
            {snapshot.services.map((s) => (
              <ServiceItem key={s.id.toString()} service={s} wallet={snapshot.address} />
            ))}
          </ul>
        )}
      </Section>

      <Section
        title="Active streams"
        meta={exhausted > 0 ? `${live} accruing · ${exhausted} exhausted` : String(live)}
        lead="Streams paying this wallet that have not been closed. Accrued updates every second from the onchain rate."
      >
        {active.length === 0 ? (
          <Empty title="No active streams" body="When someone opens a stream to this wallet, it shows up here until it is closed." />
        ) : (
          <StreamList rows={active} now={now} activity={activity} mode="open" />
        )}
      </Section>

      <Section
        title="Closed streams"
        meta={String(closed.length)}
        lead="Closed streams have paid the accrued amount and refunded the rest of the deposit."
      >
        {closed.length === 0 ? (
          <Empty title="No closed streams" body="After a stream is closed, the payout and the refund land here." />
        ) : (
          <StreamList rows={closed} now={now} activity={activity} mode="closed" />
        )}
      </Section>

      <Section
        title="Payouts"
        meta={activity ? String(activity.payouts.length) : "…"}
        lead="Claims, close payouts, amounts held as credit, and withdrawals."
      >
        <PayoutList snapshot={snapshot} activity={activity} activityError={activityError} claimed={claimed} />
      </Section>

      <p className="contracts">
        Registry{" "}
        <a className="mono" href={`${EXPLORER}/address/${registry}`} target="_blank" rel="noopener noreferrer">
          {shortId(registry)}
        </a>
        {" · "}
        Escrow{" "}
        <a className="mono" href={`${EXPLORER}/address/${escrow}`} target="_blank" rel="noopener noreferrer">
          {shortId(escrow)}
        </a>
        {" · "}Monad testnet
      </p>
    </div>
  );
}

function Stat({ k, v, unit, hot }: { k: string; v: string; unit?: string; hot?: boolean }) {
  return (
    <div className={hot ? "hot" : undefined}>
      <dt>{k}</dt>
      <dd>
        {v}
        {unit && <small>{unit}</small>}
      </dd>
    </div>
  );
}

function Section({ title, meta, lead, children }: { title: string; meta: string; lead: string; children: ReactNode }) {
  return (
    <section className="sheet">
      <h2>
        {title}
        <span>{meta}</span>
      </h2>
      <p className="lead">{lead}</p>
      {children}
    </section>
  );
}

function Empty({ title, body, href, action }: { title: string; body: string; href?: string; action?: string }) {
  return (
    <p className="empty">
      <b>{title}</b>
      {body}
      {href && action && (
        <a className="btn sm" href={href}>
          {action}
        </a>
      )}
    </p>
  );
}

function ServiceItem({ service, wallet }: { service: ServiceRow; wallet: Address }) {
  const ownPayee = service.payee.toLowerCase() === wallet.toLowerCase();
  return (
    <li>
      <div className="top">
        <strong>{service.name}</strong>
        <span className={service.active ? "st on" : "st"}>{service.active ? "Active" : "Inactive"}</span>
      </div>
      <div className="meta">
        <span>
          <i>Key</i>
          <b className="mono">pk_test_{service.id.toString()}</b>
        </span>
        <span>
          <i>Rate</i>
          <b className="mono">{formatMon(service.ratePerSec)} MON/s</b>
        </span>
        <span>
          <i>Payee</i>
          {ownPayee ? (
            <b>This wallet</b>
          ) : (
            <b>
              <a className="mono" href={`${EXPLORER}/address/${service.payee}`} target="_blank" rel="noopener noreferrer">
                {shortId(service.payee)}
              </a>
            </b>
          )}
        </span>
      </div>
    </li>
  );
}

function StreamList({
  rows,
  now,
  activity,
  mode,
}: {
  rows: StreamRow[];
  now: bigint;
  activity: Activity | null;
  mode: "open" | "closed";
}) {
  return (
    <ul className="rows streams">
        <li className="head">
        <span>Stream</span>
        <span>Payer</span>
        <span>Rate</span>
        <span>Deposit</span>
        <span>{mode === "open" ? "Accrued" : "Paid"}</span>
        <span>{mode === "open" ? "Claimed" : "Refund"}</span>
        <span>{mode === "open" ? "Opened" : "Closed"}</span>
      </li>
      {rows.map((s) => {
        const status = streamStatus(s, now);
        const owed = owedAt(s, status === "closed" ? s.stoppedAt : now);
        const refund = s.deposit > owed ? s.deposit - owed : 0n;
        const id = s.id.toString();
        const openTx = activity?.openTx[id];
        const closeTx = activity?.closeTx[id];
        return (
          <li key={id}>
            <span className="cell id">
              <i className="k">Stream</i>
              <StreamId id={id} tx={openTx ?? null} />
              {mode === "open" && <em className={status === "active" ? "st on" : "st"}>{statusLabel(status)}</em>}
            </span>
            <span className="cell">
              <i className="k">Payer</i>
              <a className="mono" href={`${EXPLORER}/address/${s.payer}`} target="_blank" rel="noopener noreferrer">
                {shortId(s.payer)}
              </a>
            </span>
            <span className="cell">
              <i className="k">Rate</i>
              <b className="mono">{formatMon(s.ratePerSec)}</b>
            </span>
            <span className="cell">
              <i className="k">Deposit</i>
              <b className="mono">{formatMon(s.deposit)}</b>
            </span>
            <span className="cell">
              <i className="k">{mode === "open" ? "Accrued" : "Paid"}</i>
              <b className="mono">{formatMon(mode === "open" ? owed : s.claimed)}</b>
            </span>
            <span className="cell">
              <i className="k">{mode === "open" ? "Claimed" : "Refund"}</i>
              <b className="mono">{formatMon(mode === "open" ? s.claimed : refund)}</b>
            </span>
            <span className="cell">
              <i className="k">{mode === "open" ? "Opened" : "Closed"}</i>
              <b>{formatWhen(mode === "open" ? s.start : s.stoppedAt)}</b>
              {mode === "closed" && closeTx && (
                <a href={`${EXPLORER}/tx/${closeTx}`} target="_blank" rel="noopener noreferrer">
                  tx ↗
                </a>
              )}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

function StreamId({ id, tx }: { id: string; tx: Hex | null }) {
  const label = `#${id}`;
  if (!tx) return <b className="mono">{label}</b>;
  return (
    <a className="mono" href={`${EXPLORER}/tx/${tx}`} target="_blank" rel="noopener noreferrer">
      {label}
    </a>
  );
}

function statusLabel(status: "active" | "exhausted" | "closed"): string {
  switch (status) {
    case "active":
      return "Active";
    case "exhausted":
      return "Exhausted";
    case "closed":
      return "Closed";
    default: {
      const _never: never = status;
      return _never;
    }
  }
}

function PayoutList({
  snapshot,
  activity,
  activityError,
  claimed,
}: {
  snapshot: ProviderSnapshot;
  activity: Activity | null;
  activityError: string | null;
  claimed: bigint;
}) {
  if (activityError) return <p className="err" role="alert">{activityError}</p>;
  if (!activity) {
    return snapshot.streams.length === 0 ? (
      <Empty title="No payouts yet" body="Claims and close payouts appear here after a stream pays this wallet." />
    ) : (
      <p className="status" role="status">
        <span className="spinner" aria-hidden="true" />
        Reading claim and payout transactions…
      </p>
    );
  }
  return (
    <>
      {snapshot.credit > 0n && (
        <p className="note">
          Escrow is holding <b className="mono">{formatMon(snapshot.credit)} MON</b> that could not be sent on close. That balance can be withdrawn by the payee.
        </p>
      )}
      {activity.truncated && (
        <p className="note">Showing the latest payout transactions. Claimed earnings above still include the full amount recorded on each stream ({formatMon(claimed)} MON).</p>
      )}
      {activity.payouts.length === 0 ? (
        <Empty title="No payouts yet" body="Claims and close payouts appear here after a stream pays this wallet." />
      ) : (
        <ul className="rows payouts">
          <li className="head">
            <span>When</span>
            <span>Type</span>
            <span>Stream</span>
            <span>Amount</span>
            <span>Transaction</span>
          </li>
          {activity.payouts.map((p, i) => (
            <li key={`${p.tx ?? "state"}-${p.kind}-${p.streamId?.toString() ?? "x"}-${i}`}>
              <span className="cell">
                <i className="k">When</i>
                <b>{p.time === 0n ? "—" : formatWhen(p.time)}</b>
              </span>
              <span className="cell">
                <i className="k">Type</i>
                <b className={p.kind === "claim" || p.kind === "close" ? "st on" : "st"}>{payoutLabel(p.kind)}</b>
              </span>
              <span className="cell">
                <i className="k">Stream</i>
                <b className="mono">{p.streamId === null ? "—" : `#${p.streamId.toString()}`}</b>
              </span>
              <span className="cell">
                <i className="k">Amount</i>
                <b className="mono">{formatMon(p.amount)} MON</b>
              </span>
              <span className="cell">
                <i className="k">Transaction</i>
                {p.tx ? (
                  <a href={`${EXPLORER}/tx/${p.tx}`} target="_blank" rel="noopener noreferrer">
                    {shortId(p.tx)} ↗
                  </a>
                ) : (
                  <b>—</b>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

function payoutLabel(kind: PayoutKind): string {
  switch (kind) {
    case "claim":
      return "Claim";
    case "close":
      return "Close payout";
    case "credit":
      return "Held as credit";
    case "withdraw":
      return "Withdrawn";
    default: {
      const _never: never = kind;
      return _never;
    }
  }
}

function formatWhen(ts: bigint): string {
  if (ts === 0n) return "—";
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(Number(ts) * 1000));
}
