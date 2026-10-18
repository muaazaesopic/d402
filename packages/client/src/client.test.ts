import { describe, expect, it } from "vitest";
import { HEADERS, generateKeypair, verifySpend, verifySubmit, type D402Accept } from "@d402/spec";
import { createFakeSeller, type FakeSellerOptions } from "../test/fake-seller.js";
import { D402Error, MemoryVoucherCache, createD402Client, createLookupSolver, type D402ClientOptions } from "./index.js";

function setup(sellerOpts: FakeSellerOptions = {}, clientOpts: Partial<D402ClientOptions> = {}) {
  const seller = createFakeSeller(sellerOpts);
  const keypair = generateKeypair();
  const cache = new MemoryVoucherCache();
  const oracle = createLookupSolver((item) => seller.answerFor(item));
  const client = createD402Client({
    keypair,
    cache,
    solver: oracle,
    fetch: seller.fetch,
    ...clientOpts,
  });
  return { seller, keypair, cache, client, oracle };
}

const wrongSolver = (seller: ReturnType<typeof createFakeSeller>) =>
  createLookupSolver((item, bundle) => bundle.labels.find((l) => l !== seller.answerFor(item))!);

describe("discover", () => {
  it("GETs {base}/.well-known/d402 and returns the parsed offer", async () => {
    const { seller, client } = setup();
    const offer = await client.discover("https://api.test");
    expect(offer.d402).toBe("1");
    expect(seller.requests[0]!.url).toBe("https://api.test/.well-known/d402");
    expect(seller.requests[0]!.method).toBe("GET");
    expect(offer.accepts).toHaveLength(2);
  });

  it("uses a full well-known URL as is and strips trailing slashes from a base", async () => {
    const { seller, client } = setup();
    await client.discover("https://api.test/.well-known/d402");
    await client.discover("https://api.test/");
    expect(seller.requests.map((r) => r.url)).toEqual([
      "https://api.test/.well-known/d402",
      "https://api.test/.well-known/d402",
    ]);
  });

  it("throws bad_offer when the body is not an offer", async () => {
    const keypair = generateKeypair();
    const client = createD402Client({
      keypair,
      fetch: (async () => new Response("nope", { status: 404 })) as typeof fetch,
    });
    await expect(client.discover("https://api.test")).rejects.toMatchObject({ code: "bad_offer", status: 404 });
  });
});

describe("getBundle", () => {
  it("sends tier, D402-Key and D402-Model", async () => {
    const { seller, client, keypair } = setup({}, { model: "claude" });
    const bundle = await client.getBundle(seller.accept.taskUrl, "m");
    expect(bundle.items).toHaveLength(5);
    expect(bundle.tier).toBe("m");
    const req = seller.requests[0]!;
    expect(new URL(req.url).searchParams.get("tier")).toBe("m");
    expect(req.headers["d402-key"]).toBe(keypair.publicKey);
    expect(req.headers["d402-model"]).toBe("claude");
  });

  it("omits D402-Model when no model is configured", async () => {
    const { seller, client } = setup();
    await client.getBundle(seller.accept.taskUrl, "s");
    expect(seller.requests[0]!.headers["d402-model"]).toBeUndefined();
  });

  it("surfaces seller errors as D402Error with the seller's code", async () => {
    const { seller, client } = setup();
    await expect(client.getBundle(seller.accept.taskUrl, "zzz")).rejects.toMatchObject({
      code: "bad_tier",
      status: 400,
    });
  });
});

