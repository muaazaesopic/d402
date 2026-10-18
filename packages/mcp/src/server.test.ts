import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Bundle, D402Accept, Offer } from "@d402/spec";
import { createMcpServer, validateAnswers, type McpServerOptions } from "./server.js";
import type { D402ClientLike, StoredVoucherLike } from "./types.js";

// ---------- fixtures ----------

const ACCEPT: D402Accept = {
  scheme: "d402",
  sellerId: "api.example.com",
  taskUrl: "https://api.example.com/.well-known/d402/tasks",
  taskTypes: ["classify"],
  scope: ["/search"],
  voucherTtl: 86400,
  tiers: [
    { id: "m", items: 25, est_tokens: 5000, reward: { calls: 60 } },
    { id: "s", items: 5, est_tokens: 1000, reward: { calls: 10 } },
    { id: "l", items: 50, est_tokens: 10000, reward: { calls: 150 } },
  ],
};
const OFFER: Offer = { d402: "1", accepts: [ACCEPT] };
const X402_ONLY_OFFER: Offer = { d402: "1", accepts: [{ scheme: "exact", network: "base" }] };
const NOW = 1_760_000_000;

function makeBundle(id = "b_1", tier = "s"): Bundle {
  return {
    bundleId: id,
    tier,
    type: "classify",
    instructions: "Label each item with exactly one of the labels.",
    labels: ["sports", "tech"],
    items: [
      { id: "i_1", text: "GPU prices fall" },
      { id: "i_2", text: "Final score 3-2" },
    ],
    expiresAt: NOW + 600,
  };
}

function makeVoucher(over: Partial<StoredVoucherLike> = {}): StoredVoucherLike {
  return {
    jti: "v_1",
    sellerId: "api.example.com",
    token: "x.y.z",
    scope: ["/search"],
    calls: 10,
    expiresAt: NOW + 86400,
    sub: "PK",
    taskUrl: ACCEPT.taskUrl,
    ...over,
  };
}

class FakeD402Error extends Error {
  constructor(
    public code: string,
    public status: number,
    public body?: unknown,
    message?: string,
  ) {
    super(message ?? `${code} (${status})`);
  }
}

interface FakeClient extends D402ClientLike {
  log: { name: string; args: unknown[] }[];
}

function makeFake(over: Partial<D402ClientLike> = {}): FakeClient {
  const log: FakeClient["log"] = [];
  const rec =
    <T extends (...a: never[]) => unknown>(name: string, fn: T) =>
    (...args: Parameters<T>) => {
      log.push({ name, args });
      return fn(...args);
    };
  const base: D402ClientLike = {
    keypair: { publicKey: "PK", privateKey: "SK" },
    fetch: (async () => new Response("hello", { status: 200 })) as unknown as typeof fetch,
    discover: async () => OFFER,
    getBundle: async (_u, tier) => makeBundle("b_1", tier),
    submit: async () => makeVoucher(),
    earn: async () => makeVoucher(),
    status: async () => [makeVoucher()],
    ...over,
  };
  return {
    log,
    keypair: base.keypair,
    fetch: rec("fetch", base.fetch) as unknown as typeof fetch,
    discover: rec("discover", base.discover),
    getBundle: rec("getBundle", base.getBundle),
    submit: rec("submit", base.submit),
    earn: rec("earn", base.earn),
    status: rec("status", base.status),
  };
}

async function harness(opts: Omit<McpServerOptions, "now"> & { now?: () => number }) {
  const server = createMcpServer({ now: () => NOW, ...opts });
  const client = new Client({ name: "test-client", version: "0.0.0" });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  await client.connect(ct);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const res = await client.callTool({ name, arguments: args });
    const text = (res.content as { type: string; text: string }[]).find((c) => c.type === "text")?.text ?? "";
    return { res, isError: res.isError === true, data: JSON.parse(text) as Record<string, any>, structured: res.structuredContent as Record<string, any> };
  };
  const close = async () => {
    await client.close();
    await server.close();
  };
  return { client, server, call, close };
}

// ---------- tests ----------

