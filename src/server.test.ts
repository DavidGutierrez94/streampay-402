import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { app, DEMO_TOKEN } from "./server";
import entry, { maxDuration } from "./index";
import { runDemoAgent } from "./demo-agent";
import { sleep } from "./defer";

const source = (name: string) => readFileSync(new URL(name, import.meta.url), "utf8");

test("vercel entry is the hono app with a 60s-stream duration", () => {
  expect(maxDuration).toBe(300);
  expect(entry).toBe(app);
  expect(typeof entry.fetch).toBe("function");
});

test("server and demo agent do not use bun-only apis or a child process", () => {
  const server = source("./server.ts");
  const agent = source("./demo-agent.ts");
  expect(server.includes("Bun.")).toBe(false);
  expect(server.includes("localhost")).toBe(false);
  expect(agent.includes("Bun.")).toBe(false);
  expect(agent.includes("localhost")).toBe(false);
  expect(agent.includes("process.env.PAYEE_KEY")).toBe(false);
});

describe.serial("http", () => {
  test("pages, sitemap, and static assets", async () => {
    const home = await app.request("http://localhost/");
    expect(home.status).toBe(200);
    const html = await home.text();
    expect(html.includes("<!--SEO-->")).toBe(false);
    expect(html.includes("og:title")).toBe(true);
    expect(html.includes("http://localhost/")).toBe(true);

    const demo = await app.request("http://localhost/demo");
    expect((await demo.text()).includes("Run agent")).toBe(true);
    const onboard = await app.request("http://localhost/onboard");
    expect(onboard.status).toBe(200);

    const png = await app.request("/og.png");
    expect(png.headers.get("content-type")).toBe("image/png");
    expect((await png.arrayBuffer()).byteLength).toBeGreaterThan(1000);
    const ico = await app.request("/favicon.ico");
    expect(ico.headers.get("content-type")).toBe("image/x-icon");
    const css = await app.request("/theme.css");
    expect(css.headers.get("content-type")).toBe("text/css");
    const js = await app.request("/onboard.js");
    expect(js.headers.get("content-type")).toBe("text/javascript");
    expect((await js.arrayBuffer()).byteLength).toBeGreaterThan(100_000);

    const robots = await app.request("http://localhost/robots.txt");
    expect(await robots.text()).toContain("Disallow: /api/");
    const sitemap = await app.request("http://localhost/sitemap.xml");
    const sitemapXml = await sitemap.text();
    expect(sitemapXml).toContain("/onboard");
    expect(sitemapXml).toContain("/dashboard");
    const dashboard = await app.request("/dashboard");
    expect(dashboard.status).toBe(200);
    expect(await dashboard.text()).toContain("dashboard.js");
    const dashJs = await app.request("/dashboard.js");
    expect(dashJs.headers.get("content-type")).toBe("text/javascript");

    const addr = "0x" + "ab".repeat(20);
    expect((await app.request(`/api/dashboard/${addr}`)).status).toBe(204);
    const put = await app.request(`/api/dashboard/${addr}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ snapshot: { address: addr }, activity: null }),
    });
    expect(put.status).toBe(200);
    const cached = await (await app.request(`/api/dashboard/${addr}`)).json() as { snapshot: { address: string } };
    expect(cached.snapshot.address).toBe(addr);
  });

  test("infer without payment is 402 and the log route is token gated", async () => {
    const unpaid = await app.request("/api/infer");
    expect(unpaid.status).toBe(402);
    const terms = await unpaid.json() as { accepts: { scheme: string }[] };
    expect(terms.accepts[0]?.scheme).toBe("stream-per-second");
    expect(unpaid.headers.get("X-PAYMENT-REQUIRED")).toBeTruthy();

    const denied = await app.request("/api/log", { method: "POST", body: "{}" });
    expect(denied.status).toBe(403);
    const logged = await app.request("/api/log", {
      method: "POST",
      headers: { "content-type": "application/json", "x-demo-token": DEMO_TOKEN },
      body: JSON.stringify({ kind: "plan", msg: "hello", hash: "0x" + "ab".repeat(32) }),
    });
    expect(logged.status).toBe(200);
    const state = await (await app.request("/api/state")).json() as { log: { kind: string; link?: string }[] };
    expect(state.log.some((ev) => ev.kind === "plan" && ev.link?.includes("/tx/0x"))).toBe(true);
  });

  test("drip is disabled without a payer key", async () => {
    const res = await app.request("/api/registry/drip", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ address: "nope" }),
    });
    expect(res.status).toBe(403);
  });

  test("demo agent calls /api/infer in process", async () => {
    const prevKey = process.env.PAYER_KEY;
    const prevEscrow = process.env.ESCROW_ADDRESS;
    const prevPayee = process.env.PAYEE_ADDRESS;
    process.env.PAYER_KEY = "0x" + "11".repeat(32);
    process.env.ESCROW_ADDRESS = "0x0000000000000000000000000000000000000001";
    process.env.PAYEE_ADDRESS = "0x0000000000000000000000000000000000000002";
    let path = "";
    try {
      await expect(runDemoAgent({
        request: async (input) => {
          path = input;
          return new Response("no", { status: 500 });
        },
      }, async () => {})).rejects.toThrow(/expected 402/);
      expect(path).toBe("/api/infer");
    } finally {
      if (prevKey === undefined) delete process.env.PAYER_KEY; else process.env.PAYER_KEY = prevKey;
      if (prevEscrow === undefined) delete process.env.ESCROW_ADDRESS; else process.env.ESCROW_ADDRESS = prevEscrow;
      if (prevPayee === undefined) delete process.env.PAYEE_ADDRESS; else process.env.PAYEE_ADDRESS = prevPayee;
    }
  });

  test("run-agent stays in process and reports a missing payer key", async () => {
    delete process.env.PAYER_KEY;
    const first = await (await app.request("/api/run-agent", { method: "POST" })).json() as { ok: boolean };
    expect(first.ok).toBe(true);
    let sawError = false;
    for (let i = 0; i < 30 && !sawError; i++) {
      const state = await (await app.request("/api/state")).json() as { log: { kind: string; msg: string }[] };
      sawError = state.log.some((ev) => ev.kind === "error" && ev.msg.includes("PAYER_KEY"));
      if (!sawError) await sleep(15);
    }
    expect(sawError).toBe(true);
    const second = await (await app.request("/api/run-agent", { method: "POST" })).json() as { ok: boolean; msg: string };
    expect(second.ok).toBe(false);
    expect(second.msg.includes("cooling down") || second.msg.includes("already running")).toBe(true);
  });
});
