import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { serve, type ServerType } from "@hono/node-server";
import { HEADERS, findD402Accept, generateKeypair, type Offer, type Tier } from "@d402/spec";
import { createD402Client, createLookupSolver, MemoryVoucherCache, type D402Client } from "@d402/client";
import {
  ADMIN_EXPORT_PATH,
  ADMIN_STATS_PATH,
  DEFAULT_TIERS,
  HelpRequested,
  createProxyApp,
  labelsFromTaskFile,
  parseArgs,
  parseTier,
  type ProxyOptions,
} from "./index.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const LABELS = ["sports", "business", "tech", "world"];
const PUBLIC_URL = "https://d402.example.test";
const BIG = "0123456789abcdef".repeat(200 * 1024 / 16); // 200 KB
const BIG_SHA = createHash("sha256").update(BIG).digest("hex");

/** Deterministic classify pool: `total` items, the first `goldens` carry a golden label. */
function makeTasks(total: number, goldens: number): { text: string; truth: Record<string, string> } {
  const truth: Record<string, string> = {};
  const lines: string[] = [];
  for (let i = 0; i < total; i++) {
    const id = `t_${String(i).padStart(3, "0")}`;
    const label = LABELS[i % LABELS.length]!;
    truth[id] = label;
    const row: Record<string, unknown> = { id, type: "classify", text: `item ${i} about ${label}` };
    if (i < goldens) row.golden = label;
    lines.push(JSON.stringify(row));
  }
  return { text: lines.join("\n") + "\n", truth };
}

let tmp: string;
let tasksPath: string;
let truth: Record<string, string>;
let tinyPath: string;
let tinyTruth: Record<string, string>;

let upstream: ServerType;
let upstreamUrl: string;
let upstreamHost: string;

function startUpstream(): Promise<{ server: ServerType; url: string; host: string }> {
  const u = new Hono();
  u.get("/health", (c) => c.json({ ok: true }));
  u.get("/v1/items", (c) => {
    const headers: Record<string, string> = {};
    c.req.raw.headers.forEach((v, k) => (headers[k] = v));
    return c.json({ q: c.req.query("q") ?? null, query: c.req.query(), headers, url: c.req.url });
  });
  u.post("/v1/echo", async (c) => {
    const headers: Record<string, string> = {};
    c.req.raw.headers.forEach((v, k) => (headers[k] = v));
    return c.json({ body: await c.req.json(), headers });
  });
  u.put("/v1/raw", async (c) => c.text(await c.req.text()));
  u.get("/big", (c) => c.text(BIG));
  u.get("/v1/custom", (c) => {
    c.header("X-Upstream-Custom", "yes");
    c.header("Cache-Control", "max-age=60");
    return c.json({ custom: true }, 201);
  });
  u.get("/v1/missing", (c) => c.json({ error: "nope" }, 404));
  u.all("*", (c) => c.json({ error: "not_found", path: c.req.path }, 404));
  return new Promise((resolve) => {
    const server = serve({ fetch: u.fetch, port: 0, hostname: "127.0.0.1" }, (info) => {
      resolve({ server, url: `http://127.0.0.1:${info.port}`, host: `127.0.0.1:${info.port}` });
    });
  });
}

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), "d402-proxy-"));
  const main = makeTasks(60, 30);
  truth = main.truth;
  tasksPath = join(tmp, "tasks.jsonl");
  writeFileSync(tasksPath, main.text);
  const tiny = makeTasks(10, 8);
  tinyTruth = tiny.truth;
  tinyPath = join(tmp, "tiny.jsonl");
  writeFileSync(tinyPath, tiny.text);
  const up = await startUpstream();
  upstream = up.server;
  upstreamUrl = up.url;
  upstreamHost = up.host;
});

afterAll(async () => {
  await new Promise<void>((r) => upstream.close(() => r()));
  rmSync(tmp, { recursive: true, force: true });
});