describe("tool listing", () => {
  it("lists the five d402 tools with input schemas", async () => {
    const h = await harness({ client: makeFake() });
    const { tools } = await h.client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(["d402_discover", "d402_fetch", "d402_get_bundle", "d402_status", "d402_submit"]);
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    expect(byName.d402_discover!.inputSchema.properties).toHaveProperty("baseUrl");
    expect(byName.d402_discover!.inputSchema.required).toContain("baseUrl");
    expect(byName.d402_submit!.inputSchema.properties).toHaveProperty("answers");
    expect(byName.d402_submit!.inputSchema.required).toEqual(expect.arrayContaining(["taskUrl", "bundleId", "answers"]));
    expect(byName.d402_fetch!.inputSchema.properties).toHaveProperty("autoEarn");
    expect(byName.d402_fetch!.inputSchema.required).toEqual(["url"]);
    expect(byName.d402_get_bundle!.inputSchema.properties).toHaveProperty("tier");
    for (const t of tools) expect(t.description).toBeTruthy();
    await h.close();
  });
});

describe("d402_discover", () => {
  it("returns the d402 accept for a seller that offers it", async () => {
    const fake = makeFake();
    const h = await harness({ client: fake });
    const r = await h.call("d402_discover", { baseUrl: "https://api.example.com" });
    expect(r.isError).toBe(false);
    expect(r.data.sellerId).toBe("api.example.com");
    expect(r.data.taskUrl).toBe(ACCEPT.taskUrl);
    expect(r.data.tiers).toHaveLength(3);
    expect(r.data.scope).toEqual(["/search"]);
    expect(r.structured.sellerId).toBe("api.example.com");
    expect(fake.log[0]).toEqual({ name: "discover", args: ["https://api.example.com"] });
    await h.close();
  });

  it("errors when the offer has no d402 scheme", async () => {
    const h = await harness({ client: makeFake({ discover: async () => X402_ONLY_OFFER }) });
    const r = await h.call("d402_discover", { baseUrl: "https://pay.example.com" });
    expect(r.isError).toBe(true);
    expect(r.data.message).toMatch(/does not offer d402/);
    expect(r.data.schemes).toEqual(["exact"]);
    await h.close();
  });

  it("errors when the well-known endpoint is missing (404)", async () => {
    const h = await harness({
      client: makeFake({
        discover: async () => {
          throw new FakeD402Error("bad_request", 404, undefined, "not found");
        },
      }),
    });
    const r = await h.call("d402_discover", { baseUrl: "https://plain.example.com" });
    expect(r.isError).toBe(true);
    expect(r.data.message).toMatch(/does not offer d402/);
    expect(r.data.code).toBe("no_d402");
    await h.close();
  });
});