describe("submit", () => {
  it("signs with signSubmit, posts model, stores and returns the voucher", async () => {
    const { seller, client, keypair, cache, oracle } = setup({}, { model: "claude" });
    const bundle = await client.getBundle(seller.accept.taskUrl, "m");
    const answers = await oracle(bundle);
    const voucher = await client.submit(seller.accept.taskUrl, bundle, answers, seller.accept);

    const post = seller.requests[1]!;
    expect(post.method).toBe("POST");
    expect(post.url).toBe(`${seller.accept.taskUrl}/${bundle.bundleId}`);
    expect(post.headers["d402-key"]).toBe(keypair.publicKey);
    expect(post.headers["content-type"]).toBe("application/json");
    const body = JSON.parse(post.body!);
    expect(body.answers).toEqual(answers);
    expect(body.model).toBe("claude");
    expect(verifySubmit(keypair.publicKey, bundle.bundleId, answers, body.sig)).toBe(true);

    expect(voucher.sellerId).toBe("api.test");
    expect(voucher.calls).toBe(6);
    expect(voucher.scope).toEqual(["/search", "/echo"]);
    expect(voucher.sub).toBe(keypair.publicKey);
    expect(voucher.taskUrl).toBe(seller.accept.taskUrl);
    expect(voucher.jti).toMatch(/^v_/);
    expect(await cache.list()).toEqual([voucher]);
  });

  it("takes sellerId from the JWT iss claim when no accept is given", async () => {
    const { seller, client, oracle } = setup({ sellerId: "seller.example" });
    const bundle = await client.getBundle(seller.accept.taskUrl, "s");
    const voucher = await client.submit(seller.accept.taskUrl, bundle, await oracle(bundle));
    expect(voucher.sellerId).toBe("seller.example");
  });

  it("throws D402Error quality on 422", async () => {
    const { seller, client } = setup();
    const bundle = await client.getBundle(seller.accept.taskUrl, "m");
    const bad = await wrongSolver(seller)(bundle);
    await expect(client.submit(seller.accept.taskUrl, bundle, bad, seller.accept)).rejects.toMatchObject({
      code: "quality",
      status: 422,
    });
  });

  it("works without a solver configured", async () => {
    const { seller, oracle } = setup();
    const client = createD402Client({ keypair: generateKeypair(), fetch: seller.fetch });
    const bundle = await client.getBundle(seller.accept.taskUrl, "s");
    const v = await client.submit(seller.accept.taskUrl, bundle, await oracle(bundle), seller.accept);
    expect(v.calls).toBe(3);
  });
});

describe("earn", () => {
  it("getBundle -> solver -> submit returns a voucher", async () => {
    const { seller, client } = setup();
    const v = await client.earn(seller.accept);
    expect(v.calls).toBe(3); // default tier is the smallest: "s"
    expect(seller.bundlesIssued).toBe(1);
    expect(seller.submits).toBe(1);
  });

  it("retries on 422 quality up to maxEarnAttempts then throws earn_failed", async () => {
    const { seller, client } = setup({}, { maxEarnAttempts: 3 });
    const bad = createD402Client({
      keypair: client.keypair,
      fetch: seller.fetch,
      solver: wrongSolver(seller),
      maxEarnAttempts: 3,
    });
    const err = await bad.earn(seller.accept).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(D402Error);
    expect((err as D402Error).code).toBe("earn_failed");
    expect((err as D402Error).status).toBe(422);
    expect(seller.bundlesIssued).toBe(3);
    expect(seller.submits).toBe(3);
  });

  it("succeeds on a later attempt when an earlier bundle fails", async () => {
    const { seller, oracle } = setup();
    let calls = 0;
    const flaky = createD402Client({
      keypair: generateKeypair(),
      fetch: seller.fetch,
      solver: async (bundle) => (++calls === 1 ? wrongSolver(seller)(bundle) : oracle(bundle)),
    });
    const v = await flaky.earn(seller.accept);
    expect(v.calls).toBe(3);
    expect(seller.submits).toBe(2);
  });

  it("does not retry on non-quality errors", async () => {
    const { seller } = setup();
    const client = createD402Client({
      keypair: generateKeypair(),
      fetch: seller.fetch,
      solver: async (bundle) => ({ [bundle.items[0]!.id]: "sports" }), // incomplete
    });
    await expect(client.earn(seller.accept)).rejects.toMatchObject({ code: "incomplete" });
    expect(seller.submits).toBe(1);
  });

  it("throws no_solver without a solver", async () => {
    const { seller } = setup();
    const client = createD402Client({ keypair: generateKeypair(), fetch: seller.fetch });
    await expect(client.earn(seller.accept)).rejects.toMatchObject({ code: "no_solver" });
  });
});

