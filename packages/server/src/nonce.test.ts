import { Hono } from "hono";
import { afterEach, describe, expect, it } from "vitest";
import { HEADERS, generateKeypair, newNonce, signSpend, signSubmit } from "@d402/spec";
import { createD402, type D402Server } from "./index.js";

const LABELS = ["a", "b", "c", "d"];
const clock = { t: 1_800_000_000 };

function seller(extra: Record<string, unknown> = {}) {
  const d = createD402({
    sellerId: "nonce-seller",
    taskUrl: "http://seller.test/.well-known/d402/tasks",
    scope: ["/search"],
    secret: "s",
    labels: LABELS,
    tiers: [{ id: "s", items: 2, est_tokens: 100, reward: { calls: 10 } }],
    now: () => clock.t,
    bindVouchers: true,
    ...extra,
  });
  d.tasks.load([
    { id: "g1", type: "classify", text: "x", golden: "a" },
    { id: "g2", type: "classify", text: "y", golden: "b" },
    { id: "g3", type: "classify", text: "z", golden: "c" },
    { id: "g4", type: "classify", text: "w", golden: "d" },
  ]);
  const app = new Hono();
  app.route("/", d.routes);
  app.use("/search", d.gate);
  app.get("/search", (c) => c.json({ ok: true }));
  return { d, app };
}

const truth: Record<string, string> = { g1: "a", g2: "b", g3: "c", g4: "d" };

async function earn(app: Hono, kp: ReturnType<typeof generateKeypair>) {
  const b = await (await app.request("http://seller.test/.well-known/d402/tasks?tier=s", { headers: { [HEADERS.key]: kp.publicKey } })).json();
  const answers: Record<string, string> = {};
  for (const it of b.items) answers[it.id] = truth[it.id]!;
  const r = await app.request(`http://seller.test/.well-known/d402/tasks/${b.bundleId}`, {
    method: "POST",
    headers: { [HEADERS.key]: kp.publicKey, "content-type": "application/json" },
    body: JSON.stringify({ answers, sig: signSubmit(kp.privateKey, b.bundleId, answers) }),
  });
  expect(r.status).toBe(200);
  const v = await r.json();
  const jti = JSON.parse(Buffer.from(v.voucher.split(".")[1], "base64url").toString()).jti as string;
  return { token: v.voucher as string, jti };
}

function spendHeaders(kp: ReturnType<typeof generateKeypair>, token: string, jti: string, nonce?: string, ts = clock.t) {
  const h: Record<string, string> = {
    [HEADERS.voucher]: token,
    [HEADERS.key]: kp.publicKey,
    [HEADERS.timestamp]: String(ts),
    [HEADERS.sig]: signSpend(kp.privateKey, "GET", "/search", jti, ts, nonce),
  };
  if (nonce !== undefined) h[HEADERS.nonce] = nonce;
  return h;
}

let live: D402Server[] = [];
afterEach(() => {
  for (const d of live) d.close();
  live = [];
});