describe("d402_get_bundle", () => {
  it("stores the bundle and returns it with a hint", async () => {
    const store = new Map<string, Bundle>();
    const fake = makeFake();
    const h = await harness({ client: fake, bundleStore: store });
    const r = await h.call("d402_get_bundle", { taskUrl: ACCEPT.taskUrl, tier: "m" });
    expect(r.isError).toBe(false);
    expect(r.data.bundleId).toBe("b_1");
    expect(r.data.labels).toEqual(["sports", "tech"]);
    expect(r.data.items).toHaveLength(2);
    expect(r.data.instructions).toBeTruthy();
    expect(r.data.expiresAt).toBe(NOW + 600);
    expect(r.data.hint).toMatch(/exactly one label/);
    expect(r.data.hint).toMatch(/d402_submit/);
    expect(store.get("b_1")?.tier).toBe("m");
    expect(fake.log[0]).toEqual({ name: "getBundle", args: [ACCEPT.taskUrl, "m"] });
    await h.close();
  });

  it("requires a tier when neither tier nor baseUrl is given", async () => {
    const fake = makeFake();
    const h = await harness({ client: fake });
    const r = await h.call("d402_get_bundle", { taskUrl: ACCEPT.taskUrl });
    expect(r.isError).toBe(true);
    expect(r.data.code).toBe("missing_tier");
    expect(r.data.message).toMatch(/tier/);
    expect(fake.log).toHaveLength(0);
    await h.close();
  });

  it("discovers via baseUrl and picks the smallest tier", async () => {
    const fake = makeFake();
    const h = await harness({ client: fake });
    const r = await h.call("d402_get_bundle", { baseUrl: "https://api.example.com" });
    expect(r.isError).toBe(false);
    expect(r.data.tier).toBe("s");
    expect(r.data.taskUrl).toBe(ACCEPT.taskUrl);
    expect(fake.log.map((l) => l.name)).toEqual(["discover", "getBundle"]);
    expect(fake.log[1]!.args).toEqual([ACCEPT.taskUrl, "s"]);
    await h.close();
  });

  it("uses the default tier from options", async () => {
    const fake = makeFake();
    const h = await harness({ client: fake, defaultTier: "l" });
    const r = await h.call("d402_get_bundle", { taskUrl: ACCEPT.taskUrl });
    expect(r.isError).toBe(false);
    expect(r.data.tier).toBe("l");
    await h.close();
  });

  it("passes seller errors through readably", async () => {
    const h = await harness({
      client: makeFake({
        getBundle: async () => {
          throw new FakeD402Error("no_tasks", 404, undefined, "pool empty");
        },
      }),
    });
    const r = await h.call("d402_get_bundle", { taskUrl: ACCEPT.taskUrl, tier: "s" });
    expect(r.isError).toBe(true);
    expect(r.data.code).toBe("no_tasks");
    expect(r.data.message).toMatch(/pool empty/);
    await h.close();
  });
});

