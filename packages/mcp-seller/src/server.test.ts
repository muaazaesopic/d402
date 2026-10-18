import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Hono } from "hono";
import { z } from "zod";
import { createD402, type D402Server } from "@d402/server";
import { HEADERS, generateKeypair, newNonce, signSpend, signSubmit, type Bundle } from "@d402/spec";
import { createD402McpServer, decodeClaims, HOW, type D402McpServerOptions } from "./server.js";
import { createStreamableHttpApp } from "./http.js";

// ---------- fixtures ----------

const LABELS = ["a", "b", "c", "d"];
const clock = { t: 1_800_000_000 };
const truth: Record<string, string> = { g1: "a", g2: "b", g3: "c", g4: "d" };

let live: D402Server[] = [];
afterEach(() => {
  for (const d of live) d.close();
  live = [];
  clock.t = 1_800_000_000;
});

function seller(extra: Record<string, unknown> = {}): D402Server {
  const d = createD402({
    sellerId: "mcp-seller-test",
    taskUrl: "http://seller.test/.well-known/d402/tasks",
    scope: ["/search", "/mcp/search"],
    secret: "s",
    labels: LABELS,
    tiers: [{ id: "s", items: 2, est_tokens: 100, reward: { calls: 2 } }],
    now: () => clock.t,
    ...extra,
  });
  d.tasks.load([
    { id: "g1", type: "classify", text: "x", golden: "a" },
    { id: "g2", type: "classify", text: "y", golden: "b" },
    { id: "g3", type: "classify", text: "z", golden: "c" },
    { id: "g4", type: "classify", text: "w", golden: "d" },
  ]);
  live.push(d);
  return d;
}

function answersFor(bundle: Pick<Bundle, "items">, wrong = false): Record<string, string> {
  const out: Record<string, string> = {};
  for (const it of bundle.items) out[it.id] = wrong ? (truth[it.id] === "a" ? "b" : "a") : truth[it.id]!;
  return out;
}

interface CallResult {
  isError: boolean;
  structured: Record<string, any>;
  text: string;
}

async function harness(d402: D402Server, opts: Partial<D402McpServerOptions> = {}) {
  const mcp = createD402McpServer({ d402, now: () => clock.t, ...opts });
  mcp.gated(
    "search",
    { title: "Search", description: "demo search", inputSchema: { q: z.string().min(1) }, annotations: { readOnlyHint: true } },
    async (args) => ({ content: [{ type: "text", text: `hits for ${args.q}` }], structuredContent: { q: args.q, args, hits: [args.q] } }),
  );
  mcp.gated("elsewhere", { inputSchema: {}, scope: "/other" }, async () => ({ content: [{ type: "text", text: "never" }] }));
  const client = new Client({ name: "test-client", version: "0.0.0" });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await mcp.server.connect(st);
  await client.connect(ct);
  const call = async (name: string, args: Record<string, unknown> = {}): Promise<CallResult> => {
    const res = await client.callTool({ name, arguments: args });
    const text = (res.content as { type: string; text: string }[])
      .filter((c) => c.type === "text")
      .map((c) => c.text)
      .join("\n");
    return { isError: res.isError === true, structured: (res.structuredContent ?? {}) as Record<string, any>, text };
  };
  const earn = async (): Promise<string> => {
    const b = await call("d402_get_bundle");
    expect(b.isError).toBe(false);
    const r = await call("d402_submit", { bundleId: b.structured.bundleId, answers: answersFor(b.structured as Bundle) });
    expect(r.isError).toBe(false);
    return r.structured.voucher as string;
  };
  const close = async () => {
    await client.close();
    await mcp.server.close();
  };
  return { mcp, client, call, earn, close };
}

// ---------- tests ----------

