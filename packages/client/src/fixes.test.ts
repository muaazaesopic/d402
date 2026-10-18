import { describe, expect, it } from "vitest";
import { HEADERS, generateKeypair } from "@d402/spec";
import { createFakeSeller } from "../test/fake-seller.js";
import { MemoryVoucherCache, createD402Client, createLookupSolver } from "./index.js";

function setup(sellerOpts: Parameters<typeof createFakeSeller>[0] = {}) {
  const seller = createFakeSeller(sellerOpts);
  const keypair = generateKeypair();
  const cache = new MemoryVoucherCache();
  const client = createD402Client({
    keypair,
    cache,
    solver: createLookupSolver((item) => seller.answerFor(item)),
    fetch: seller.fetch,
  });
  return { seller, keypair, cache, client };
}

describe("spend nonce (SPEC 7.2)", () => {
  it("sends a fresh D402-Nonce on every signed spend and the signature covers it", async () => {
    const { seller, client } = setup({ bindVouchers: true });
    const r1 = await client.fetch("https://api.test/search?q=1");
    const r2 = await client.fetch("https://api.test/search?q=2");
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    const spends = seller.requests.filter((r) => r.spendSig !== undefined);
    expect(spends.length).toBeGreaterThanOrEqual(2);
    for (const s of spends) {
      expect(s.spendSig).toBe("valid");
      expect(s.spendNonce).toHaveLength(22);
    }
    const nonces = new Set(spends.map((s) => s.spendNonce));
    expect(nonces.size).toBe(spends.length);
  });

  it("sends no nonce header when signSpends is false", async () => {
    const seller = createFakeSeller();
    const client = createD402Client({
      keypair: generateKeypair(),
      solver: createLookupSolver((item) => seller.answerFor(item)),
      fetch: seller.fetch,
      signSpends: false,
    });
    expect((await client.fetch("https://api.test/search")).status).toBe(200);
    const spend = seller.requests.find((r) => r.spendSig !== undefined)!;
    expect(spend.spendSig).toBe("missing");
    expect(spend.spendNonce).toBeUndefined();
  });
});

describe("no earn for out-of-scope paths", () => {
  it("returns the 402 without fetching a bundle when the offer's scope excludes the path", async () => {
    const { seller, client } = setup({ scope: ["/search"] });
    const res = await client.fetch("https://api.test/other");
    expect(res.status).toBe(402);
    expect(seller.bundlesIssued).toBe(0);
    expect(seller.submits).toBe(0);
    expect(await client.status()).toHaveLength(0);
  });

  it("still earns for in-scope paths on the same origin afterwards", async () => {
    const { seller, client } = setup({ scope: ["/search"] });
    await client.fetch("https://api.test/other");
    const ok = await client.fetch("https://api.test/search?q=x");
    expect(ok.status).toBe(200);
    expect(seller.bundlesIssued).toBe(1);
  });
});

describe("cached voucher on an unseen origin", () => {
  it("a solver-less client with a persisted voucher spends it on the first request, no discover() needed", async () => {
    const { seller, keypair, cache, client } = setup();
    expect((await client.fetch("https://api.test/search?q=1")).status).toBe(200);
    const requestsBefore = seller.requests.length;

    const fresh = createD402Client({ keypair, cache, fetch: seller.fetch }); // no solver, new accepts map
    const res = await fresh.fetch("https://api.test/search?q=2");
    expect(res.status).toBe(200);
    expect(res.headers.get(HEADERS.callsRemaining)).toBeDefined();
    // exactly one request: the spend itself, no 402 round trip and no bundle
    expect(seller.requests.length - requestsBefore).toBe(1);
    expect(seller.bundlesIssued).toBe(1);
  });

  it("after a 402 teaches a cold client the seller, it tries the cache before earning", async () => {
    // Voucher earned against sellerId "api" via origin A; the same seller is then reached
    // through origin B (taskUrl origin differs, so findByOrigin misses). The 402 from B
    // names the sellerId, and the cached voucher must be tried before any bundle.
    const seller = createFakeSeller({ origin: "https://a.test", sellerId: "api" });
    const keypair = generateKeypair();
    const cache = new MemoryVoucherCache();
    const warm = createD402Client({ keypair, cache, fetch: seller.fetch, solver: createLookupSolver((i) => seller.answerFor(i)) });
    expect((await warm.fetch("https://a.test/search")).status).toBe(200);
    const sellerB = createFakeSeller({ origin: "https://b.test", sellerId: "api" });
    // give seller B the voucher state of seller A so the token is valid there
    for (const [jti, v] of seller.vouchers) sellerB.vouchers.set(jti, v);
    const cold = createD402Client({ keypair, cache, fetch: sellerB.fetch }); // no solver
    const res = await cold.fetch("https://b.test/search?q=2");
    expect(res.status).toBe(200);
    expect(sellerB.bundlesIssued).toBe(0);
  });

  it("does not use a cached voucher for a path outside its scope or on another origin", async () => {
    const { seller, keypair, cache, client } = setup({ scope: ["/search"] });
    expect((await client.fetch("https://api.test/search")).status).toBe(200);
    const fresh = createD402Client({ keypair, cache, fetch: seller.fetch });
    const out = await fresh.fetch("https://api.test/other");
    expect(out.status).toBe(402);
    const spendsToOther = seller.requests.filter((r) => r.url.includes("/other") && r.spendSig !== undefined);
    expect(spendsToOther).toHaveLength(0);
    const other = createFakeSeller({ origin: "https://elsewhere.test", sellerId: "elsewhere" });
    const c2 = createD402Client({ keypair, cache, fetch: other.fetch });
    await expect(c2.fetch("https://elsewhere.test/search")).rejects.toMatchObject({ code: "no_solver" });
  });
});