function baseOpts(extra: Partial<ProxyOptions> = {}): ProxyOptions {
  return {
    upstream: upstreamUrl,
    tasks: tasksPath,
    scope: ["/v1"],
    labels: LABELS,
    sellerId: "api.example.test",
    publicUrl: PUBLIC_URL,
    secret: "test-secret",
    open: ["/health"],
    log: () => {},
    warn: () => {},
    ...extra,
  };
}

function agentFor(app: Hono, lookup: Record<string, string>, env?: object): D402Client {
  return createD402Client({
    keypair: generateKeypair(),
    solver: createLookupSolver((item) => lookup[item.id] ?? LABELS[0]!),
    tier: "s",
    model: "test-model",
    cache: new MemoryVoucherCache(),
    fetch: (input, init) => app.request(input as string | Request, init, env),
  });
}

// ---------------------------------------------------------------------------
// Proxy behaviour
// ---------------------------------------------------------------------------

describe("createProxyApp", () => {
  const logs: string[] = [];
  let app: Hono;
  let d402: ReturnType<typeof createProxyApp>["d402"];

  beforeAll(() => {
    ({ app, d402 } = createProxyApp(baseOpts({ adminToken: "admin-secret", log: (l) => logs.push(l) })));
  });
  afterAll(() => d402.close());

  it("loads the task file at boot", () => {
    expect(d402.tasks.stats()).toMatchObject({ total: 60, golden: 30 });
  });

  it("an open path passes through to the upstream without a voucher", async () => {
    const res = await app.request("/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("a path outside the scope is forwarded without a voucher", async () => {
    const res = await app.request("/big");
    expect(res.status).toBe(200);
    expect((await res.text()).length).toBe(BIG.length);
  });

  it("a scoped path without a voucher returns 402 with an offer whose taskUrl uses publicUrl", async () => {
    const res = await app.request("/v1/items?q=x");
    expect(res.status).toBe(402);
    const offer = (await res.json()) as Offer;
    expect(offer.d402).toBe("1");
    expect(offer.error).toBe("missing_voucher");
    const accept = findD402Accept(offer)!;
    expect(accept.taskUrl).toBe(`${PUBLIC_URL}/.well-known/d402/tasks`);
    expect(accept.sellerId).toBe("api.example.test");
    expect(accept.scope).toEqual(["/v1"]);
    expect(accept.tiers).toEqual(DEFAULT_TIERS);
  });

  it("GET /.well-known/d402 is served by the proxy, not forwarded", async () => {
    const res = await app.request("/.well-known/d402");
    expect(res.status).toBe(200);
    const offer = (await res.json()) as Offer;
    expect(findD402Accept(offer)!.taskUrl).toBe(`${PUBLIC_URL}/.well-known/d402/tasks`);
  });

  it("a garbage voucher is a 402 voucher_invalid", async () => {
    const res = await app.request("/v1/items", { headers: { [HEADERS.voucher]: "nope" } });
    expect(res.status).toBe(402);
    expect(await res.json()).toMatchObject({ error: "voucher_invalid" });
  });

  describe("after earning a voucher with the real client", () => {
    let client: D402Client;
    beforeAll(() => {
      client = agentFor(app, truth, { incoming: { socket: { remoteAddress: "10.1.2.3" } } });
    });

    it("a proxied GET returns the upstream JSON and D402-Calls-Remaining", async () => {
      const res = await client.fetch(`${PUBLIC_URL}/v1/items?q=rates`);
      expect(res.status).toBe(200);
      expect(res.headers.get(HEADERS.callsRemaining)).toBe("9");
      const body = (await res.json()) as { q: string };
      expect(body.q).toBe("rates");
      expect(d402.agents.list()).toHaveLength(1);
      expect(d402.agents.list()[0]!.bundles).toBe(1);
    });

    it("the cached voucher is reused and the counter decrements", async () => {
      const res = await client.fetch(`${PUBLIC_URL}/v1/items?q=again`);
      expect(res.status).toBe(200);
      expect(res.headers.get(HEADERS.callsRemaining)).toBe("8");
      expect(d402.agents.list()[0]!.bundles).toBe(1);
    });

    it("query strings are preserved, including repeated and encoded keys", async () => {
      const res = await client.fetch(`${PUBLIC_URL}/v1/items?q=a%20b&tag=x&tag=y&empty=`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { q: string; url: string; query: Record<string, string> };
      expect(body.q).toBe("a b");
      expect(body.url.endsWith("/v1/items?q=a%20b&tag=x&tag=y&empty=")).toBe(true);
      expect(body.query).toMatchObject({ tag: "x", empty: "" });
    });

    it("a POST body is forwarded and echoed back", async () => {
      const payload = { hello: "world", n: [1, 2, 3], nested: { ok: true } };
      const res = await client.fetch(`${PUBLIC_URL}/v1/echo`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { body: unknown; headers: Record<string, string> };
      expect(body.body).toEqual(payload);
      expect(body.headers["content-type"]).toBe("application/json");
    });

    it("a PUT body with a non-JSON payload is streamed through byte for byte", async () => {
      const raw = "x".repeat(70_000) + "énd";
      const res = await client.fetch(`${PUBLIC_URL}/v1/raw`, { method: "PUT", body: raw });
      expect(res.status).toBe(200);
      expect(await res.text()).toBe(raw);
    });

    it("sets X-Forwarded-For/Proto/Host, rewrites Host and drops the voucher before the upstream", async () => {
      const res = await client.fetch(`${PUBLIC_URL}/v1/items?q=h`, { headers: { "x-client": "kept" } });
      const body = (await res.json()) as { headers: Record<string, string> };
      expect(body.headers["x-forwarded-for"]).toBe("10.1.2.3");
      expect(body.headers["x-forwarded-proto"]).toBe("https");
      expect(body.headers["x-forwarded-host"]).toBe("d402.example.test");
      expect(body.headers["host"]).toBe(upstreamHost);
      expect(body.headers["x-client"]).toBe("kept");
      expect(body.headers["via"]).toBe("1.1 d402-proxy");
      expect(body.headers[HEADERS.voucher.toLowerCase()]).toBeUndefined();
    });

    it("appends to an existing X-Forwarded-For and strips hop-by-hop request headers", async () => {
      const res = await client.fetch(`${PUBLIC_URL}/v1/items?q=h`, {
        headers: { "x-forwarded-for": "203.0.113.9", "proxy-authorization": "Basic zz", te: "trailers" },
      });
      const body = (await res.json()) as { headers: Record<string, string> };
      expect(body.headers["x-forwarded-for"]).toBe("203.0.113.9, 10.1.2.3");
      expect(body.headers["proxy-authorization"]).toBeUndefined();
      expect(body.headers["te"]).toBeUndefined();
    });

    it("upstream status and headers are preserved on the proxied response", async () => {
      const res = await client.fetch(`${PUBLIC_URL}/v1/custom`);
      expect(res.status).toBe(201);
      expect(res.headers.get("x-upstream-custom")).toBe("yes");
      expect(res.headers.get("cache-control")).toBe("max-age=60");
      expect(res.headers.get("content-type")).toContain("application/json");
      expect(res.headers.get(HEADERS.callsRemaining)).toMatch(/^\d+$/);
      expect(await res.json()).toEqual({ custom: true });
    });

    it("an upstream 404 passes through as 404 after paying", async () => {
      const before = Number((await client.fetch(`${PUBLIC_URL}/v1/items`)).headers.get(HEADERS.callsRemaining));
      const res = await client.fetch(`${PUBLIC_URL}/v1/missing`);
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "nope" });
      expect(Number(res.headers.get(HEADERS.callsRemaining))).toBe(before - 1);
    });

    it("admin stats reflects the passed bundle", async () => {
      const res = await app.request(ADMIN_STATS_PATH, { headers: { authorization: "Bearer admin-secret" } });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        stats: { total: number; golden: number };
        agents: Array<{ publicKey: string; bundles: number; goldenSeen: number; model?: string }>;
        resolved: number;
      };
      expect(body.stats).toMatchObject({ total: 60, golden: 30 });
      expect(body.agents).toHaveLength(1);
      expect(body.agents[0]).toMatchObject({ publicKey: client.keypair.publicKey, bundles: 1, model: "test-model" });
      expect(body.agents[0]!.goldenSeen).toBeGreaterThan(0);
      expect(body.resolved).toBe(0);
    });
  });

  it("a big upstream body is streamed through intact", async () => {
    const client = agentFor(app, truth);
    const res = await client.fetch(`${PUBLIC_URL}/v1/../big`.replace("/v1/../", "/"));
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text.length).toBe(BIG.length);
    expect(createHash("sha256").update(text).digest("hex")).toBe(BIG_SHA);
  });

  it("admin endpoints require the bearer token", async () => {
    expect((await app.request(ADMIN_STATS_PATH)).status).toBe(401);
    expect((await app.request(ADMIN_STATS_PATH, { headers: { authorization: "Bearer wrong" } })).status).toBe(401);
    expect((await app.request(ADMIN_STATS_PATH, { headers: { authorization: "Basic admin-secret" } })).status).toBe(401);
    expect((await app.request(ADMIN_EXPORT_PATH)).status).toBe(401);
    const ok = await app.request(ADMIN_EXPORT_PATH, { headers: { authorization: "Bearer admin-secret" } });
    expect(ok.status).toBe(200);
    expect(ok.headers.get("content-type")).toContain("application/x-ndjson");
  });

  it("logs one line per request: open / 402 / paid", async () => {
    logs.length = 0;
    await app.request("/health");
    await app.request("/v1/items");
    const client = agentFor(app, truth);
    await client.fetch(`${PUBLIC_URL}/v1/items?q=log`);
    expect(logs[0]).toMatch(/^GET \/health 200 \d+ms open$/);
    expect(logs[1]).toMatch(/^GET \/v1\/items 402 \d+ms 402$/);
    expect(logs.at(-1)).toMatch(/^GET \/v1\/items 200 \d+ms paid$/);
    // The task routes are open and logged too.
    expect(logs.some((l) => /^GET \/\.well-known\/d402\/tasks 200 \d+ms open$/.test(l))).toBe(true);
    expect(logs.some((l) => /^POST \/\.well-known\/d402\/tasks\/b_\S+ 200 \d+ms open$/.test(l))).toBe(true);
  });
});