describe("d402_submit", () => {
  it("rejects an unknown bundleId without calling the client", async () => {
    const fake = makeFake();
    const h = await harness({ client: fake });
    const r = await h.call("d402_submit", { taskUrl: ACCEPT.taskUrl, bundleId: "nope", answers: { i_1: "tech" } });
    expect(r.isError).toBe(true);
    expect(r.data.code).toBe("unknown_bundle");
    expect(r.data.message).toMatch(/d402_get_bundle/);
    expect(fake.log.filter((l) => l.name === "submit")).toHaveLength(0);
    await h.close();
  });

  it("rejects when an item has no answer, before calling the client", async () => {
    const fake = makeFake();
    const store = new Map<string, Bundle>([["b_1", makeBundle()]]);
    const h = await harness({ client: fake, bundleStore: store });
    const r = await h.call("d402_submit", { taskUrl: ACCEPT.taskUrl, bundleId: "b_1", answers: { i_1: "tech" } });
    expect(r.isError).toBe(true);
    expect(r.data.code).toBe("invalid_answers");
    expect(r.data.missing).toEqual(["i_2"]);
    expect(r.data.message).toMatch(/i_2/);
    expect(fake.log).toHaveLength(0);
    expect(store.has("b_1")).toBe(true);
    await h.close();
  });

  it("rejects a label that is not in the bundle's labels", async () => {
    const fake = makeFake();
    const store = new Map<string, Bundle>([["b_1", makeBundle()]]);
    const h = await harness({ client: fake, bundleStore: store });
    const r = await h.call("d402_submit", {
      taskUrl: ACCEPT.taskUrl,
      bundleId: "b_1",
      answers: { i_1: "tech", i_2: "football" },
    });
    expect(r.isError).toBe(true);
    expect(r.data.code).toBe("invalid_answers");
    expect(r.data.badLabels).toEqual([{ id: "i_2", label: "football" }]);
    expect(r.data.message).toMatch(/allowed: sports, tech/);
    expect(fake.log).toHaveLength(0);
    await h.close();
  });

  it("rejects answers for ids that are not in the bundle", async () => {
    const fake = makeFake();
    const store = new Map<string, Bundle>([["b_1", makeBundle()]]);
    const h = await harness({ client: fake, bundleStore: store });
    const r = await h.call("d402_submit", {
      taskUrl: ACCEPT.taskUrl,
      bundleId: "b_1",
      answers: { i_1: "tech", i_2: "sports", i_9: "tech" },
    });
    expect(r.isError).toBe(true);
    expect(r.data.unknownIds).toEqual(["i_9"]);
    expect(fake.log).toHaveLength(0);
    await h.close();
  });

  it("rejects an expired bundle and forgets it", async () => {
    const fake = makeFake();
    const store = new Map<string, Bundle>([["b_old", { ...makeBundle("b_old"), expiresAt: NOW - 1 }]]);
    const h = await harness({ client: fake, bundleStore: store });
    const r = await h.call("d402_submit", { taskUrl: ACCEPT.taskUrl, bundleId: "b_old", answers: { i_1: "tech", i_2: "sports" } });
    expect(r.isError).toBe(true);
    expect(r.data.code).toBe("expired_bundle");
    expect(store.has("b_old")).toBe(false);
    expect(fake.log).toHaveLength(0);
    await h.close();
  });

  it("signs and submits valid answers, returns the voucher summary and forgets the bundle", async () => {
    const fake = makeFake();
    const store = new Map<string, Bundle>([["b_1", makeBundle()]]);
    const h = await harness({ client: fake, bundleStore: store });
    const answers = { i_1: "tech", i_2: "sports" };
    const r = await h.call("d402_submit", { taskUrl: ACCEPT.taskUrl, bundleId: "b_1", answers });
    expect(r.isError).toBe(false);
    expect(r.data).toMatchObject({ jti: "v_1", calls: 10, scope: ["/search"], expiresAt: NOW + 86400, sellerId: "api.example.com" });
    expect(r.data.token).toBeUndefined();
    expect(fake.log).toHaveLength(1);
    expect(fake.log[0]!.name).toBe("submit");
    expect(fake.log[0]!.args[0]).toBe(ACCEPT.taskUrl);
    expect((fake.log[0]!.args[1] as Bundle).bundleId).toBe("b_1");
    expect(fake.log[0]!.args[2]).toEqual(answers);
    expect(store.has("b_1")).toBe(false);
    await h.close();
  });

  it("turns a 422 quality failure into a readable 'try another bundle' error", async () => {
    const store = new Map<string, Bundle>([["b_1", makeBundle()]]);
    const h = await harness({
      client: makeFake({
        submit: async () => {
          throw new FakeD402Error("quality", 422, { error: "quality", message: "bundle failed" });
        },
      }),
      bundleStore: store,
    });
    const r = await h.call("d402_submit", { taskUrl: ACCEPT.taskUrl, bundleId: "b_1", answers: { i_1: "tech", i_2: "sports" } });
    expect(r.isError).toBe(true);
    expect(r.data.code).toBe("quality");
    expect(r.data.status).toBe(422);
    expect(r.data.message).toMatch(/never reveals which items/);
    expect(r.data.message).toMatch(/d402_get_bundle/);
    expect(store.has("b_1")).toBe(false);
    await h.close();
  });
});

