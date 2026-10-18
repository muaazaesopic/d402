/**
 * Happy-path flows: real @d402/server on an ephemeral port, real @d402/client
 * over real fetch.
 */
import { afterEach, describe, expect, it } from "vitest";
import { HEADERS, findD402Accept, generateKeypair, type Bundle } from "@d402/spec";
import { D402Error, MemoryVoucherCache } from "@d402/client";
import {
  LABELS,
  TIERS,
  honestSolver,
  newAgent,
  perfectSolver,
  rawJson,
  startSeller,
  wrongSolver,
  type Seller,
} from "./helpers.js";

const sellers: Seller[] = [];
async function seller(over: Parameters<typeof startSeller>[0] = {}): Promise<Seller> {
  const s = await startSeller(over);
  sellers.push(s);
  return s;
}
afterEach(async () => {
  while (sellers.length) await sellers.pop()!.close();
});

const tierCalls = (id: string) => TIERS.find((t) => t.id === id)!.reward.calls;

describe("fresh agent spends", () => {
  it("first fetch to a gated route earns a voucher and returns 200 with calls-1 remaining", async () => {
    const s = await seller();
    const agent = newAgent(s.baseUrl, { solver: perfectSolver(s.truth) });
    const res = await agent.fetch(`${s.baseUrl}/search?q=x`);
    expect(res.status).toBe(200);
    expect(res.headers.get(HEADERS.callsRemaining)).toBe(String(tierCalls("s") - 1));
    const body = (await res.json()) as { q: string; hits: unknown[] };
    expect(body.q).toBe("x");
    expect(body.hits.length).toBeGreaterThan(0);
  });

  it("a second fetch reuses the voucher and decrements", async () => {
    const s = await seller();
    const agent = newAgent(s.baseUrl, { solver: perfectSolver(s.truth) });
    await agent.fetch(`${s.baseUrl}/search?q=1`);
    const res = await agent.fetch(`${s.baseUrl}/search?q=2`);
    expect(res.status).toBe(200);
    expect(res.headers.get(HEADERS.callsRemaining)).toBe(String(tierCalls("s") - 2));
    expect(s.d402.agents.get(agent.keypair.publicKey)?.bundles).toBe(1);
  });

  it("the voucher shows up in client.status() with the seller id, scope and live call count", async () => {
    const s = await seller();
    const agent = newAgent(s.baseUrl, { solver: perfectSolver(s.truth) });
    await agent.fetch(`${s.baseUrl}/search?q=x`);
    const vouchers = await agent.status();
    expect(vouchers).toHaveLength(1);
    expect(vouchers[0]).toMatchObject({
      sellerId: "test-seller",
      scope: ["/search"],
      calls: tierCalls("s") - 1,
      sub: agent.keypair.publicKey,
      taskUrl: s.taskUrl,
    });
    expect(s.d402.vouchers.get(vouchers[0]!.jti)?.callsLeft).toBe(tierCalls("s") - 1);
  });

  it("ungated /health needs nothing", async () => {
    const s = await seller();
    const res = await fetch(`${s.baseUrl}/health`);
    expect(res.status).toBe(200);
    expect(res.headers.get(HEADERS.callsRemaining)).toBeNull();
  });

  it("a gated sub-path (/search/news) is covered by the same voucher", async () => {
    const s = await seller();
    const agent = newAgent(s.baseUrl, { solver: perfectSolver(s.truth) });
    const a = await agent.fetch(`${s.baseUrl}/search/news`);
    expect(a.status).toBe(200);
    expect(await a.json()).toMatchObject({ kind: "news" });
    const b = await agent.fetch(`${s.baseUrl}/search?q=x`);
    expect(b.headers.get(HEADERS.callsRemaining)).toBe(String(tierCalls("s") - 2));
    expect(s.d402.agents.get(agent.keypair.publicKey)?.bundles).toBe(1);
  });
});