describe("createProxyApp: variants", () => {
  it("admin export returns JSONL of resolved items once enough agents agree", async () => {
    const { app, d402 } = createProxyApp(baseOpts({ tasks: tinyPath, adminToken: "t" }));
    try {
      // tiny pool: 8 goldens + 2 unknowns, so every bundle carries both unknowns.
      // Four fresh agents at prior weight 0.5 each reach the 2.0 resolve weight.
      for (let i = 0; i < 4; i++) {
        const res = await agentFor(app, tinyTruth).fetch(`${PUBLIC_URL}/v1/items`);
        expect(res.status).toBe(200);
      }
      const stats = await app.request(ADMIN_STATS_PATH, { headers: { authorization: "Bearer t" } });
      expect(((await stats.json()) as { resolved: number }).resolved).toBe(2);
      const res = await app.request(ADMIN_EXPORT_PATH, { headers: { authorization: "Bearer t" } });
      expect(res.status).toBe(200);
      const lines = (await res.text()).trim().split("\n");
      expect(lines).toHaveLength(2);
      const rows = lines.map((l) => JSON.parse(l) as { id: string; answer: string; voters: number; weight: number });
      expect(rows.map((r) => r.id).sort()).toEqual(["t_008", "t_009"]);
      for (const r of rows) {
        expect(r.answer).toBe(tinyTruth[r.id]);
        expect(r.voters).toBe(4);
        expect(r.weight).toBeCloseTo(2);
      }
    } finally {
      d402.close();
    }
  });

  it("without --admin-token the admin paths are not mounted (and are gated like anything else)", async () => {
    const { app, d402 } = createProxyApp(baseOpts({ scope: ["/v1"] }));
    try {
      const res = await app.request(ADMIN_STATS_PATH, { headers: { authorization: "Bearer x" } });
      expect(res.status).toBe(404);
    } finally {
      d402.close();
    }
  });

  it("gates everything except /.well-known and open paths by default", async () => {
    const { app, d402 } = createProxyApp(baseOpts({ scope: undefined, open: ["/health", "/docs"] }));
    try {
      expect((await app.request("/health")).status).toBe(200);
      expect((await app.request("/docs/anything")).status).toBe(404); // forwarded, upstream 404
      expect((await app.request("/big")).status).toBe(402);
      expect((await app.request("/v1/items")).status).toBe(402);
      expect((await app.request("/.well-known/d402")).status).toBe(200);
      const offer = (await (await app.request("/big")).json()) as Offer;
      expect(findD402Accept(offer)!.scope).toEqual(["/"]);
    } finally {
      d402.close();
    }
  });

  it("derives labels from the task file goldens when --labels is absent, with a warning", async () => {
    const warnings: string[] = [];
    const { app, d402 } = createProxyApp(baseOpts({ labels: undefined, warn: (w) => warnings.push(w) }));
    try {
      expect(warnings.some((w) => w.includes("derived") && w.includes('"sports"'))).toBe(true);
      const client = agentFor(app, truth);
      const offer = await client.discover(PUBLIC_URL);
      const bundle = await client.getBundle(findD402Accept(offer)!.taskUrl, "s");
      expect(bundle.labels).toEqual(LABELS);
    } finally {
      d402.close();
    }
  });

  it("labelsFromTaskFile collects distinct goldens in first-seen order", () => {
    expect(labelsFromTaskFile(tasksPath)).toEqual(LABELS);
  });

  it("errors when labels cannot be derived", () => {
    expect(() => createProxyApp(baseOpts({ labels: undefined, tasks: undefined }))).toThrow(/--labels is required/);
    const onlyOne = join(tmp, "one.jsonl");
    writeFileSync(onlyOne, JSON.stringify({ id: "a", type: "classify", text: "t", golden: "x" }) + "\n");
    expect(() => createProxyApp(baseOpts({ labels: undefined, tasks: onlyOne }))).toThrow(/only 1 distinct golden/);
    expect(() => createProxyApp(baseOpts({ labels: ["solo"] }))).toThrow(/at least 2/);
  });

  it("generates a secret with a warning when none is given, and vouchers from it work", async () => {
    const warnings: string[] = [];
    const { app, d402 } = createProxyApp(baseOpts({ secret: undefined, warn: (w) => warnings.push(w) }));
    try {
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toMatch(/generated a random one/);
      expect(warnings[0]).toMatch(/not survive a restart/);
      const res = await agentFor(app, truth).fetch(`${PUBLIC_URL}/v1/items?q=s`);
      expect(res.status).toBe(200);
    } finally {
      d402.close();
    }
  });

  it("does not warn when a secret is given", () => {
    const warnings: string[] = [];
    const { d402 } = createProxyApp(baseOpts({ warn: (w) => warnings.push(w) }));
    d402.close();
    expect(warnings).toEqual([]);
  });

  it("rejects a missing or invalid upstream", () => {
    expect(() => createProxyApp(baseOpts({ upstream: "" }))).toThrow(/--upstream is required/);
    expect(() => createProxyApp(baseOpts({ upstream: "not a url" }))).toThrow(/not a valid URL/);
    expect(() => createProxyApp(baseOpts({ upstream: "ftp://x" }))).toThrow(/http\(s\)/);
  });

  it("defaults sellerId to the upstream host and publicUrl to localhost:port", async () => {
    const { app, d402 } = createProxyApp(baseOpts({ sellerId: undefined, publicUrl: undefined, port: 9999 }));
    try {
      const offer = (await (await app.request("/v1/items")).json()) as Offer;
      const accept = findD402Accept(offer)!;
      expect(accept.sellerId).toBe(upstreamHost);
      expect(accept.taskUrl).toBe("http://localhost:9999/.well-known/d402/tasks");
    } finally {
      d402.close();
    }
  });

  it("an upstream with a path prefix is joined with the request path", async () => {
    const seen: string[] = [];
    const fakeFetch: typeof fetch = async (input) => {
      seen.push(String(input));
      return new Response("ok");
    };
    const { app, d402 } = createProxyApp(baseOpts({ upstream: "http://up.test/base/", fetch: fakeFetch }));
    try {
      await app.request("/health?x=1");
      expect(seen).toEqual(["http://up.test/base/health?x=1"]);
    } finally {
      d402.close();
    }
  });

  it("strips hop-by-hop and content-encoding headers from the upstream response", async () => {
    const fakeFetch: typeof fetch = async () =>
      new Response("plain", {
        status: 200,
        headers: {
          connection: "close",
          "keep-alive": "timeout=5",
          "transfer-encoding": "chunked",
          "content-encoding": "gzip",
          "content-length": "999",
          "x-kept": "1",
        },
      });
    const { app, d402 } = createProxyApp(baseOpts({ fetch: fakeFetch }));
    try {
      const res = await app.request("/health");
      expect(res.status).toBe(200);
      expect(res.headers.get("x-kept")).toBe("1");
      for (const h of ["connection", "keep-alive", "transfer-encoding", "content-encoding", "content-length"]) {
        expect(res.headers.get(h)).toBeNull();
      }
      expect(await res.text()).toBe("plain");
    } finally {
      d402.close();
    }
  });

  it("answers 502 when the upstream is unreachable", async () => {
    const { app, d402 } = createProxyApp(baseOpts({ upstream: "http://127.0.0.1:1" }));
    try {
      const res = await app.request("/health");
      expect(res.status).toBe(502);
      expect(await res.json()).toMatchObject({ error: "bad_gateway" });
    } finally {
      d402.close();
    }
  });

  it("honours custom tiers and bindVouchers", async () => {
    const tiers: Tier[] = [{ id: "xs", items: 3, est_tokens: 500, reward: { calls: 4 } }];
    const { app, d402 } = createProxyApp(baseOpts({ tiers, bindVouchers: true }));
    try {
      const offer = (await (await app.request("/v1/items")).json()) as Offer;
      expect(findD402Accept(offer)!.tiers).toEqual(tiers);
      const client = createD402Client({
        keypair: generateKeypair(),
        solver: createLookupSolver((item) => truth[item.id] ?? "sports"),
        tier: "xs",
        fetch: (input, init) => app.request(input as string | Request, init),
      });
      const res = await client.fetch(`${PUBLIC_URL}/v1/items`);
      expect(res.status).toBe(200);
      expect(res.headers.get(HEADERS.callsRemaining)).toBe("3");
    } finally {
      d402.close();
    }
  });
});

