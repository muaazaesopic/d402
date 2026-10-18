/**
 * These tests use the real `@d402/client`. When that package is still a stub
 * (built in parallel), they are skipped with a note instead of failing.
 */
import { createHmac } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { b64u, isValidPublicKey, verifySubmit, type D402Accept, type Offer } from "@d402/spec";

const clientMod = (await import("@d402/client").catch(() => null)) as Record<string, unknown> | null;
const hasClient = typeof clientMod?.createD402Client === "function" && typeof clientMod?.loadOrCreateKeypair === "function";
if (!hasClient) {
  console.warn("[@d402/mcp] @d402/client is not available yet; skipping config and real-client tests");
}

const ACCEPT: D402Accept = {
  scheme: "d402",
  sellerId: "api.example.com",
  taskUrl: "https://api.example.com/.well-known/d402/tasks",
  taskTypes: ["classify"],
  scope: ["/search"],
  voucherTtl: 86400,
  tiers: [{ id: "s", items: 2, est_tokens: 100, reward: { calls: 10 } }],
};
const OFFER: Offer = { d402: "1", accepts: [ACCEPT] };

function jwt(claims: Record<string, unknown>, secret: string): string {
  const h = b64u(Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })));
  const p = b64u(Buffer.from(JSON.stringify(claims)));
  const s = createHmac("sha256", secret).update(`${h}.${p}`).digest("base64url");
  return `${h}.${p}.${s}`;
}

/** A minimal in-memory d402 seller behind a fetch-compatible function. */
function makeSeller() {
  const secret = "s3cret";
  const vouchers = new Map<string, number>();
  const bundles = new Map<string, { key: string; golden: Record<string, string> }>();
  let n = 0;
  const log: string[] = [];
  const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    const url = new URL(req.url);
    log.push(`${req.method} ${url.pathname}`);
    if (url.pathname === "/.well-known/d402" && req.method === "GET") return json(200, OFFER);
    if (url.pathname === "/.well-known/d402/tasks" && req.method === "GET") {
      const key = req.headers.get("D402-Key");
      if (!key) return json(400, { error: "missing_key" });
      if (url.searchParams.get("tier") !== "s") return json(400, { error: "bad_tier" });
      const id = `b_${++n}`;
      bundles.set(id, { key, golden: { i_1: "tech", i_2: "sports" } });
      return json(200, {
        bundleId: id,
        tier: "s",
        type: "classify",
        instructions: "Label each item.",
        labels: ["sports", "tech"],
        items: [
          { id: "i_1", text: "GPU prices fall" },
          { id: "i_2", text: "Final score 3-2" },
        ],
        expiresAt: Math.floor(Date.now() / 1000) + 600,
      });
    }
    const m = url.pathname.match(/^\/\.well-known\/d402\/tasks\/(b_\d+)$/);
    if (m && req.method === "POST") {
      const b = bundles.get(m[1]!);
      if (!b) return json(404, { error: "unknown_bundle" });
      const body = (await req.json()) as { answers: Record<string, string>; sig: string };
      const key = req.headers.get("D402-Key") ?? "";
      if (key !== b.key || !verifySubmit(key, m[1]!, body.answers, body.sig)) return json(401, { error: "bad_signature" });
      bundles.delete(m[1]!);
      const ok = Object.entries(b.golden).every(([id, g]) => body.answers[id] === g);
      if (!ok) return json(422, { error: "quality", message: "bundle failed" });
      const now = Math.floor(Date.now() / 1000);
      const jti = `v_${n}`;
      vouchers.set(jti, 10);
      const token = jwt({ iss: "api.example.com", sub: key, scope: ["/search"], jti, iat: now, exp: now + 86400 }, secret);
      return json(200, { voucher: token, calls: 10, scope: ["/search"], expiresAt: now + 86400 });
    }
    if (url.pathname === "/search") {
      const v = req.headers.get("D402-Voucher");
      const jti = v ? (JSON.parse(Buffer.from(v.split(".")[1]!, "base64url").toString()) as { jti: string }).jti : undefined;
      const left = jti ? vouchers.get(jti) : undefined;
      if (!v || left === undefined) return json(402, { ...OFFER, error: v ? "voucher_invalid" : "missing_voucher" });
      if (left <= 0) return json(402, { ...OFFER, error: "voucher_exhausted" });
      vouchers.set(jti!, left - 1);
      return json(200, { results: [url.searchParams.get("q")] }, { "D402-Calls-Remaining": String(left - 1) });
    }
    return json(404, { error: "bad_request" });
  }) as typeof fetch;

  return { fetchImpl, log, vouchers };
}