describe("d402_fetch", () => {
  it("returns status, selected headers and body", async () => {
    const fake = makeFake({
      fetch: (async (_url: string, init?: RequestInit) =>
        new Response(JSON.stringify({ q: "x", method: init?.method }), {
          status: 200,
          headers: { "content-type": "application/json", "D402-Calls-Remaining": "9", "x-secret": "no" },
        })) as unknown as typeof fetch,
    });
    const h = await harness({ client: fake });
    const r = await h.call("d402_fetch", { url: "https://api.example.com/search?q=x" });
    expect(r.isError).toBe(false);
    expect(r.data.status).toBe(200);
    expect(r.data.headers).toEqual({ "content-type": "application/json", "D402-Calls-Remaining": "9" });
    expect(JSON.parse(r.data.body)).toEqual({ q: "x", method: "GET" });
    expect(r.data.truncated).toBe(false);
    const f = fake.log.find((l) => l.name === "fetch")!;
    expect(f.args[0]).toBe("https://api.example.com/search?q=x");
    await h.close();
  });

  it("forwards method, headers and body", async () => {
    const fake = makeFake({ fetch: (async () => new Response("ok")) as unknown as typeof fetch });
    const h = await harness({ client: fake });
    await h.call("d402_fetch", { url: "https://api.example.com/search", method: "post", headers: { "x-a": "1" }, body: "{}" });
    const init = fake.log.find((l) => l.name === "fetch")!.args[1] as RequestInit;
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({ "x-a": "1" });
    expect(init.body).toBe("{}");
    await h.close();
  });

  it("truncates bodies at 64KB", async () => {
    const big = "a".repeat(70 * 1024);
    const h = await harness({ client: makeFake({ fetch: (async () => new Response(big)) as unknown as typeof fetch }) });
    const r = await h.call("d402_fetch", { url: "https://api.example.com/big" });
    expect(r.data.truncated).toBe(true);
    expect(r.data.body).toHaveLength(64 * 1024);
    expect(r.data.bodyBytes).toBe(70 * 1024);
    await h.close();
  });

  it("returns the offer with earn instructions on a 402 (autoEarn false)", async () => {
    const fake = makeFake({
      fetch: (async () =>
        new Response(JSON.stringify({ ...OFFER, error: "missing_voucher", message: "no voucher" }), {
          status: 402,
          headers: { "content-type": "application/json" },
        })) as unknown as typeof fetch,
    });
    const h = await harness({ client: fake });
    const r = await h.call("d402_fetch", { url: "https://api.example.com/search?q=x" });
    expect(r.isError).toBe(false);
    expect(r.data.status).toBe(402);
    expect(r.data.needsVoucher).toBe(true);
    expect(r.data.reason).toBe("missing_voucher");
    expect(r.data.offer.taskUrl).toBe(ACCEPT.taskUrl);
    expect(r.data.offer.tiers).toHaveLength(3);
    expect(r.data.instructions).toMatch(/d402_get_bundle/);
    expect(r.data.instructions).toMatch(/d402_submit/);
    expect(r.data.instructions).toContain(ACCEPT.taskUrl);
    expect(fake.log.map((l) => l.name)).toEqual(["discover", "fetch"]);
    await h.close();
  });

  it("handles a client that throws a D402Error carrying the offer on 402", async () => {
    const fake = makeFake({
      fetch: (async () => {
        throw new FakeD402Error("voucher_exhausted", 402, { ...OFFER, error: "voucher_exhausted" });
      }) as unknown as typeof fetch,
    });
    const h = await harness({ client: fake });
    const r = await h.call("d402_fetch", { url: "https://api.example.com/search" });
    expect(r.isError).toBe(false);
    expect(r.data.needsVoucher).toBe(true);
    expect(r.data.reason).toBe("voucher_exhausted");
    expect(r.data.offer.sellerId).toBe("api.example.com");
    await h.close();
  });

  it("returns a plain 402 when the offer has no d402 scheme", async () => {
    const fake = makeFake({
      discover: async () => X402_ONLY_OFFER,
      fetch: (async () => new Response(JSON.stringify(X402_ONLY_OFFER), { status: 402 })) as unknown as typeof fetch,
    });
    const h = await harness({ client: fake });
    const r = await h.call("d402_fetch", { url: "https://pay.example.com/x" });
    expect(r.isError).toBe(false);
    expect(r.data.status).toBe(402);
    expect(r.data.needsVoucher).toBeUndefined();
    expect(r.data.instructions).toBeUndefined();
    expect(JSON.parse(r.data.body)).toEqual(X402_ONLY_OFFER);
    await h.close();
  });

  it("autoEarn without a solver command errors clearly", async () => {
    const fake = makeFake({
      fetch: (async () => new Response(JSON.stringify(OFFER), { status: 402 })) as unknown as typeof fetch,
    });
    const h = await harness({ client: fake });
    const r = await h.call("d402_fetch", { url: "https://api.example.com/search", autoEarn: true });
    expect(r.isError).toBe(true);
    expect(r.data.code).toBe("no_solver");
    expect(r.data.message).toMatch(/D402_SOLVER_CMD/);
    expect(r.data.message).toMatch(/d402_get_bundle/);
    expect(fake.log.map((l) => l.name)).toEqual(["discover", "fetch"]);
    await h.close();
  });

  it("autoEarn with a solver earns a voucher and retries the request", async () => {
    let vouchers = 0;
    const fake = makeFake({
      fetch: (async () =>
        vouchers > 0
          ? new Response("results", { status: 200, headers: { "D402-Calls-Remaining": "9" } })
          : new Response(JSON.stringify(OFFER), { status: 402 })) as unknown as typeof fetch,
      submit: async () => {
        vouchers++;
        return makeVoucher();
      },
    });
    const solved: Bundle[] = [];
    const h = await harness({
      client: fake,
      defaultTier: "m",
      solver: async (b) => {
        solved.push(b);
        return Object.fromEntries(b.items.map((i) => [i.id, b.labels[0]!]));
      },
    });
    const r = await h.call("d402_fetch", { url: "https://api.example.com/search", autoEarn: true });
    expect(r.isError).toBe(false);
    expect(r.data.status).toBe(200);
    expect(r.data.body).toBe("results");
    expect(r.data.headers["D402-Calls-Remaining"]).toBe("9");
    expect(solved).toHaveLength(1);
    expect(fake.log.map((l) => l.name)).toEqual(["discover", "fetch", "getBundle", "submit", "fetch"]);
    expect(fake.log[2]!.args).toEqual([ACCEPT.taskUrl, "m"]);
    expect(fake.log[3]!.args[3]).toMatchObject({ sellerId: "api.example.com" });
    await h.close();
  });

  it("autoEarn gives up after maxEarnAttempts quality failures", async () => {
    const fake = makeFake({
      fetch: (async () => new Response(JSON.stringify(OFFER), { status: 402 })) as unknown as typeof fetch,
      submit: async () => {
        throw new FakeD402Error("quality", 422);
      },
    });
    const h = await harness({ client: fake, maxEarnAttempts: 2, solver: async (b) => ({ i_1: b.labels[0]!, i_2: b.labels[0]! }) });
    const r = await h.call("d402_fetch", { url: "https://api.example.com/search", autoEarn: true });
    expect(r.isError).toBe(true);
    expect(r.data.code).toBe("earn_failed");
    expect(fake.log.filter((l) => l.name === "submit")).toHaveLength(2);
    await h.close();
  });

  it("reports network errors from the client", async () => {
    const fake = makeFake({
      fetch: (async () => {
        throw new TypeError("fetch failed: ECONNREFUSED");
      }) as unknown as typeof fetch,
    });
    const h = await harness({ client: fake });
    const r = await h.call("d402_fetch", { url: "https://down.example.com/" });
    expect(r.isError).toBe(true);
    expect(r.data.message).toMatch(/ECONNREFUSED/);
    await h.close();
  });
});