describe("tier selection", () => {
  it("defaults to the tier with the fewest items", async () => {
    const { seller, client } = setup();
    await client.earn(seller.accept);
    expect(new URL(seller.requests[0]!.url).searchParams.get("tier")).toBe("s");
  });

  it("uses a string tier", async () => {
    const { seller, client } = setup({}, { tier: "l" });
    const v = await client.earn(seller.accept);
    expect(new URL(seller.requests[0]!.url).searchParams.get("tier")).toBe("l");
    expect(v.calls).toBe(20);
  });

  it("uses a tier chooser function given the accept", async () => {
    const seen: D402Accept[] = [];
    const { seller, client } = setup(
      {},
      {
        tier: (accept) => {
          seen.push(accept);
          return accept.tiers.reduce((a, b) => (b.reward.calls > a.reward.calls ? b : a)).id;
        },
      },
    );
    await client.earn(seller.accept);
    expect(seen).toHaveLength(1);
    expect(new URL(seller.requests[0]!.url).searchParams.get("tier")).toBe("l");
  });

  it("an explicit tier argument to earn wins", async () => {
    const { seller, client } = setup({}, { tier: "l" });
    await client.earn(seller.accept, "m");
    expect(new URL(seller.requests[0]!.url).searchParams.get("tier")).toBe("m");
  });

  it("rejects a tier the seller does not offer", async () => {
    const { seller, client } = setup({}, { tier: "xl" });
    await expect(client.earn(seller.accept)).rejects.toMatchObject({ code: "bad_tier" });
  });
});