describe.skipIf(!hasClient)("createClientFromEnv (real @d402/client)", () => {
  it("creates the keypair under D402_HOME and reuses it", async () => {
    const { createClientFromEnv, resolveConfig } = await import("./config.js");
    const home = join(mkdtempSync(join(tmpdir(), "d402-home-")), "nested", ".d402");
    const env = { D402_HOME: home, D402_MODEL: "claude", D402_TIER: "s" };
    const cfg = resolveConfig(env);
    expect(cfg).toMatchObject({ home, keypairPath: join(home, "keypair.json"), model: "claude", tier: "s" });
    expect(existsSync(home)).toBe(true);

    const c1 = createClientFromEnv(env);
    expect(existsSync(join(home, "keypair.json"))).toBe(true);
    expect(isValidPublicKey(c1.keypair.publicKey)).toBe(true);
    const onDisk = JSON.parse(readFileSync(join(home, "keypair.json"), "utf8")) as { publicKey: string };
    expect(onDisk.publicKey).toBe(c1.keypair.publicKey);

    const c2 = createClientFromEnv(env);
    expect(c2.keypair.publicKey).toBe(c1.keypair.publicKey);
    expect(await c2.status()).toEqual([]);
  });

  it("expands ~ in D402_HOME", async () => {
    const { expandHome } = await import("./config.js");
    expect(expandHome("~/.d402")).not.toContain("~");
    expect(expandHome("/abs/x")).toBe("/abs/x");
  });
});

describe.skipIf(!hasClient)("MCP tools over the real client against a fake seller", () => {
  it("discover -> get_bundle -> submit -> fetch spends the voucher", async () => {
    const { createD402Client, loadOrCreateKeypair, MemoryVoucherCache } = clientMod as {
      createD402Client: (o: unknown) => import("./types.js").D402ClientLike;
      loadOrCreateKeypair: (p: string) => unknown;
      MemoryVoucherCache: new () => unknown;
    };
    const { createMcpServer } = await import("./server.js");
    const home = mkdtempSync(join(tmpdir(), "d402-real-"));
    const keypair = loadOrCreateKeypair(join(home, "keypair.json"));
    const seller = makeSeller();
    const d402 = createD402Client({ keypair, cache: new MemoryVoucherCache(), fetch: seller.fetchImpl, model: "claude" });

    const server = createMcpServer({ client: d402 });
    const mcp = new Client({ name: "t", version: "0" });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);
    await mcp.connect(ct);
    const call = async (name: string, args: Record<string, unknown> = {}) => {
      const r = await mcp.callTool({ name, arguments: args });
      const text = (r.content as { type: string; text: string }[])[0]!.text;
      return { isError: r.isError === true, data: JSON.parse(text) as Record<string, any> };
    };

    // 1. a bare fetch is refused with the offer
    const first = await call("d402_fetch", { url: "https://api.example.com/search?q=gpu" });
    expect(first.isError).toBe(false);
    expect(first.data.needsVoucher).toBe(true);
    expect(first.data.offer.taskUrl).toBe(ACCEPT.taskUrl);

    // 2. discover + bundle
    const disc = await call("d402_discover", { baseUrl: "https://api.example.com" });
    expect(disc.data.sellerId).toBe("api.example.com");
    const b = await call("d402_get_bundle", { taskUrl: disc.data.taskUrl, tier: "s" });
    expect(b.isError).toBe(false);
    expect(b.data.items).toHaveLength(2);

    // 3. a wrong answer fails quality and the agent is told to get another bundle
    const bad = await call("d402_submit", { taskUrl: disc.data.taskUrl, bundleId: b.data.bundleId, answers: { i_1: "sports", i_2: "sports" } });
    expect(bad.isError).toBe(true);
    expect(bad.data.code).toBe("quality");

    const b2 = await call("d402_get_bundle", { taskUrl: disc.data.taskUrl, tier: "s" });
    const good = await call("d402_submit", { taskUrl: disc.data.taskUrl, bundleId: b2.data.bundleId, answers: { i_1: "tech", i_2: "sports" } });
    expect(good.isError).toBe(false);
    expect(good.data.calls).toBe(10);
    expect(good.data.sellerId).toBe("api.example.com");

    // 4. the voucher is spent on the next fetch
    const spent = await call("d402_fetch", { url: "https://api.example.com/search?q=gpu" });
    expect(spent.isError).toBe(false);
    expect(spent.data.status).toBe(200);
    expect(JSON.parse(spent.data.body)).toEqual({ results: ["gpu"] });
    expect(spent.data.headers["D402-Calls-Remaining"]).toBe("9");

    const st2 = await call("d402_status");
    expect(st2.data.publicKey).toBe((keypair as { publicKey: string }).publicKey);
    expect(st2.data.vouchers).toHaveLength(1);
    expect(st2.data.vouchers[0].sellerId).toBe("api.example.com");

    await mcp.close();
    await server.close();
  });
});