describe("d402_status", () => {
  it("returns cached vouchers and the public key", async () => {
    const fake = makeFake({
      status: async () => [makeVoucher(), makeVoucher({ jti: "v_old", expiresAt: NOW - 5, calls: 0 })],
    });
    const store = new Map<string, Bundle>([["b_1", makeBundle()]]);
    const h = await harness({ client: fake, bundleStore: store });
    const r = await h.call("d402_status");
    expect(r.isError).toBe(false);
    expect(r.data.publicKey).toBe("PK");
    expect(r.data.vouchers).toHaveLength(2);
    expect(r.data.vouchers[0]).toEqual({
      jti: "v_1",
      sellerId: "api.example.com",
      calls: 10,
      expiresAt: NOW + 86400,
      scope: ["/search"],
      expired: false,
    });
    expect(r.data.vouchers[1].expired).toBe(true);
    expect(r.data.vouchers[0].token).toBeUndefined();
    expect(r.data.pendingBundles).toEqual(["b_1"]);
    expect(r.structured.publicKey).toBe("PK");
    await h.close();
  });
});

describe("validateAnswers", () => {
  it("accepts complete, well-labelled answers", () => {
    expect(validateAnswers(makeBundle(), { i_1: "tech", i_2: "sports" })).toBeUndefined();
  });
  it("reports every kind of problem at once", () => {
    expect(validateAnswers(makeBundle(), { i_1: "nope", i_3: "tech" })).toEqual({
      missing: ["i_2"],
      badLabels: [{ id: "i_1", label: "nope" }],
      unknownIds: ["i_3"],
    });
  });
});