describe("tool listing", () => {
  it("lists the four d402 tools plus the gated tools, with the voucher args added", async () => {
    const h = await harness(seller());
    const { tools } = await h.client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(["d402_get_bundle", "d402_offer", "d402_status", "d402_submit", "elsewhere", "search"]);
    const search = tools.find((t) => t.name === "search")!;
    const props = Object.keys(search.inputSchema.properties ?? {}).sort();
    expect(props).toEqual(["d402_key", "d402_nonce", "d402_sig", "d402_timestamp", "d402_voucher", "q"]);
    expect(search.inputSchema.required).toEqual(["q"]);
    expect(search.description).toContain("demo search");
    expect(search.description).toContain("/mcp/search");
    for (const t of tools) expect(t.description).toBeTruthy();
    await h.close();
  });
});

describe("d402_offer", () => {
  it("returns the offer with the hint and a how line", async () => {
    const d = seller();
    const h = await harness(d);
    const r = await h.call("d402_offer");
    expect(r.isError).toBe(false);
    expect(r.structured.d402).toBe("1");
    expect(r.structured.accepts[0].scheme).toBe("d402");
    expect(r.structured.accepts[0].hint).toContain("No wallet needed");
    expect(r.structured.accepts[0].scope).toEqual(["/search", "/mcp/search"]);
    expect(r.structured.how).toBe(HOW);
    const { how, ...offer } = r.structured;
    expect(offer).toEqual(d.offer());
    await h.close();
  });
});

describe("session mode", () => {
  it("d402_get_bundle without a key returns a bundle issued to a session keypair", async () => {
    const h = await harness(seller());
    const r = await h.call("d402_get_bundle");
    expect(r.isError).toBe(false);
    expect(r.structured.bundleId).toMatch(/^b_/);
    expect(r.structured.items).toHaveLength(2);
    expect(r.structured.labels).toEqual(LABELS);
    expect(r.structured.mode).toBe("session");
    expect(r.structured.hint).toContain("d402_submit");
    const st = await h.call("d402_status");
    expect(st.structured.publicKey).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(st.structured.pendingBundles).toEqual([r.structured.bundleId]);
    await h.close();
  });

  it("d402_submit with correct answers returns a voucher whose subject is the session key", async () => {
    const h = await harness(seller());
    const b = await h.call("d402_get_bundle");
    const r = await h.call("d402_submit", { bundleId: b.structured.bundleId, answers: answersFor(b.structured as Bundle) });
    expect(r.isError).toBe(false);
    expect(r.structured.calls).toBe(2);
    expect(r.structured.scope).toEqual(["/search", "/mcp/search"]);
    expect(r.structured.expiresAt).toBe(clock.t + 86_400);
    const claims = decodeClaims(r.structured.voucher)!;
    const st = await h.call("d402_status");
    expect(claims.sub).toBe(st.structured.publicKey);
    expect(st.structured.pendingBundles).toEqual([]);
    await h.close();
  });

  it("quality failure is isError with code quality and drops the bundle from the session", async () => {
    const h = await harness(seller());
    const b = await h.call("d402_get_bundle");
    const r = await h.call("d402_submit", { bundleId: b.structured.bundleId, answers: answersFor(b.structured as Bundle, true) });
    expect(r.isError).toBe(true);
    expect(r.structured.code).toBe("quality");
    expect(r.structured.status).toBe(422);
    const again = await h.call("d402_submit", { bundleId: b.structured.bundleId, answers: answersFor(b.structured as Bundle) });
    expect(again.isError).toBe(true);
    expect(again.structured.code).toBe("unknown_bundle");
    await h.close();
  });

  it("a bundle issued to another session cannot be submitted in session mode", async () => {
    const d = seller();
    const a = await harness(d);
    const b = await harness(d);
    const bundle = await a.call("d402_get_bundle");
    const r = await b.call("d402_submit", { bundleId: bundle.structured.bundleId, answers: answersFor(bundle.structured as Bundle) });
    expect(r.isError).toBe(true);
    expect(r.structured.code).toBe("unknown_bundle");
    // The issuing session can still submit it.
    const ok = await a.call("d402_submit", { bundleId: bundle.structured.bundleId, answers: answersFor(bundle.structured as Bundle) });
    expect(ok.isError).toBe(false);
    await a.close();
    await b.close();
  });

  it("with sessionKeys: false every earning tool requires a key", async () => {
    const h = await harness(seller(), { sessionKeys: false });
    const r = await h.call("d402_get_bundle");
    expect(r.isError).toBe(true);
    expect(r.structured.code).toBe("missing_key");
    const s = await h.call("d402_submit", { bundleId: "b_x", answers: {} });
    expect(s.structured.code).toBe("missing_key");
    const st = await h.call("d402_status");
    expect(st.structured.mode).toBe("key");
    expect(st.structured.publicKey).toBeUndefined();
    await h.close();
  });
});