describe("discover and earn", () => {
  it("discover() returns the offer with the 3 SPEC tiers and the seller's taskUrl", async () => {
    const s = await seller();
    const agent = newAgent(s.baseUrl, {});
    const offer = await agent.discover(s.baseUrl);
    expect(offer.d402).toBe("1");
    const accept = findD402Accept(offer)!;
    expect(accept.taskUrl).toBe(s.taskUrl);
    expect(accept.sellerId).toBe("test-seller");
    expect(accept.scope).toEqual(["/search"]);
    expect(accept.tiers.map((t) => [t.id, t.items, t.reward.calls])).toEqual([
      ["s", 5, 10],
      ["m", 25, 60],
      ["l", 50, 150],
    ]);
  });

  it("earn() with tier l yields a voucher worth 150 calls that spends", async () => {
    const s = await seller();
    const agent = newAgent(s.baseUrl, { solver: perfectSolver(s.truth) });
    const accept = findD402Accept(await agent.discover(s.baseUrl))!;
    const v = await agent.earn(accept, "l");
    expect(v.calls).toBe(150);
    expect(v.scope).toEqual(["/search"]);
    expect(s.d402.vouchers.get(v.jti)).toMatchObject({ callsLeft: 150, sub: agent.keypair.publicKey });
    const res = await agent.fetch(`${s.baseUrl}/search?q=x`);
    expect(res.headers.get(HEADERS.callsRemaining)).toBe("149");
    expect(s.d402.agents.get(agent.keypair.publicKey)?.bundles).toBe(1);
  });

  it("getBundle returns tier-sized bundles with the seller's labels, unique ids and a future expiry", async () => {
    const s = await seller();
    const agent = newAgent(s.baseUrl, {});
    for (const tier of TIERS) {
      const b = await agent.getBundle(s.taskUrl, tier.id);
      expect(b.tier).toBe(tier.id);
      expect(b.type).toBe("classify");
      expect(b.items).toHaveLength(tier.items);
      expect(new Set(b.items.map((i) => i.id)).size).toBe(tier.items);
      expect(b.labels).toEqual([...LABELS]);
      expect(b.labels.length).toBeGreaterThanOrEqual(2);
      expect(b.labels.length).toBeLessThanOrEqual(4);
      expect(b.expiresAt).toBe(s.clock.t + 600);
      for (const it of b.items) expect(s.truth.has(it.id)).toBe(true);
    }
  });

  it("bundle items are shuffled: not golden-first, not id-sorted, and ordered differently per key", async () => {
    const s = await seller();
    const a = newAgent(s.baseUrl, {});
    const b = newAgent(s.baseUrl, {});
    const ba = await a.getBundle(s.taskUrl, "l");
    const bb = await b.getBundle(s.taskUrl, "l");

    const isSorted = (ids: string[]) => ids.every((id, i) => i === 0 || ids[i - 1]! <= id);
    expect(isSorted(ba.items.map((i) => i.id))).toBe(false);

    // The helper pool tells us which ids are golden; the agent cannot. The
    // goldens must not sit in a contiguous prefix (or suffix).
    const flags = ba.items.map((i) => s.goldenIds.has(i.id));
    const g = flags.filter(Boolean).length;
    expect(g).toBeGreaterThan(0);
    expect(flags.slice(0, g).every(Boolean)).toBe(false);
    expect(flags.slice(-g).every(Boolean)).toBe(false);

    // Both first bundles draw unknowns from the same fewest-votes-first pool,
    // so they share ids; the shared ids must not come out in the same order.
    const idsA = ba.items.map((i) => i.id);
    const setB = new Set(bb.items.map((i) => i.id));
    const sharedInA = idsA.filter((id) => setB.has(id));
    const sharedInB = bb.items.map((i) => i.id).filter((id) => sharedInA.includes(id));
    expect(sharedInA.length).toBeGreaterThan(5);
    expect(sharedInA).not.toEqual(sharedInB);
  });

  it("the submit result's voucher is a JWT whose claims match SPEC 6", async () => {
    const s = await seller();
    const agent = newAgent(s.baseUrl, { solver: perfectSolver(s.truth) });
    const accept = findD402Accept(await agent.discover(s.baseUrl))!;
    const v = await agent.earn(accept, "s");
    const claims = JSON.parse(Buffer.from(v.token.split(".")[1]!, "base64url").toString()) as Record<string, unknown>;
    expect(claims).toMatchObject({
      iss: "test-seller",
      sub: agent.keypair.publicKey,
      scope: ["/search"],
      jti: v.jti,
      iat: s.clock.t,
      exp: s.clock.t + 86_400,
    });
    expect(v.expiresAt).toBe(s.clock.t + 86_400);
  });
});