describe("spend nonce (SPEC 7.2)", () => {
  it("accepts a nonce-signed spend and rejects the exact replay with replayed_spend", async () => {
    const { d, app } = seller();
    live.push(d);
    const kp = generateKeypair();
    const { token, jti } = await earn(app, kp);
    const h = spendHeaders(kp, token, jti, newNonce());
    const r1 = await app.request("http://seller.test/search", { headers: h });
    expect(r1.status).toBe(200);
    expect(r1.headers.get(HEADERS.callsRemaining)).toBe("9");
    const r2 = await app.request("http://seller.test/search", { headers: h });
    expect(r2.status).toBe(402);
    expect((await r2.json()).error).toBe("replayed_spend");
    expect(d.vouchers.get(jti)?.callsLeft).toBe(9);
  });

  it("a fresh nonce on every request keeps spending", async () => {
    const { d, app } = seller();
    live.push(d);
    const kp = generateKeypair();
    const { token, jti } = await earn(app, kp);
    for (let i = 0; i < 3; i++) {
      const r = await app.request("http://seller.test/search", { headers: spendHeaders(kp, token, jti, newNonce()) });
      expect(r.status).toBe(200);
    }
    expect(d.vouchers.get(jti)?.callsLeft).toBe(7);
  });

  it("the same nonce is fine on a different voucher", async () => {
    const { d, app } = seller();
    live.push(d);
    const kp = generateKeypair();
    const a = await earn(app, kp);
    const b = await earn(app, kp);
    const n = newNonce();
    expect((await app.request("http://seller.test/search", { headers: spendHeaders(kp, a.token, a.jti, n) })).status).toBe(200);
    expect((await app.request("http://seller.test/search", { headers: spendHeaders(kp, b.token, b.jti, n) })).status).toBe(200);
  });

  it("a signature made without the nonce does not verify when the nonce header is present", async () => {
    const { d, app } = seller();
    live.push(d);
    const kp = generateKeypair();
    const { token, jti } = await earn(app, kp);
    const h = spendHeaders(kp, token, jti);
    h[HEADERS.nonce] = newNonce();
    const r = await app.request("http://seller.test/search", { headers: h });
    expect(r.status).toBe(402);
    expect((await r.json()).error).toBe("bad_signature");
  });

  it("without a nonce the 5-line form still works by default (v1 clients)", async () => {
    const { d, app } = seller();
    live.push(d);
    const kp = generateKeypair();
    const { token, jti } = await earn(app, kp);
    const h = spendHeaders(kp, token, jti);
    expect((await app.request("http://seller.test/search", { headers: h })).status).toBe(200);
    // and, as SPEC 7.2 warns, that form replays inside the skew window
    expect((await app.request("http://seller.test/search", { headers: h })).status).toBe(200);
  });

  it("requireSpendNonce rejects nonce-less bound spends", async () => {
    const { d, app } = seller({ requireSpendNonce: true });
    live.push(d);
    const kp = generateKeypair();
    const { token, jti } = await earn(app, kp);
    const r = await app.request("http://seller.test/search", { headers: spendHeaders(kp, token, jti) });
    expect(r.status).toBe(402);
    expect((await r.json()).error).toBe("bad_signature");
    expect((await app.request("http://seller.test/search", { headers: spendHeaders(kp, token, jti, newNonce()) })).status).toBe(200);
  });

  it("rejects absurd nonce lengths", async () => {
    const { d, app } = seller();
    live.push(d);
    const kp = generateKeypair();
    const { token, jti } = await earn(app, kp);
    expect((await app.request("http://seller.test/search", { headers: spendHeaders(kp, token, jti, "abc") })).status).toBe(402);
    expect((await app.request("http://seller.test/search", { headers: spendHeaders(kp, token, jti, "x".repeat(129)) })).status).toBe(402);
  });

  it("a nonce can be reused once its window has expired and been purged", async () => {
    const { d, app } = seller();
    live.push(d);
    const kp = generateKeypair();
    const { token, jti } = await earn(app, kp);
    const n = newNonce();
    expect((await app.request("http://seller.test/search", { headers: spendHeaders(kp, token, jti, n) })).status).toBe(200);
    clock.t += 400; // past the 300s skew; purge runs at most once a minute
    const r = await app.request("http://seller.test/search", { headers: spendHeaders(kp, token, jti, n, clock.t) });
    expect(r.status).toBe(200);
    clock.t -= 400;
  });

  it("nonces are not consulted on unbound sellers", async () => {
    const { d, app } = seller({ bindVouchers: false });
    live.push(d);
    const kp = generateKeypair();
    const { token } = await earn(app, kp);
    const h = { [HEADERS.voucher]: token, [HEADERS.nonce]: "same-nonce-twice" };
    expect((await app.request("http://seller.test/search", { headers: h })).status).toBe(200);
    expect((await app.request("http://seller.test/search", { headers: h })).status).toBe(200);
  });
});