describe("key mode", () => {
  it("the agent earns under its own key by signing the submission", async () => {
    const h = await harness(seller());
    const kp = generateKeypair();
    const b = await h.call("d402_get_bundle", { key: kp.publicKey, model: "claude" });
    expect(b.isError).toBe(false);
    expect(b.structured.mode).toBe("key");
    const answers = answersFor(b.structured as Bundle);
    const r = await h.call("d402_submit", {
      bundleId: b.structured.bundleId,
      answers,
      key: kp.publicKey,
      sig: signSubmit(kp.privateKey, b.structured.bundleId, answers),
    });
    expect(r.isError).toBe(false);
    expect(decodeClaims(r.structured.voucher)!.sub).toBe(kp.publicKey);
    const spend = await h.call("search", { q: "rates", d402_voucher: r.structured.voucher });
    expect(spend.isError).toBe(false);
    expect(spend.structured.d402_calls_remaining).toBe(1);
    await h.close();
  });

  it("a wrong signature is bad_signature; a missing one is bad_request", async () => {
    const h = await harness(seller());
    const kp = generateKeypair();
    const other = generateKeypair();
    const b = await h.call("d402_get_bundle", { key: kp.publicKey });
    const answers = answersFor(b.structured as Bundle);
    const bad = await h.call("d402_submit", {
      bundleId: b.structured.bundleId,
      answers,
      key: kp.publicKey,
      sig: signSubmit(other.privateKey, b.structured.bundleId, answers),
    });
    expect(bad.isError).toBe(true);
    expect(bad.structured.code).toBe("bad_signature");
    expect(bad.structured.status).toBe(401);
    const none = await h.call("d402_submit", { bundleId: b.structured.bundleId, answers, key: kp.publicKey });
    expect(none.isError).toBe(true);
    expect(none.structured.code).toBe("bad_request");
    await h.close();
  });

  it("bad key, bad tier and rate limits surface the route's error codes", async () => {
    const h = await harness(seller({ maxOpenBundlesPerKey: 1 }));
    expect((await h.call("d402_get_bundle", { key: "nope" })).structured.code).toBe("bad_key");
    expect((await h.call("d402_get_bundle", { tier: "xl" })).structured.code).toBe("bad_tier");
    const first = await h.call("d402_get_bundle");
    expect(first.isError).toBe(false);
    const second = await h.call("d402_get_bundle");
    expect(second.isError).toBe(true);
    expect(second.structured.code).toBe("rate_limited");
    expect(second.structured.status).toBe(429);
    expect(second.structured.retryAfter).toBeGreaterThan(0);
    await h.close();
  });
});