// ---------------------------------------------------------------------------
// parseArgs
// ---------------------------------------------------------------------------

describe("parseArgs", () => {
  const env = {} as NodeJS.ProcessEnv;

  it("parses every flag", () => {
    const opts = parseArgs(
      [
        "--upstream", "https://api.example.com",
        "--tasks", "./tasks.jsonl",
        "--scope", "/v1,/v2/",
        "--labels", "sports, business ,tech,world",
        "--seller-id", "api.example.com",
        "--public-url", "https://d402.example.com",
        "--secret", "s3cret",
        "--port", "8787",
        "--tier", "s:5:1000:10",
        "--tier", "m:25:5000:60",
        "--db", "./d402.db",
        "--bind-vouchers",
        "--require-model-families",
        "--admin-token", "X",
        "--open", "/health,/docs",
        "--instructions", "Pick one.",
      ],
      env,
    );
    expect(opts).toEqual({
      upstream: "https://api.example.com",
      tasks: "./tasks.jsonl",
      scope: ["/v1", "/v2/"],
      labels: ["sports", "business", "tech", "world"],
      sellerId: "api.example.com",
      publicUrl: "https://d402.example.com",
      secret: "s3cret",
      port: 8787,
      tiers: [
        { id: "s", items: 5, est_tokens: 1000, reward: { calls: 10 } },
        { id: "m", items: 25, est_tokens: 5000, reward: { calls: 60 } },
      ],
      db: "./d402.db",
      bindVouchers: true,
      requireModelFamilies: true,
      adminToken: "X",
      open: ["/health", "/docs"],
      instructions: "Pick one.",
    } satisfies ProxyOptions);
  });

  it("accepts --flag=value and leaves unset keys out", () => {
    const opts = parseArgs(["--upstream=http://u", "--port=0", "--labels=a,b"], env);
    expect(opts).toEqual({ upstream: "http://u", port: 0, labels: ["a", "b"] });
    expect("secret" in opts).toBe(false);
  });

  it("parses --tier and rejects malformed ones", () => {
    expect(parseTier("l:50:10000:150")).toEqual({ id: "l", items: 50, est_tokens: 10000, reward: { calls: 150 } });
    expect(() => parseTier("l:50:10000")).toThrow(/id:items:est_tokens:calls/);
    expect(() => parseTier("l:x:10000:150")).toThrow(/positive integers/);
    expect(() => parseTier(":5:1:1")).toThrow(/positive integers/);
    expect(() => parseArgs(["--upstream", "http://u", "--tier", "bad"], env)).toThrow(/--tier/);
  });

  it("reads the secret from env D402_SECRET when the flag is absent, flag wins", () => {
    expect(parseArgs(["--upstream", "http://u"], { D402_SECRET: "from-env" } as NodeJS.ProcessEnv).secret).toBe("from-env");
    expect(parseArgs(["--upstream", "http://u", "--secret", "flag"], { D402_SECRET: "from-env" } as NodeJS.ProcessEnv).secret).toBe("flag");
    expect(parseArgs(["--upstream", "http://u"], env).secret).toBeUndefined();
  });

  it("errors on a missing --upstream, a flag without a value and an unknown flag", () => {
    expect(() => parseArgs([], env)).toThrow(/--upstream is required/);
    expect(() => parseArgs(["--labels", "a,b"], env)).toThrow(/--upstream is required/);
    expect(() => parseArgs(["--upstream"], env)).toThrow(/--upstream needs a value/);
    expect(() => parseArgs(["--upstream", "http://u", "--bogus"], env)).toThrow(/unknown flag "--bogus"/);
    expect(() => parseArgs(["--upstream", "http://u", "--port", "abc"], env)).toThrow(/--port/);
    expect(() => parseArgs(["--help"], env)).toThrow(HelpRequested);
  });

  it("merges --config and lets flags override it", () => {
    const cfg = join(tmp, "d402.json");
    writeFileSync(
      cfg,
      JSON.stringify({
        upstream: "http://from-config",
        tasks: "cfg.jsonl",
        scope: ["/a"],
        labels: "x,y,z",
        sellerId: "cfg-seller",
        publicUrl: "http://cfg",
        secret: "cfg-secret",
        port: 1234,
        tiers: ["s:5:1000:10", { id: "m", items: 25, est_tokens: 5000, reward: { calls: 60 } }],
        db: "cfg.db",
        bindVouchers: true,
        requireModelFamilies: false,
        adminToken: "cfg-admin",
        open: "/health",
      }),
    );
    const fromConfig = parseArgs(["--config", cfg], env);
    expect(fromConfig).toEqual({
      upstream: "http://from-config",
      tasks: "cfg.jsonl",
      scope: ["/a"],
      labels: ["x", "y", "z"],
      sellerId: "cfg-seller",
      publicUrl: "http://cfg",
      secret: "cfg-secret",
      port: 1234,
      tiers: [
        { id: "s", items: 5, est_tokens: 1000, reward: { calls: 10 } },
        { id: "m", items: 25, est_tokens: 5000, reward: { calls: 60 } },
      ],
      db: "cfg.db",
      bindVouchers: true,
      requireModelFamilies: false,
      adminToken: "cfg-admin",
      open: ["/health"],
    });

    const overridden = parseArgs(
      ["--config", cfg, "--upstream", "http://flag", "--port", "9", "--tier", "l:50:10000:150", "--labels", "p,q", "--require-model-families"],
      { D402_SECRET: "env" } as NodeJS.ProcessEnv,
    );
    expect(overridden.upstream).toBe("http://flag");
    expect(overridden.port).toBe(9);
    expect(overridden.tiers).toEqual([{ id: "l", items: 50, est_tokens: 10000, reward: { calls: 150 } }]);
    expect(overridden.labels).toEqual(["p", "q"]);
    expect(overridden.requireModelFamilies).toBe(true);
    expect(overridden.secret).toBe("cfg-secret"); // config beats env; flag would beat both
    expect(overridden.sellerId).toBe("cfg-seller");

    expect(() => parseArgs(["--config", join(tmp, "missing.json")], env)).toThrow(/could not read --config/);
    const bad = join(tmp, "bad.json");
    writeFileSync(bad, "[1]");
    expect(() => parseArgs(["--config", bad], env)).toThrow(/must contain a JSON object/);
  });
});