describe("fetch wrapper", () => {
  it("earns on 402 and retries the original request once", async () => {
    const { seller, client } = setup();
    const res = await client.fetch("https://api.test/search?q=hello");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, path: "/search", q: "hello" });
    expect(seller.requests.map((r) => r.path)).toEqual([
      "/search",
      "/.well-known/d402/tasks",
      expect.stringMatching(/^\/\.well-known\/d402\/tasks\/b_/),
      "/search",
    ]);
    expect(seller.requests[0]!.headers["d402-voucher"]).toBeUndefined();
    expect(seller.requests[3]!.headers["d402-voucher"]).toBeDefined();
    expect(res.headers.get(HEADERS.callsRemaining)).toBe("2");
  });

  it("attaches a cached voucher and skips earning", async () => {
    const { seller, client, cache } = setup();
    await client.fetch("https://api.test/search?q=1");
    const before = seller.bundlesIssued;
    const res = await client.fetch("https://api.test/search?q=2");
    expect(res.status).toBe(200);
    expect(seller.bundlesIssued).toBe(before);
    const last = seller.requests.at(-1)!;
    expect(last.path).toBe("/search");
    expect(last.headers["d402-voucher"]).toBeDefined();
    const [v] = await cache.list();
    expect(v!.calls).toBe(1); // 3 - 2 spends, learnt from D402-Calls-Remaining
  });

  it("uses a voucher from the cache after discover() without ever seeing a 402", async () => {
    const { seller, client } = setup();
    await client.discover("https://api.test");
    await client.earn(seller.accept);
    const res = await client.fetch("https://api.test/search");
    expect(res.status).toBe(200);
    expect(seller.requests.filter((r) => r.path === "/search")).toHaveLength(1);
    expect(seller.requests.at(-1)!.headers["d402-voucher"]).toBeDefined();
  });

  it("evicts an exhausted voucher on 402 voucher_exhausted and re-earns", async () => {
    const { seller, client, cache } = setup();
    await client.fetch("https://api.test/search");
    const [v] = await cache.list();
    // Seller thinks the voucher is spent, client still believes it has calls.
    seller.vouchers.get(v!.jti)!.calls = 0;
    await cache.setCalls(v!.jti, 5);
    const res = await client.fetch("https://api.test/search");
    expect(res.status).toBe(200);
    const vouchers = await cache.list();
    expect(vouchers).toHaveLength(1);
    expect(vouchers[0]!.jti).not.toBe(v!.jti);
    expect(seller.bundlesIssued).toBe(2);
  });

  it("does not attach a voucher with no calls left (decremented via D402-Calls-Remaining)", async () => {
    const { seller, client } = setup();
    for (let i = 0; i < 3; i++) await client.fetch("https://api.test/search");
    expect(seller.bundlesIssued).toBe(1);
    const res = await client.fetch("https://api.test/search");
    expect(res.status).toBe(200);
    expect(seller.bundlesIssued).toBe(2);
    // /search requests: [bare, retry, cached, cached, bare, retry]
    const searches = seller.requests.filter((r) => r.path === "/search");
    expect(searches).toHaveLength(6);
    expect(searches[4]!.headers["d402-voucher"]).toBeUndefined();
    expect(searches[5]!.headers["d402-voucher"]).toBeDefined();
  });

  it("skips an expired voucher (injected now) and earns a fresh one", async () => {
    let t = 1_000_000;
    const now = () => t;
    const { seller, client, cache } = setup({ now, voucherTtl: 100 }, { now });
    await client.fetch("https://api.test/search");
    const [v] = await cache.list();
    expect(v!.expiresAt).toBe(1_000_100);
    t += 200;
    const res = await client.fetch("https://api.test/search");
    expect(res.status).toBe(200);
    expect(seller.bundlesIssued).toBe(2);
    const searches = seller.requests.filter((r) => r.path === "/search");
    expect(searches[2]!.headers["d402-voucher"]).toBeUndefined();
  });

  it("evicts a voucher the seller reports as expired", async () => {
    let sellerT = 1_000_000;
    const { seller, client, cache } = setup({ now: () => sellerT, voucherTtl: 100 }, { now: () => 1_000_000 });
    await client.fetch("https://api.test/search");
    const [old] = await cache.list();
    sellerT += 1000; // seller clock moves on; client clock does not, so it still attaches the voucher
    const res = await client.fetch("https://api.test/search");
    expect(res.status).toBe(200);
    const vouchers = await cache.list();
    expect(vouchers.map((v) => v.jti)).not.toContain(old!.jti);
  });

  it("does not use a voucher for a path outside its scope", async () => {
    const { seller, client, cache } = setup();
    await client.fetch("https://api.test/search");
    expect(await cache.list()).toHaveLength(1);
    const res = await client.fetch("https://api.test/admin");
    expect(res.status).toBe(402);
    const admin = seller.requests.filter((r) => r.path === "/admin");
    expect(admin).toHaveLength(2); // original + exactly one retry
    expect(admin[0]!.headers["d402-voucher"]).toBeUndefined();
    const body = await res.json();
    expect(body.error).toBe("scope_mismatch");
  });

  it("does not loop when the retry is also 402", async () => {
    const { seller, client } = setup();
    const res = await client.fetch("https://api.test/nope");
    expect(res.status).toBe(402);
    expect(seller.requests.filter((r) => r.path === "/nope")).toHaveLength(2);
    expect(seller.bundlesIssued).toBe(1);
  });

  it("passes through a 402 that offers no d402 scheme", async () => {
    const { seller, client } = setup();
    const res = await client.fetch("https://api.test/x402only");
    expect(res.status).toBe(402);
    expect(seller.requests).toHaveLength(1);
    const body = await res.json(); // body still readable
    expect(body.accepts[0].scheme).toBe("exact");
  });

  it("passes through a non-JSON 402", async () => {
    const { seller, client } = setup();
    const res = await client.fetch("https://api.test/text402");
    expect(res.status).toBe(402);
    expect(await res.text()).toBe("payment required");
    expect(seller.requests).toHaveLength(1);
  });

  it("returns non-402 responses untouched (including errors)", async () => {
    const { seller, client } = setup();
    const open = await client.fetch("https://api.test/open");
    expect(open.status).toBe(200);
    expect(seller.requests).toHaveLength(1);
    const fail = await client.fetch("https://api.test/search/fail");
    expect(fail.status).toBe(500);
  });

  it("replays method, body and headers on the retry", async () => {
    const { seller, client } = setup();
    const res = await client.fetch("https://api.test/echo", {
      method: "POST",
      headers: { "content-type": "text/plain", "x-custom": "yes" },
      body: "hello body",
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ method: "POST", body: "hello body", ct: "text/plain" });
    const echoes = seller.requests.filter((r) => r.path === "/echo");
    expect(echoes).toHaveLength(2);
    expect(echoes[1]!.headers["x-custom"]).toBe("yes");
    expect(echoes[1]!.body).toBe("hello body");
  });

  it("accepts URL and Request inputs", async () => {
    const { client } = setup();
    const r1 = await client.fetch(new URL("https://api.test/search?q=u"));
    expect(await r1.json()).toMatchObject({ q: "u" });
    const r2 = await client.fetch(new Request("https://api.test/echo", { method: "POST", body: "from request" }));
    expect(await r2.json()).toMatchObject({ method: "POST", body: "from request" });
  });

  it("throws unreplayable_body for a stream body instead of earning", async () => {
    const { seller, client } = setup();
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode("streamed"));
        c.close();
      },
    });
    const err = await client
      .fetch("https://api.test/echo", { method: "POST", body: stream, duplex: "half" } as RequestInit)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(D402Error);
    expect((err as D402Error).code).toBe("unreplayable_body");
    expect(seller.bundlesIssued).toBe(0);
  });

  it("propagates network errors as-is", async () => {
    const boom = new TypeError("fetch failed");
    const client = createD402Client({
      keypair: generateKeypair(),
      fetch: (async () => {
        throw boom;
      }) as typeof fetch,
    });
    await expect(client.fetch("https://api.test/search")).rejects.toBe(boom);
  });
});