describe("gated tools", () => {
  it("without a voucher returns the offer as payment required, not as an error", async () => {
    const d = seller();
    const h = await harness(d);
    const r = await h.call("search", { q: "rates" });
    expect(r.isError).toBe(false);
    expect(r.structured.paymentRequired).toBe(true);
    expect(r.structured.d402).toEqual(d.offer());
    expect(r.structured.error).toBeUndefined();
    expect(r.text.startsWith("Payment required. No wallet needed")).toBe(true);
    expect(r.text).toContain(HOW);
    await h.close();
  });

  it("with a voucher runs the handler, appends calls remaining, and decrements", async () => {
    const h = await harness(seller());
    const voucher = await h.earn();
    const one = await h.call("search", { q: "rates", d402_voucher: voucher });
    expect(one.isError).toBe(false);
    expect(one.structured.hits).toEqual(["rates"]);
    expect(one.structured.args).toEqual({ q: "rates" });
    expect(one.structured.d402_calls_remaining).toBe(1);
    expect(one.text).toContain("hits for rates");
    expect(one.text).toContain("calls remaining: 1");
    const two = await h.call("search", { q: "gpu", d402_voucher: voucher });
    expect(two.structured.d402_calls_remaining).toBe(0);
    await h.close();
  });

  it("an exhausted voucher gives payment required with error voucher_exhausted", async () => {
    const h = await harness(seller());
    const voucher = await h.earn();
    await h.call("search", { q: "1", d402_voucher: voucher });
    await h.call("search", { q: "2", d402_voucher: voucher });
    const r = await h.call("search", { q: "3", d402_voucher: voucher });
    expect(r.isError).toBe(false);
    expect(r.structured.paymentRequired).toBe(true);
    expect(r.structured.error).toBe("voucher_exhausted");
    expect(r.structured.d402.error).toBe("voucher_exhausted");
    expect(r.text).toContain("voucher_exhausted");
    await h.close();
  });

  it("a tool whose scope path is outside the seller scope is scope_mismatch; a garbage voucher is voucher_invalid", async () => {
    const h = await harness(seller());
    const voucher = await h.earn();
    const r = await h.call("elsewhere", { d402_voucher: voucher });
    expect(r.structured.paymentRequired).toBe(true);
    expect(r.structured.error).toBe("scope_mismatch");
    const g = await h.call("search", { q: "x", d402_voucher: "a.b.c" });
    expect(g.structured.error).toBe("voucher_invalid");
    await h.close();
  });

  it("an expired voucher is voucher_expired", async () => {
    const h = await harness(seller());
    const voucher = await h.earn();
    clock.t += 86_401;
    const r = await h.call("search", { q: "x", d402_voucher: voucher });
    expect(r.structured.error).toBe("voucher_expired");
    await h.close();
  });
});

describe("bound vouchers (SPEC 7.1 + 7.2)", () => {
  it("session mode: the server signs each spend with the session key and a fresh nonce", async () => {
    const h = await harness(seller({ bindVouchers: true, requireSpendNonce: true }));
    const voucher = await h.earn();
    const one = await h.call("search", { q: "a", d402_voucher: voucher });
    expect(one.isError).toBe(false);
    expect(one.structured.d402_calls_remaining).toBe(1);
    const two = await h.call("search", { q: "b", d402_voucher: voucher });
    expect(two.structured.d402_calls_remaining).toBe(0);
    await h.close();
  });

  it("key mode: the agent must pass key, timestamp, sig and nonce; a replayed nonce is rejected", async () => {
    const h = await harness(seller({ bindVouchers: true }));
    const kp = generateKeypair();
    const b = await h.call("d402_get_bundle", { key: kp.publicKey });
    const answers = answersFor(b.structured as Bundle);
    const sub = await h.call("d402_submit", {
      bundleId: b.structured.bundleId,
      answers,
      key: kp.publicKey,
      sig: signSubmit(kp.privateKey, b.structured.bundleId, answers),
    });
    const voucher = sub.structured.voucher as string;
    const jti = decodeClaims(voucher)!.jti;

    const bare = await h.call("search", { q: "x", d402_voucher: voucher });
    expect(bare.structured.paymentRequired).toBe(true);
    expect(bare.structured.error).toBe("bad_key");

    const nonce = newNonce();
    const spendArgs = {
      d402_voucher: voucher,
      d402_key: kp.publicKey,
      d402_timestamp: clock.t,
      d402_nonce: nonce,
      d402_sig: signSpend(kp.privateKey, "TOOL", "/mcp/search", jti, clock.t, nonce),
    };
    const ok = await h.call("search", { q: "x", ...spendArgs });
    expect(ok.isError).toBe(false);
    expect(ok.structured.d402_calls_remaining).toBe(1);
    expect(ok.structured.args).toEqual({ q: "x" });

    const replay = await h.call("search", { q: "x", ...spendArgs });
    expect(replay.structured.paymentRequired).toBe(true);
    expect(replay.structured.error).toBe("replayed_spend");

    const stale = await h.call("search", { q: "x", ...spendArgs, d402_timestamp: clock.t - 1000, d402_nonce: newNonce() });
    expect(stale.structured.error).toBe("stale_timestamp");
    await h.close();
  });
});