describe("quality", () => {
  it("a solver that is wrong on every item fails with earn_failed after maxEarnAttempts bundles", async () => {
    const s = await seller();
    const agent = newAgent(s.baseUrl, { solver: wrongSolver(s.truth), maxEarnAttempts: 3 });
    const accept = findD402Accept(await agent.discover(s.baseUrl))!;
    let err: unknown;
    try {
      await agent.earn(accept, "s");
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(D402Error);
    expect((err as D402Error).code).toBe("earn_failed");
    expect((err as D402Error).status).toBe(422);
    const rec = s.d402.agents.get(agent.keypair.publicKey)!;
    expect(rec.bundles).toBe(3);
    expect(rec.goldenSeen).toBe(6); // 2 goldens per 5-item bundle at the 40% ratio
    expect(rec.goldenCorrect).toBe(0);
    expect(rec.accuracy).toBeCloseTo(1 / 8);
    expect(rec.accuracy).toBeLessThan(0.5);
    expect(await agent.status()).toEqual([]);
    expect(s.d402.tasks.stats().vouchers).toBe(0);
  });

  it("fetch() surfaces earn_failed as a thrown D402Error rather than a response", async () => {
    const s = await seller();
    const agent = newAgent(s.baseUrl, { solver: wrongSolver(s.truth), maxEarnAttempts: 2 });
    await expect(agent.fetch(`${s.baseUrl}/search?q=x`)).rejects.toMatchObject({ code: "earn_failed" });
    expect(s.d402.agents.get(agent.keypair.publicKey)?.bundles).toBe(2);
  });

  it("accuracy falls across failed bundles and the record is visible via agents.list()", async () => {
    const s = await seller();
    const agent = newAgent(s.baseUrl, { solver: wrongSolver(s.truth), maxEarnAttempts: 1 });
    const accept = findD402Accept(await agent.discover(s.baseUrl))!;
    const seen: number[] = [];
    for (let i = 0; i < 3; i++) {
      await agent.earn(accept, "s").catch(() => undefined);
      seen.push(s.d402.agents.get(agent.keypair.publicKey)!.accuracy);
    }
    expect(seen[0]).toBeGreaterThan(seen[1]!);
    expect(seen[1]).toBeGreaterThan(seen[2]!);
    expect(s.d402.agents.list().map((a) => a.publicKey)).toContain(agent.keypair.publicKey);
  });

  it("an honest p=0.9 solver passes at least 80% of 30 tier-m earns", async () => {
    const s = await seller({ bundlesPerKeyPerHour: 1000, poolSize: 1200 });
    const agent = newAgent(s.baseUrl, { solver: honestSolver(s.truth, 0.9, 11), maxEarnAttempts: 1 });
    const accept = findD402Accept(await agent.discover(s.baseUrl))!;
    let passed = 0;
    for (let i = 0; i < 30; i++) {
      try {
        await agent.earn(accept, "m");
        passed++;
      } catch (e) {
        expect((e as D402Error).code).toBe("earn_failed");
      }
    }
    expect(passed / 30).toBeGreaterThanOrEqual(0.8);
    const rec = s.d402.agents.get(agent.keypair.publicKey)!;
    expect(rec.bundles).toBe(30);
    expect(rec.accuracy).toBeGreaterThan(0.8);
    expect(rec.blocked).toBe(false);
    expect((await agent.status()).length).toBe(passed);
  });
});

describe("resolution", () => {
  it("resolves unknown items once 3 honest agents with distinct keys and models have labelled, with >= 0.9 accuracy", async () => {
    const s = await seller({ bundlesPerIpPerHour: 1000 });
    const models = ["claude", "gpt", "gemini"];
    const agents = models.map((model, i) =>
      newAgent(s.baseUrl, { solver: honestSolver(s.truth, 0.9, 100 + i), model, maxEarnAttempts: 1 }),
    );
    const accept = findD402Accept(await agents[0]!.discover(s.baseUrl))!;

    // one agent alone can never resolve anything (needs 2 keys and weight >= 2)
    for (let i = 0; i < 6; i++) await agents[0]!.earn(accept, "m").catch(() => undefined);
    expect(s.d402.tasks.stats().resolved).toBe(0);

    for (let round = 0; round < 20; round++) {
      for (const a of agents) await a.earn(accept, "m").catch(() => undefined);
    }
    const stats = s.d402.tasks.stats();
    expect(stats.resolved).toBeGreaterThan(0);
    expect(stats.unknownOpen).toBe(stats.total - stats.golden - stats.resolved);

    const resolved = s.d402.tasks.exportResolved();
    expect(resolved.length).toBe(stats.resolved);
    const right = resolved.filter((r) => r.answer === s.truth.get(r.id)).length;
    expect(right / resolved.length).toBeGreaterThanOrEqual(0.9);
    for (const r of resolved) {
      expect(r.voters).toBeGreaterThanOrEqual(2);
      expect(r.weight).toBeGreaterThanOrEqual(2);
      expect(s.goldenIds.has(r.id)).toBe(false);
    }
  });

  it("requireModelFamilies: three agents all declaring 'gpt' resolve nothing; claude/gpt/gemini resolve", async () => {
    const run = async (models: string[]) => {
      const s = await seller({ requireModelFamilies: true, bundlesPerIpPerHour: 1000 });
      const agents = models.map((model, i) =>
        newAgent(s.baseUrl, { solver: perfectSolver(s.truth), model, maxEarnAttempts: 1 }),
      );
      const accept = findD402Accept(await agents[0]!.discover(s.baseUrl))!;
      for (let round = 0; round < 20; round++) {
        for (const a of agents) await a.earn(accept, "m");
      }
      for (const a of agents) {
        const rec = s.d402.agents.get(a.keypair.publicKey)!;
        expect(rec.bundles).toBe(20);
        expect(rec.model).toBe(models[agents.indexOf(a)]);
      }
      return s.d402.tasks.stats();
    };
    const same = await run(["gpt", "gpt", "gpt"]);
    expect(same.resolved).toBe(0);
    const mixed = await run(["claude", "gpt", "gemini"]);
    expect(mixed.resolved).toBeGreaterThan(0);
  });
});

describe("exhaustion and re-earn", () => {
  it("calls remaining counts down to 0, then the next fetch re-earns and succeeds with a fresh jti", async () => {
    const s = await seller();
    const agent = newAgent(s.baseUrl, { solver: perfectSolver(s.truth) });
    const first = await agent.fetch(`${s.baseUrl}/search?q=0`);
    const firstJti = (await agent.status())[0]!.jti;
    expect(first.headers.get(HEADERS.callsRemaining)).toBe("9");
    for (let i = 1; i < 10; i++) {
      const r = await agent.fetch(`${s.baseUrl}/search?q=${i}`);
      expect(r.status).toBe(200);
      expect(r.headers.get(HEADERS.callsRemaining)).toBe(String(9 - i));
    }
    expect(s.d402.vouchers.get(firstJti)?.callsLeft).toBe(0);
    expect(s.d402.agents.get(agent.keypair.publicKey)?.bundles).toBe(1);

    const again = await agent.fetch(`${s.baseUrl}/search?q=again`);
    expect(again.status).toBe(200);
    expect(again.headers.get(HEADERS.callsRemaining)).toBe("9");
    expect(s.d402.agents.get(agent.keypair.publicKey)?.bundles).toBe(2);
    const live = (await agent.status()).filter((v) => v.calls > 0);
    expect(live).toHaveLength(1);
    expect(live[0]!.jti).not.toBe(firstJti);
  });

  it("evicts a voucher the seller reports as exhausted and re-earns", async () => {
    const s = await seller();
    const cache = new MemoryVoucherCache();
    const agent = newAgent(s.baseUrl, { solver: perfectSolver(s.truth), cache });
    await agent.fetch(`${s.baseUrl}/search?q=0`);
    const jti = (await cache.list())[0]!.jti;
    for (let i = 1; i < 10; i++) await agent.fetch(`${s.baseUrl}/search?q=${i}`);
    // Lie to the client: pretend the voucher still has calls so it gets sent.
    await cache.setCalls(jti, 5);
    const res = await agent.fetch(`${s.baseUrl}/search?q=x`);
    expect(res.status).toBe(200);
    const left = await cache.list();
    expect(left.map((v) => v.jti)).not.toContain(jti);
    expect(left).toHaveLength(1);
    expect(left[0]!.calls).toBe(9);
  });
});

describe("scope", () => {
  it("a gated route outside the voucher scope returns 402 scope_mismatch and the client does not loop", async () => {
    const s = await seller();
    s.app.use("/other", s.d402.gate);
    s.app.get("/other", (c) => c.json({ other: true }));

    const agent = newAgent(s.baseUrl, { solver: perfectSolver(s.truth) });
    const ok = await agent.fetch(`${s.baseUrl}/search?q=x`);
    expect(ok.status).toBe(200);
    const jti = (await agent.status())[0]!.jti;

    const res = await agent.fetch(`${s.baseUrl}/other`);
    expect(res.status).toBe(402);
    const body = (await res.json()) as { error: string; accepts: unknown[] };
    // The client never attaches the /search voucher to /other (scope mismatch on
    // its side), and the offer's scope says /other is not purchasable, so it hands
    // the seller's bare 402 back without earning.
    expect(body.error).toBe("missing_voucher");
    expect(findD402Accept(body as never)).toBeDefined();

    // the /search voucher was not touched
    expect(s.d402.vouchers.get(jti)?.callsLeft).toBe(9);
    const after = await agent.fetch(`${s.baseUrl}/search?q=y`);
    expect(after.status).toBe(200);
    // exactly one bundle was ever earned: none was wasted on /other
    expect(s.d402.agents.get(agent.keypair.publicKey)!.bundles).toBe(1);
  });

  it("a hand-made spend on /other with a valid /search voucher is scope_mismatch", async () => {
    const s = await seller();
    s.app.use("/other", s.d402.gate);
    s.app.get("/other", (c) => c.json({ other: true }));
    const agent = newAgent(s.baseUrl, { solver: perfectSolver(s.truth) });
    const accept = findD402Accept(await agent.discover(s.baseUrl))!;
    const v = await agent.earn(accept);
    const res = await fetch(`${s.baseUrl}/other`, { headers: { [HEADERS.voucher]: v.token } });
    expect(res.status).toBe(402);
    expect(((await res.json()) as { error: string }).error).toBe("scope_mismatch");
    expect(s.d402.vouchers.get(v.jti)?.callsLeft).toBe(10);
  });
});

describe("offer body", () => {
  it("otherAccepts (x402 exact) is passed through in the 402 body and the client still earns via d402", async () => {
    const x402 = { scheme: "exact", network: "base", amount: "7000" };
    const s = await seller({ otherAccepts: [x402] });
    const bare = await fetch(`${s.baseUrl}/search?q=x`);
    expect(bare.status).toBe(402);
    const body = (await bare.json()) as { accepts: Array<{ scheme: string }>; error: string };
    expect(body.error).toBe("missing_voucher");
    expect(body.accepts.map((a) => a.scheme)).toEqual(["d402", "exact"]);
    expect(body.accepts[1]).toEqual(x402);

    const agent = newAgent(s.baseUrl, { solver: perfectSolver(s.truth) });
    const res = await agent.fetch(`${s.baseUrl}/search?q=x`);
    expect(res.status).toBe(200);
    expect(res.headers.get(HEADERS.callsRemaining)).toBe("9");
  });

  it("GET /.well-known/d402 equals the 402 body minus the error fields", async () => {
    const s = await seller({ otherAccepts: [{ scheme: "exact", network: "base", amount: "1" }] });
    const wk = await rawJson<Record<string, unknown>>(await fetch(`${s.baseUrl}/.well-known/d402`));
    expect(wk.status).toBe(200);
    const gated = await rawJson<Record<string, unknown>>(await fetch(`${s.baseUrl}/search?q=x`));
    expect(gated.status).toBe(402);
    expect(gated.body.error).toBe("missing_voucher");
    expect(typeof gated.body.message).toBe("string");
    const { error: _e, message: _m, ...rest } = gated.body;
    expect(wk.body).toEqual(rest);
    expect(wk.body.error).toBeUndefined();
  });

  it("the client's discover() of the well-known URL and of the base URL agree", async () => {
    const s = await seller();
    const agent = newAgent(s.baseUrl, {});
    expect(await agent.discover(s.baseUrl)).toEqual(await agent.discover(`${s.baseUrl}/.well-known/d402`));
  });
});

describe("POST body replay", () => {
  it("a POST with a JSON body is replayed after earning and the server receives the body", async () => {
    const s = await seller();
    const agent = newAgent(s.baseUrl, { solver: perfectSolver(s.truth) });
    const res = await agent.fetch(`${s.baseUrl}/search`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-trace": "abc" },
      body: JSON.stringify({ q: "posted", n: 3 }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get(HEADERS.callsRemaining)).toBe("9");
    expect(await res.json()).toMatchObject({ q: "posted", viaPost: true });
    // the gate rejected the first attempt before the handler ran, so exactly one body arrived
    expect(s.received).toEqual([{ q: "posted", n: 3 }]);
  });

  it("a POST built as a Request object is buffered and replayed too", async () => {
    const s = await seller();
    const agent = newAgent(s.baseUrl, { solver: perfectSolver(s.truth) });
    const req = new Request(`${s.baseUrl}/search`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ q: "req" }),
    });
    const res = await agent.fetch(req);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ q: "req", viaPost: true });
    expect(s.received).toEqual([{ q: "req" }]);
  });
});

describe("model header", () => {
  it("D402-Model is recorded on the agent and survives later bundles without it", async () => {
    const s = await seller();
    const kp = generateKeypair();
    const withModel = newAgent(s.baseUrl, { solver: perfectSolver(s.truth), model: "claude", keypair: kp });
    const accept = findD402Accept(await withModel.discover(s.baseUrl))!;
    await withModel.earn(accept);
    expect(s.d402.agents.get(kp.publicKey)?.model).toBe("claude");
    const without = newAgent(s.baseUrl, { solver: perfectSolver(s.truth), keypair: kp });
    await without.earn(accept);
    expect(s.d402.agents.get(kp.publicKey)).toMatchObject({ model: "claude", bundles: 2 });
  });

  it("a bundle fetched by the client parses against the spec Bundle schema", async () => {
    const s = await seller();
    const agent = newAgent(s.baseUrl, {});
    const b: Bundle = await agent.getBundle(s.taskUrl, "s");
    expect(b.instructions).toBe("Label each item with exactly one of the labels.");
    expect(b.bundleId.startsWith("b_")).toBe(true);
  });
});