describe("spend signing (SPEC 7.1)", () => {
  it("sends D402-Key, D402-Timestamp and a valid D402-Sig by default", async () => {
    const now = () => 1_700_000_000;
    const { seller, client, keypair } = setup({ now }, { now });
    await client.fetch("https://api.test/search?q=x");
    await client.fetch("https://api.test/search?q=y");
    const spend = seller.requests.filter((r) => r.path === "/search" && r.headers["d402-voucher"]);
    expect(spend).toHaveLength(2);
    for (const r of spend) {
      expect(r.headers["d402-key"]).toBe(keypair.publicKey);
      expect(r.headers["d402-timestamp"]).toBe("1700000000");
      expect(r.spendSig).toBe("valid");
      const jti = JSON.parse(Buffer.from(r.headers["d402-voucher"]!.split(".")[1]!, "base64url").toString()).jti;
      expect(verifySpend(keypair.publicKey, "GET", "/search", jti, 1_700_000_000, r.headers["d402-sig"]!)).toBe(true);
    }
  });

  it("works against a seller that binds vouchers", async () => {
    const { seller, client } = setup({ bindVouchers: true });
    const res = await client.fetch("https://api.test/search");
    expect(res.status).toBe(200);
    expect(seller.requests.at(-1)!.spendSig).toBe("valid");
  });

  it("omits the headers when signSpends is false", async () => {
    const { seller, client } = setup({}, { signSpends: false });
    const res = await client.fetch("https://api.test/search");
    expect(res.status).toBe(200);
    const spend = seller.requests.at(-1)!;
    expect(spend.headers["d402-voucher"]).toBeDefined();
    expect(spend.headers["d402-key"]).toBeUndefined();
    expect(spend.headers["d402-timestamp"]).toBeUndefined();
    expect(spend.headers["d402-sig"]).toBeUndefined();
    expect(spend.spendSig).toBe("missing");
  });
});

describe("status", () => {
  it("lists the cache", async () => {
    const { seller, client } = setup();
    expect(await client.status()).toEqual([]);
    const v = await client.earn(seller.accept);
    expect(await client.status()).toEqual([v]);
  });
});
