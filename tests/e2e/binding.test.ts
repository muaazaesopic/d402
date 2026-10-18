/**
 * SPEC 7.1 bound spending (bindVouchers: true) over the real stack.
 */
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULTS, HEADERS, findD402Accept, generateKeypair, newNonce, signSpend } from "@d402/spec";
import { newAgent, perfectSolver, rawSpend, startSeller, type Seller } from "./helpers.js";

const sellers: Seller[] = [];
async function seller(over: Parameters<typeof startSeller>[0] = {}): Promise<Seller> {
  const s = await startSeller({ bindVouchers: true, ...over });
  sellers.push(s);
  return s;
}
afterEach(async () => {
  while (sellers.length) await sellers.pop()!.close();
});

/** Earn a voucher with the client (its clock follows the seller's) and return the pieces a raw spend needs. */
async function earned(s: Seller) {
  const kp = generateKeypair();
  const agent = newAgent(s.baseUrl, { solver: perfectSolver(s.truth), keypair: kp, now: () => s.clock.t });
  const accept = findD402Accept(await agent.discover(s.baseUrl))!;
  const v = await agent.earn(accept);
  return { kp, agent, v };
}

function signedHeaders(kp: { publicKey: string; privateKey: string }, jti: string, ts: number, method = "GET", path = "/search") {
  return {
    [HEADERS.key]: kp.publicKey,
    [HEADERS.timestamp]: String(ts),
    [HEADERS.sig]: signSpend(kp.privateKey, method, path, jti, ts),
  };
}

describe("bindVouchers: client", () => {
  it("the client's default signSpends=true spends successfully", async () => {
    const s = await seller();
    const agent = newAgent(s.baseUrl, { solver: perfectSolver(s.truth), now: () => s.clock.t });
    const res = await agent.fetch(`${s.baseUrl}/search?q=x`);
    expect(res.status).toBe(200);
    expect(res.headers.get(HEADERS.callsRemaining)).toBe("9");
    const again = await agent.fetch(`${s.baseUrl}/search/news`);
    expect(again.status).toBe(200);
    expect(again.headers.get(HEADERS.callsRemaining)).toBe("8");
  });

  it("signSpends=false gets a 402 and the client returns it without looping", async () => {
    const s = await seller();
    const agent = newAgent(s.baseUrl, { solver: perfectSolver(s.truth), signSpends: false, now: () => s.clock.t });
    const res = await agent.fetch(`${s.baseUrl}/search?q=x`);
    expect(res.status).toBe(402);
    const body = (await res.json()) as { error: string };
    // The server checks D402-Key first, so a spend with no binding headers at
    // all is reported as bad_key (not bad_signature / stale_timestamp).
    expect(["bad_key", "bad_signature", "stale_timestamp"]).toContain(body.error);
    expect(body.error).toBe("bad_key");
    // the fetch wrapper earns at most once per call: first 402 -> earn -> second 402 -> return
    expect(s.d402.agents.get(agent.keypair.publicKey)!.bundles).toBe(1);
    // nothing was spent
    for (const v of await agent.status()) expect(s.d402.vouchers.get(v.jti)?.callsLeft).toBe(10);
  });

  it("a bound spend with POST signs the method too", async () => {
    const s = await seller();
    const agent = newAgent(s.baseUrl, { solver: perfectSolver(s.truth), now: () => s.clock.t });
    const res = await agent.fetch(`${s.baseUrl}/search`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ q: "bound" }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ q: "bound", viaPost: true });
  });
});