// ---------------------------------------------------------------------------
// The real CLI
// ---------------------------------------------------------------------------

describe("d402-proxy CLI", () => {
  const pkgDir = join(dirname(fileURLToPath(import.meta.url)), "..");
  let child: ChildProcess | undefined;

  afterAll(() => {
    child?.kill("SIGTERM");
  });

  it("boots, serves the offer over real HTTP and 402s a scoped path", async () => {
    child = spawn(
      process.execPath,
      [
        "--import", "tsx", "src/cli.ts",
        "--upstream", upstreamUrl,
        "--tasks", tasksPath,
        "--labels", LABELS.join(","),
        "--scope", "/v1",
        "--open", "/health",
        "--public-url", "https://cli.example.test",
        "--secret", "cli-secret",
        "--port", "0",
      ],
      { cwd: pkgDir, env: { ...process.env }, stdio: ["ignore", "pipe", "pipe"] },
    );
    let stderr = "";
    const port = await new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`CLI did not start:\n${stderr}`)), 25_000);
      child!.stderr!.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
        const m = /listening on http:\/\/localhost:(\d+)/.exec(stderr);
        if (m) {
          clearTimeout(timer);
          resolve(Number(m[1]));
        }
      });
      child!.once("exit", (code) => {
        clearTimeout(timer);
        reject(new Error(`CLI exited with ${code}:\n${stderr}`));
      });
    });
    expect(port).toBeGreaterThan(0);
    expect(stderr).toContain("pool:     60 items (30 golden)");

    const open = await fetch(`http://127.0.0.1:${port}/health`);
    expect(open.status).toBe(200);
    expect(await open.json()).toEqual({ ok: true });

    const gated = await fetch(`http://127.0.0.1:${port}/v1/items?q=1`);
    expect(gated.status).toBe(402);
    const offer = (await gated.json()) as Offer;
    expect(findD402Accept(offer)!.taskUrl).toBe("https://cli.example.test/.well-known/d402/tasks");

    const wk = await fetch(`http://127.0.0.1:${port}/.well-known/d402`);
    expect(wk.status).toBe(200);

    // The request log reaches stderr.
    await new Promise((r) => setTimeout(r, 100));
    expect(stderr).toMatch(/GET \/health 200 \d+ms open/);
    expect(stderr).toMatch(/GET \/v1\/items 402 \d+ms 402/);

    const exited = new Promise<number | null>((r) => child!.once("exit", (code) => r(code)));
    child.kill("SIGTERM");
    expect(await exited).toBe(0);
    child = undefined;
  });

  it("prints usage and exits 2 without --upstream", async () => {
    const proc = spawn(process.execPath, ["--import", "tsx", "src/cli.ts"], { cwd: pkgDir, stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    proc.stderr!.on("data", (c: Buffer) => (stderr += c.toString()));
    const code = await new Promise<number | null>((r) => proc.once("exit", (c) => r(c)));
    expect(code).toBe(2);
    expect(stderr).toContain("--upstream is required");
    expect(stderr).toContain("usage: d402-proxy");
  });
});