describe("d402_status", () => {
  it("reports no voucher, then the last session voucher, then an explicit one", async () => {
    const h = await harness(seller());
    const none = await h.call("d402_status");
    expect(none.isError).toBe(false);
    expect(none.structured.voucher).toBeNull();
    expect(none.structured.mode).toBe("session");

    const voucher = await h.earn();
    const after = await h.call("d402_status");
    expect(after.structured.voucher.callsLeft).toBe(2);
    expect(after.structured.voucher.jti).toBe(decodeClaims(voucher)!.jti);
    expect(after.structured.voucher.expired).toBe(false);

    await h.call("search", { q: "x", d402_voucher: voucher });
    const explicit = await h.call("d402_status", { voucher });
    expect(explicit.structured.voucher.callsLeft).toBe(1);
    expect(explicit.structured.voucher.scope).toEqual(["/search", "/mcp/search"]);

    const bogus = await h.call("d402_status", { voucher: "not-a-jwt" });
    expect(bogus.isError).toBe(true);
    expect(bogus.structured.code).toBe("voucher_invalid");
    await h.close();
  });
});

describe("one voucher across HTTP and MCP", () => {
  it("earned over HTTP (/.well-known/d402/tasks), spent on an MCP gated tool", async () => {
    const d = seller();
    const h = await harness(d);
    const { app } = createStreamableHttpApp({ d402: d, mcp: () => h.mcp.server });
    const kp = generateKeypair();
    const b = (await (await app.request("http://seller.test/.well-known/d402/tasks?tier=s", { headers: { [HEADERS.key]: kp.publicKey } })).json()) as Bundle;
    const answers = answersFor(b);
    const res = await app.request(`http://seller.test/.well-known/d402/tasks/${b.bundleId}`, {
      method: "POST",
      headers: { [HEADERS.key]: kp.publicKey, "content-type": "application/json" },
      body: JSON.stringify({ answers, sig: signSubmit(kp.privateKey, b.bundleId, answers) }),
    });
    expect(res.status).toBe(200);
    const { voucher } = (await res.json()) as { voucher: string };
    const r = await h.call("search", { q: "http", d402_voucher: voucher });
    expect(r.isError).toBe(false);
    expect(r.structured.d402_calls_remaining).toBe(1);
    await h.close();
  });

  it("earned over MCP (session mode), spent on an HTTP route gated by the same d402", async () => {
    const d = seller();
    const h = await harness(d);
    const voucher = await h.earn();
    const app = new Hono();
    app.use("/search", d.gate);
    app.get("/search", (c) => c.json({ ok: true }));
    const res = await app.request("http://seller.test/search?q=mcp", { headers: { [HEADERS.voucher]: voucher } });
    expect(res.status).toBe(200);
    expect(res.headers.get(HEADERS.callsRemaining)).toBe("1");
    // And the same voucher still has its last call on the MCP side.
    const r = await h.call("search", { q: "x", d402_voucher: voucher });
    expect(r.structured.d402_calls_remaining).toBe(0);
    await h.close();
  });
});