describe("bindVouchers: hand-made spends", () => {
  it("a correctly signed spend succeeds", async () => {
    const s = await seller();
    const { kp, v } = await earned(s);
    const res = await rawSpend(s, v.token, "/search?q=x", signedHeaders(kp, v.jti, s.clock.t));
    expect(res.status).toBe(200);
    expect(res.headers.get(HEADERS.callsRemaining)).toBe("9");
  });

  it("a bare voucher without binding headers is 402 bad_key", async () => {
    const s = await seller();
    const { v } = await earned(s);
    const res = await rawSpend(s, v.token);
    expect(res.status).toBe(402);
    expect(res.body.error).toBe("bad_key");
    expect(s.d402.vouchers.get(v.jti)?.callsLeft).toBe(10);
  });

  it("a D402-Key that is not the voucher subject is 402 bad_key even with a valid signature by that key", async () => {
    const s = await seller();
    const { v } = await earned(s);
    const thief = generateKeypair();
    const res = await rawSpend(s, v.token, "/search?q=x", signedHeaders(thief, v.jti, s.clock.t));
    expect(res.status).toBe(402);
    expect(res.body.error).toBe("bad_key");
  });

  it("a timestamp 400s old is 402 stale_timestamp", async () => {
    const s = await seller();
    const { kp, v } = await earned(s);
    const ts = s.clock.t - 400;
    const res = await rawSpend(s, v.token, "/search?q=x", signedHeaders(kp, v.jti, ts));
    expect(res.status).toBe(402);
    expect(res.body.error).toBe("stale_timestamp");
    expect(DEFAULTS.spendTimestampSkew).toBe(300);
  });

  it("a timestamp 400s in the future is also stale_timestamp; 299s either way is fine", async () => {
    const s = await seller();
    const { kp, v } = await earned(s);
    const future = await rawSpend(s, v.token, "/search?q=x", signedHeaders(kp, v.jti, s.clock.t + 400));
    expect(future.body.error).toBe("stale_timestamp");
    const early = await rawSpend(s, v.token, "/search?q=x", signedHeaders(kp, v.jti, s.clock.t - 299));
    expect(early.status).toBe(200);
    const late = await rawSpend(s, v.token, "/search?q=x", signedHeaders(kp, v.jti, s.clock.t + 299));
    expect(late.status).toBe(200);
  });

  it("a missing or non-numeric timestamp is stale_timestamp", async () => {
    const s = await seller();
    const { kp, v } = await earned(s);
    const h = signedHeaders(kp, v.jti, s.clock.t);
    const noTs = { ...h };
    delete (noTs as Record<string, string>)[HEADERS.timestamp];
    expect((await rawSpend(s, v.token, "/search?q=x", noTs)).body.error).toBe("stale_timestamp");
    expect((await rawSpend(s, v.token, "/search?q=x", { ...h, [HEADERS.timestamp]: "soon" })).body.error).toBe("stale_timestamp");
  });

  it("a signature over a different path is 402 bad_signature", async () => {
    const s = await seller();
    const { kp, v } = await earned(s);
    const res = await rawSpend(s, v.token, "/search?q=x", signedHeaders(kp, v.jti, s.clock.t, "GET", "/search/news"));
    expect(res.status).toBe(402);
    expect(res.body.error).toBe("bad_signature");
  });

  it("a signature over a different method, jti or timestamp is bad_signature", async () => {
    const s = await seller();
    const { kp, v } = await earned(s);
    const t = s.clock.t;
    const method = await rawSpend(s, v.token, "/search?q=x", signedHeaders(kp, v.jti, t, "POST", "/search"));
    expect(method.body.error).toBe("bad_signature");
    const jti = await rawSpend(s, v.token, "/search?q=x", signedHeaders(kp, "v_other", t));
    expect(jti.body.error).toBe("bad_signature");
    const ts = await rawSpend(s, v.token, "/search?q=x", { ...signedHeaders(kp, v.jti, t), [HEADERS.timestamp]: String(t + 1) });
    expect(ts.body.error).toBe("bad_signature");
    const missing = { ...signedHeaders(kp, v.jti, t) };
    delete (missing as Record<string, string>)[HEADERS.sig];
    expect((await rawSpend(s, v.token, "/search?q=x", missing)).body.error).toBe("bad_signature");
    expect(s.d402.vouchers.get(v.jti)?.callsLeft).toBe(10);
  });

  it("the signed path excludes the query string, so the same headers work for any query", async () => {
    const s = await seller();
    const { kp, v } = await earned(s);
    const h = signedHeaders(kp, v.jti, s.clock.t);
    expect((await rawSpend(s, v.token, "/search?q=one", h)).status).toBe(200);
    expect((await rawSpend(s, v.token, "/search?q=two&page=2", h)).status).toBe(200);
  });

  it("a nonce-signed spend (SPEC 7.2) cannot be replayed, and the client always sends one", async () => {
    const s = await seller();
    const { kp, v } = await earned(s);
    const nonce = newNonce();
    const h = { ...signedHeaders(kp, v.jti, s.clock.t), [HEADERS.nonce]: nonce };
    h[HEADERS.sig] = signSpend(kp.privateKey, "GET", "/search", v.jti, s.clock.t, nonce);
    const first = await rawSpend(s, v.token, "/search?q=x", h);
    expect(first.status).toBe(200);
    const replay = await rawSpend(s, v.token, "/search?q=x", h);
    expect(replay.status).toBe(402);
    expect(replay.body.error).toBe("replayed_spend");
    expect(s.d402.vouchers.get(v.jti)?.callsLeft).toBe(9);

    // the real client sends a nonce on every spend, so two identical requests both succeed
    const agent = newAgent(s.baseUrl, { solver: perfectSolver(s.truth), now: () => s.clock.t });
    expect((await agent.fetch(`${s.baseUrl}/search?q=y`)).status).toBe(200);
    expect((await agent.fetch(`${s.baseUrl}/search?q=y`)).status).toBe(200);
  });

  it("requireSpendNonce rejects the 5-line form outright", async () => {
    const s = await startSeller({ bindVouchers: true, requireSpendNonce: true } as never);
    const { kp, v } = await earned(s);
    const res = await rawSpend(s, v.token, "/search?q=x", signedHeaders(kp, v.jti, s.clock.t));
    expect(res.status).toBe(402);
    expect(res.body.error).toBe("bad_signature");
    const agent = newAgent(s.baseUrl, { solver: perfectSolver(s.truth), now: () => s.clock.t });
    expect((await agent.fetch(`${s.baseUrl}/search?q=y`)).status).toBe(200);
  });

  it("replaying the exact same nonce-less headers within the skew still succeeds (v1 5-line form)", async () => {
    // SPEC 7.2 documents this: without a nonce, a captured request replays for up to
    // spendTimestampSkew seconds. Sellers that care set requireSpendNonce.
    const s = await seller();
    const { kp, v } = await earned(s);
    const h = signedHeaders(kp, v.jti, s.clock.t);
    const first = await rawSpend(s, v.token, "/search?q=x", h);
    expect(first.status).toBe(200);
    expect(first.headers.get(HEADERS.callsRemaining)).toBe("9");
    const replay = await rawSpend(s, v.token, "/search?q=x", h);
    expect(replay.status).toBe(200);
    expect(replay.headers.get(HEADERS.callsRemaining)).toBe("8");
    // ...and the replay dies once the seller clock moves past the skew
    s.clock.t += DEFAULTS.spendTimestampSkew + 1;
    const late = await rawSpend(s, v.token, "/search?q=x", h);
    expect(late.status).toBe(402);
    expect(late.body.error).toBe("stale_timestamp");
  });

  it("binding is checked before the call counter: a bad signature does not burn a call", async () => {
    const s = await seller();
    const { kp, v } = await earned(s);
    for (let i = 0; i < 3; i++) {
      await rawSpend(s, v.token, "/search?q=x", signedHeaders(generateKeypair(), v.jti, s.clock.t));
      await rawSpend(s, v.token, "/search?q=x", { ...signedHeaders(kp, v.jti, s.clock.t), [HEADERS.sig]: "AAAA" });
    }
    expect(s.d402.vouchers.get(v.jti)?.callsLeft).toBe(10);
  });
});

describe("bindVouchers off", () => {
  it("a seller that does not bind ignores bogus binding headers", async () => {
    const s = await seller({ bindVouchers: false });
    const { v } = await earned(s);
    const res = await rawSpend(s, v.token, "/search?q=x", {
      [HEADERS.key]: generateKeypair().publicKey,
      [HEADERS.timestamp]: "0",
      [HEADERS.sig]: "nope",
    });
    expect(res.status).toBe(200);
  });
});
