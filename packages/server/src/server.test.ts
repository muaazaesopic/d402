import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { decodeJwt } from "jose";
import { afterEach, describe, expect, it } from "vitest";
import {
  Bundle as BundleSchema,
  DEFAULTS,
  HEADERS,
  Offer as OfferSchema,
  SubmitResult as SubmitResultSchema,
  generateKeypair,
  signSpend,
  signSubmit,
  type Bundle,
  type Keypair,
  type TaskFileItem,
  type Tier,
} from "@d402/spec";
import { createD402, goldenCount, goldenRatio, passes, SqliteStore, type D402ServerOptions } from "./index.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const LABELS = ["a", "b", "c"];
const T0 = 1_760_000_000;
const TASK_URL = "http://localhost/.well-known/d402/tasks";

const TIERS: Tier[] = [
  { id: "one", items: 1, est_tokens: 100, reward: { calls: 2 } },
  { id: "two", items: 2, est_tokens: 200, reward: { calls: 3 } },
  { id: "ten", items: 10, est_tokens: 1000, reward: { calls: 10 } },
  { id: "twelve", items: 12, est_tokens: 1200, reward: { calls: 12 } },
];

/** Goldens g1..gN cycle through the labels; unknowns u1..uM. */
function makeItems(goldens: number, unknowns: number): TaskFileItem[] {
  const out: TaskFileItem[] = [];
  for (let i = 1; i <= goldens; i++) {
    out.push({ id: `g${i}`, type: "classify", text: `golden ${i}`, golden: LABELS[i % LABELS.length]! });
  }
  for (let i = 1; i <= unknowns; i++) out.push({ id: `u${i}`, type: "classify", text: `unknown ${i}` });
  return out;
}
const GOLDEN_ANSWER = (id: string) => LABELS[Number(id.slice(1)) % LABELS.length]!;
const WRONG = (id: string) => LABELS[(Number(id.slice(1)) + 1) % LABELS.length]!;
const isGolden = (id: string) => id.startsWith("g");

/** Deterministic RNG (mulberry32). */
function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

function setup(over: Partial<D402ServerOptions> = {}, items: TaskFileItem[] = makeItems(10, 30)) {
  let t = T0;
  const clock = { now: () => t, advance: (s: number) => (t += s), set: (v: number) => (t = v) };
  const d = createD402({
    sellerId: "api.test",
    taskUrl: TASK_URL,
    scope: ["/search"],
    tiers: TIERS,
    secret: "test-secret",
    labels: LABELS,
    now: clock.now,
    random: seeded(42),
    bundlesPerKeyPerHour: 10_000,
    bundlesPerIpPerHour: 10_000,
    maxOpenBundlesPerKey: 10_000,
    ...over,
  });
  d.tasks.load(items);
  cleanups.push(() => d.close());

  const app = new Hono();
  app.route("/", d.routes);
  app.use("/search", d.gate);
  app.use("/search/*", d.gate);
  app.use("/other", d.gate);
  app.get("/search", (c) => c.json({ hits: [] }));
  app.get("/search/deep", (c) => c.json({ deep: true }));
  app.post("/search", (c) => c.json({ posted: true }));
  app.get("/other", (c) => c.json({ other: true }));

  async function getBundle(kp: Keypair, tier = "ten", headers: Record<string, string> = {}) {
    const q = tier ? `?tier=${tier}` : "";
    const res = await app.request(`${TASK_URL}${q}`, {
      headers: { [HEADERS.key]: kp.publicKey, ...headers },
    });
    return { res, body: (await res.json()) as any };
  }

  async function submit(
    kp: Keypair,
    bundleId: string,
    answers: Record<string, string>,
    extra: { model?: string; sig?: string; key?: string; headers?: Record<string, string>; raw?: string } = {},
  ) {
    const body = extra.raw ?? JSON.stringify({
      answers,
      ...(extra.model ? { model: extra.model } : {}),
      sig: extra.sig ?? signSubmit(kp.privateKey, bundleId, answers),
    });
    const res = await app.request(`${TASK_URL}/${bundleId}`, {
      method: "POST",
      headers: { "content-type": "application/json", [HEADERS.key]: extra.key ?? kp.publicKey, ...extra.headers },
      body,
    });
    return { res, body: (await res.json()) as any };
  }

  function answersFor(b: Bundle, mode: "perfect" | "wrong" | ((id: string) => string) = "perfect") {
    const a: Record<string, string> = {};
    for (const it of b.items) {
      if (typeof mode === "function") a[it.id] = mode(it.id);
      else if (isGolden(it.id)) a[it.id] = mode === "perfect" ? GOLDEN_ANSWER(it.id) : WRONG(it.id);
      else a[it.id] = "a";
    }
    return a;
  }

  /** Earn one bundle and submit it; returns the submit response. */
  async function earn(kp: Keypair, tier = "ten", mode: "perfect" | "wrong" | ((id: string) => string) = "perfect", model?: string) {
    const { res, body } = await getBundle(kp, tier, model ? { [HEADERS.model]: model } : {});
    expect(res.status, JSON.stringify(body)).toBe(200);
    return submit(kp, body.bundleId, answersFor(body, mode), model ? { model } : {});
  }

  async function spend(voucher: string, path = "/search", headers: Record<string, string> = {}, method = "GET") {
    return app.request(path, { method, headers: { [HEADERS.voucher]: voucher, ...headers } });
  }

  return { d, app, clock, getBundle, submit, answersFor, earn, spend };
}

function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), "d402-server-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// ---------------------------------------------------------------------------
// Offer and discovery (SPEC 3)
// ---------------------------------------------------------------------------

describe("offer", () => {
  it("serves the offer on /.well-known/d402 with the SPEC 3 shape", async () => {
    const { app } = setup();
    const res = await app.request("/.well-known/d402");
    expect(res.status).toBe(200);
    const body = await res.json();
    const parsed = OfferSchema.parse(body);
    expect(parsed.d402).toBe("1");
    expect(parsed.error).toBeUndefined();
    expect(body.accepts[0]).toEqual({
      scheme: "d402",
      sellerId: "api.test",
      taskUrl: TASK_URL,
      taskTypes: ["classify"],
      scope: ["/search"],
      voucherTtl: DEFAULTS.voucherTtl,
      tiers: TIERS,
    });
  });

  it("offer(error, message) adds the top-level error fields", () => {
    const { d } = setup();
    const o = d.offer("voucher_expired", "gone");
    expect(o.error).toBe("voucher_expired");
    expect(o.message).toBe("gone");
    expect(OfferSchema.safeParse(o).success).toBe(true);
  });

  it("passes otherAccepts through untouched after the d402 entry", async () => {
    const x402 = { scheme: "exact", network: "base", maxAmountRequired: "1000", asset: "USDC" };
    const { app } = setup({ otherAccepts: [x402] });
    const body = await (await app.request("/.well-known/d402")).json();
    expect(body.accepts).toHaveLength(2);
    expect(body.accepts[1]).toEqual(x402);
    expect(OfferSchema.safeParse(body).success).toBe(true);
  });

  it("rejects fewer than 2 labels and a missing secret at construction", () => {
    expect(() => setup({ labels: ["only"] })).toThrow(/labels/);
    expect(() => setup({ secret: "" })).toThrow(/secret/);
  });
});

// ---------------------------------------------------------------------------
// GET tasks (SPEC 4)
// ---------------------------------------------------------------------------

describe("GET tasks", () => {
  it("returns a well-formed bundle of tier.items items with labels and expiry", async () => {
    const { getBundle, clock } = setup({ bundleTtl: 600 });
    const { res, body } = await getBundle(generateKeypair(), "ten");
    expect(res.status).toBe(200);
    const b = BundleSchema.parse(body);
    expect(b.tier).toBe("ten");
    expect(b.type).toBe("classify");
    expect(b.items).toHaveLength(10);
    expect(b.labels).toEqual(LABELS);
    expect(b.instructions).toBe("Label each item with exactly one of the labels.");
    expect(b.expiresAt).toBe(clock.now() + 600);
    expect(b.bundleId).toMatch(/^b_/);
    expect(new Set(b.items.map((i) => i.id)).size).toBe(10);
  });

  it("uses a custom instructions string", async () => {
    const { getBundle } = setup({ instructions: "Pick one." });
    const { body } = await getBundle(generateKeypair());
    expect(body.instructions).toBe("Pick one.");
  });

  it("defaults to the first tier when ?tier is omitted", async () => {
    const { getBundle } = setup();
    const { res, body } = await getBundle(generateKeypair(), "");
    expect(res.status).toBe(200);
    expect(body.tier).toBe("one");
  });

  it("missing_key 400", async () => {
    const { app } = setup();
    const res = await app.request(`${TASK_URL}?tier=ten`);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("missing_key");
  });

  it("bad_key 400", async () => {
    const { app } = setup();
    const res = await app.request(`${TASK_URL}?tier=ten`, { headers: { [HEADERS.key]: "not-a-key" } });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("bad_key");
  });

  it("bad_tier 400", async () => {
    const { getBundle } = setup();
    const { res, body } = await getBundle(generateKeypair(), "nope");
    expect(res.status).toBe(400);
    expect(body.error).toBe("bad_tier");
  });

  it("no_tasks 409 on an empty pool and when goldens are short", async () => {
    const empty = setup({}, []);
    const r1 = await empty.getBundle(generateKeypair(), "ten");
    expect(r1.res.status).toBe(409);
    expect(r1.body.error).toBe("no_tasks");

    // unknowns only: there is no golden to put in the bundle
    const noGold = setup({}, makeItems(0, 50));
    const r2 = await noGold.getBundle(generateKeypair(), "ten");
    expect(r2.res.status).toBe(409);
    expect(r2.body.error).toBe("no_tasks");
  });

  it("blocked 403 once a key has 5 bundles with accuracy < 0.6", async () => {
    const { earn, getBundle, d, submit } = setup();
    const kp = generateKeypair();
    for (let i = 0; i < 5; i++) {
      const { res } = await earn(kp, "ten", "wrong");
      expect(res.status).toBe(422);
    }
    const a = d.agents.get(kp.publicKey)!;
    expect(a.bundles).toBe(5);
    expect(a.goldenSeen).toBe(20);
    expect(a.goldenCorrect).toBe(0);
    expect(a.blocked).toBe(true);
    const { res, body } = await getBundle(kp);
    expect(res.status).toBe(403);
    expect(body.error).toBe("blocked");
    // POST is a task endpoint too
    const p = await submit(kp, "b_whatever", {});
    expect(p.res.status).toBe(403);
    expect(p.body.error).toBe("blocked");
    expect(d.tasks.stats().blockedAgents).toBe(1);
  });

  it("does not block a key with 5 bundles and accuracy >= 0.6", async () => {
    const { earn, getBundle, d } = setup();
    const kp = generateKeypair();
    for (let i = 0; i < 5; i++) expect((await earn(kp)).res.status).toBe(200);
    expect(d.agents.get(kp.publicKey)!.blocked).toBe(false);
    expect((await getBundle(kp)).res.status).toBe(200);
  });

  it("records the model family from D402-Model on the agent", async () => {
    const { getBundle, d } = setup();
    const kp = generateKeypair();
    await getBundle(kp, "ten", { [HEADERS.model]: "gemini" });
    expect(d.agents.get(kp.publicKey)!.model).toBe("gemini");
  });
});

// ---------------------------------------------------------------------------
// Golden sampling (SPEC 5.2, 5.4)
// ---------------------------------------------------------------------------

describe("golden ratio and sampling", () => {
  it("trust bands (unit)", () => {
    expect(goldenRatio({ bundles: 0, goldenSeen: 0, goldenCorrect: 0 })).toBe(0.4);
    expect(goldenRatio({ bundles: 4, goldenSeen: 100, goldenCorrect: 100 })).toBe(0.4);
    expect(goldenRatio({ bundles: 10, goldenSeen: 100, goldenCorrect: 100 })).toBe(0.2);
    expect(goldenRatio({ bundles: 10, goldenSeen: 100, goldenCorrect: 80 })).toBe(0.4);
    expect(goldenRatio({ bundles: 50, goldenSeen: 100, goldenCorrect: 100 })).toBe(0.1);
    expect(goldenRatio({ bundles: 50, goldenSeen: 100, goldenCorrect: 92 })).toBe(0.2);
    expect(goldenCount(10, { bundles: 0, goldenSeen: 0, goldenCorrect: 0 })).toBe(4);
    expect(goldenCount(1, { bundles: 0, goldenSeen: 0, goldenCorrect: 0 })).toBe(1);
    expect(goldenCount(5, { bundles: 50, goldenSeen: 100, goldenCorrect: 100 })).toBe(1);
    expect(goldenCount(25, { bundles: 50, goldenSeen: 100, goldenCorrect: 100 })).toBe(3);
  });

  it("new key: 40% goldens (4 of 10)", async () => {
    const { getBundle } = setup();
    const { body } = await getBundle(generateKeypair(), "ten");
    expect(body.items.filter((i: any) => isGolden(i.id))).toHaveLength(4);
  });

  it("trusted key: 20% after 10 clean bundles, 10% after 50", async () => {
    const { earn, getBundle } = setup({}, makeItems(10, 600));
    const kp = generateKeypair();
    for (let i = 0; i < 10; i++) expect((await earn(kp)).res.status).toBe(200);
    let { body } = await getBundle(kp, "ten");
    expect(body.items.filter((i: any) => isGolden(i.id))).toHaveLength(2);
    // that open bundle counts as handed-out but not as a bundle until submitted
    for (let i = 0; i < 40; i++) expect((await earn(kp)).res.status).toBe(200);
    ({ body } = await getBundle(kp, "ten"));
    expect(body.items.filter((i: any) => isGolden(i.id))).toHaveLength(1);
  });

  it("fills with goldens when unknowns run short, and never re-hands an answered unknown", async () => {
    const { getBundle, submit, answersFor } = setup({}, makeItems(10, 6));
    const kp = generateKeypair();
    const first = await getBundle(kp, "ten");
    const unknownsFirst = first.body.items.filter((i: any) => !isGolden(i.id)).map((i: any) => i.id);
    expect(unknownsFirst.sort()).toEqual(["u1", "u2", "u3", "u4", "u5", "u6"]);
    expect((await submit(kp, first.body.bundleId, answersFor(first.body))).res.status).toBe(200);

    const second = await getBundle(kp, "ten");
    expect(second.res.status).toBe(200);
    expect(second.body.items.every((i: any) => isGolden(i.id))).toBe(true);

    // another key still gets the unknowns
    const other = await getBundle(generateKeypair(), "ten");
    expect(other.body.items.filter((i: any) => !isGolden(i.id))).toHaveLength(6);
  });

  it("does not re-hand an unknown that is in an open (unsubmitted) bundle to the same key", async () => {
    const { getBundle } = setup({}, makeItems(10, 6));
    const kp = generateKeypair();
    await getBundle(kp, "ten");
    const second = await getBundle(kp, "ten");
    expect(second.body.items.every((i: any) => isGolden(i.id))).toBe(true);
  });

  it("prefers unknowns with the fewest votes", async () => {
    const { earn, getBundle } = setup({}, makeItems(10, 12));
    const a = generateKeypair();
    // ids order as strings: the first key votes on u1, u10, u11, u12, u2, u3
    expect((await earn(a)).res.status).toBe(200);
    const { body } = await getBundle(generateKeypair(), "ten");
    const unknowns = body.items.filter((i: any) => !isGolden(i.id)).map((i: any) => i.id).sort();
    expect(unknowns).toEqual(["u4", "u5", "u6", "u7", "u8", "u9"]);
  });

  it("retires a golden after goldenMaxExposures and reports it in stats", async () => {
    const { getBundle, d } = setup({ goldenMaxExposures: 2 }, makeItems(1, 10));
    expect((await getBundle(generateKeypair(), "two")).res.status).toBe(200);
    expect(d.tasks.stats().retiredGolden).toBe(0);
    expect((await getBundle(generateKeypair(), "two")).res.status).toBe(200);
    expect(d.tasks.stats().retiredGolden).toBe(1);
    const third = await getBundle(generateKeypair(), "two");
    expect(third.res.status).toBe(409);
    expect(third.body.error).toBe("no_tasks");
  });

  it("shuffles item order so goldens are not positionally detectable", async () => {
    const { getBundle } = setup({ random: seeded(7) }, makeItems(10, 200));
    const firstIsGolden: boolean[] = [];
    const lastIsGolden: boolean[] = [];
    for (let i = 0; i < 20; i++) {
      const { body } = await getBundle(generateKeypair(), "ten");
      firstIsGolden.push(isGolden(body.items[0].id));
      lastIsGolden.push(isGolden(body.items[9].id));
    }
    expect(firstIsGolden.some((x) => x)).toBe(true);
    expect(firstIsGolden.some((x) => !x)).toBe(true);
    expect(lastIsGolden.some((x) => x)).toBe(true);
    expect(lastIsGolden.some((x) => !x)).toBe(true);
  });

  it("samples goldens uniformly from the live pool rather than always the same ones", async () => {
    const { getBundle } = setup({ random: seeded(3) }, makeItems(10, 200));
    const seen = new Set<string>();
    for (let i = 0; i < 15; i++) {
      const { body } = await getBundle(generateKeypair(), "ten");
      for (const it of body.items) if (isGolden(it.id)) seen.add(it.id);
    }
    expect(seen.size).toBeGreaterThan(4);
  });
});

// ---------------------------------------------------------------------------
// POST tasks (SPEC 5)
// ---------------------------------------------------------------------------

describe("POST tasks", () => {
  it("passes a perfect bundle and returns a SubmitResult", async () => {
    const { earn, clock, d } = setup({ voucherTtl: 1000 });
    const kp = generateKeypair();
    const { res, body } = await earn(kp, "ten");
    expect(res.status).toBe(200);
    const r = SubmitResultSchema.parse(body);
    expect(r.calls).toBe(10);
    expect(r.scope).toEqual(["/search"]);
    expect(r.expiresAt).toBe(clock.now() + 1000);
    const claims = decodeJwt(r.voucher);
    expect(claims.iss).toBe("api.test");
    expect(claims.sub).toBe(kp.publicKey);
    expect(claims.scope).toEqual(["/search"]);
    expect(claims.jti).toMatch(/^v_/);
    expect(claims.iat).toBe(clock.now());
    expect(claims.exp).toBe(clock.now() + 1000);
    expect(d.vouchers.get(claims.jti as string)).toEqual({
      jti: claims.jti,
      sub: kp.publicKey,
      scope: ["/search"],
      callsLeft: 10,
      exp: clock.now() + 1000,
    });
    expect(d.tasks.stats().vouchers).toBe(1);
  });

  it("fails a bad bundle with 422 quality and reveals nothing", async () => {
    const { earn, d } = setup();
    const kp = generateKeypair();
    const { res, body } = await earn(kp, "ten", "wrong");
    expect(res.status).toBe(422);
    expect(body).toEqual({ error: "quality", message: expect.any(String) });
    expect(JSON.stringify(body)).not.toMatch(/g\d/);
    expect(d.tasks.stats().vouchers).toBe(0);
  });

  it("g == 1: passes only when the single golden is correct", async () => {
    const { earn } = setup();
    const okKey = generateKeypair();
    expect((await earn(okKey, "two", "perfect")).res.status).toBe(200);
    const badKey = generateKeypair();
    // answer everything "wrong" for goldens; the single unknown does not matter
    expect((await earn(badKey, "two", "wrong")).res.status).toBe(422);
  });

  it("80% rule: 4 of 5 passes, 3 of 5 fails, 3 of 4 fails", async () => {
    const { earn } = setup();
    const missN = (n: number) => {
      let missed = 0;
      return (id: string) => {
        if (!isGolden(id)) return "a";
        if (missed < n) {
          missed++;
          return WRONG(id);
        }
        return GOLDEN_ANSWER(id);
      };
    };
    // twelve items -> round(4.8) = 5 goldens
    expect((await earn(generateKeypair(), "twelve", missN(1))).res.status).toBe(200);
    expect((await earn(generateKeypair(), "twelve", missN(2))).res.status).toBe(422);
    // ten items -> 4 goldens; 3/4 = 0.75 < 0.8
    expect((await earn(generateKeypair(), "ten", missN(1))).res.status).toBe(422);
    expect((await earn(generateKeypair(), "ten", missN(0))).res.status).toBe(200);
    expect(passes(5, 4)).toBe(true);
    expect(passes(4, 3)).toBe(false);
    expect(passes(1, 0)).toBe(false);
  });

  it("updates agent counters on both pass and fail", async () => {
    const { earn, d } = setup();
    const kp = generateKeypair();
    await earn(kp, "ten", "perfect");
    let a = d.agents.get(kp.publicKey)!;
    expect(a).toMatchObject({ bundles: 1, goldenSeen: 4, goldenCorrect: 4, blocked: false });
    expect(a.accuracy).toBeCloseTo(5 / 6);
    await earn(kp, "ten", "wrong");
    a = d.agents.get(kp.publicKey)!;
    expect(a).toMatchObject({ bundles: 2, goldenSeen: 8, goldenCorrect: 4 });
    expect(a.accuracy).toBeCloseTo(5 / 10);
    expect(d.agents.list().map((x) => x.publicKey)).toEqual([kp.publicKey]);
  });

  it("unknown_bundle 404", async () => {
    const { submit } = setup();
    const { res, body } = await submit(generateKeypair(), "b_missing", {});
    expect(res.status).toBe(404);
    expect(body.error).toBe("unknown_bundle");
  });

  it("already_submitted 409", async () => {
    const { getBundle, submit, answersFor } = setup();
    const kp = generateKeypair();
    const { body } = await getBundle(kp);
    const answers = answersFor(body);
    expect((await submit(kp, body.bundleId, answers)).res.status).toBe(200);
    const again = await submit(kp, body.bundleId, answers);
    expect(again.res.status).toBe(409);
    expect(again.body.error).toBe("already_submitted");
  });

  it("expired_bundle 410 after bundleTtl", async () => {
    const { getBundle, submit, answersFor, clock } = setup({ bundleTtl: 60 });
    const kp = generateKeypair();
    const { body } = await getBundle(kp);
    clock.advance(60);
    const r = await submit(kp, body.bundleId, answersFor(body));
    expect(r.res.status).toBe(410);
    expect(r.body.error).toBe("expired_bundle");
  });

  it("bad_signature 401 for a tampered signature and for another key's bundle", async () => {
    const { getBundle, submit, answersFor } = setup();
    const kp = generateKeypair();
    const other = generateKeypair();
    const { body } = await getBundle(kp);
    const answers = answersFor(body);
    const bad = await submit(kp, body.bundleId, answers, { sig: signSubmit(kp.privateKey, body.bundleId, { x: "a" }) });
    expect(bad.res.status).toBe(401);
    expect(bad.body.error).toBe("bad_signature");
    // valid signature from a different key than the bundle was issued to
    const stolen = await submit(other, body.bundleId, answers);
    expect(stolen.res.status).toBe(401);
    expect(stolen.body.error).toBe("bad_signature");
    // signature by the right key but header claims another key
    const swapped = await submit(kp, body.bundleId, answers, { key: other.publicKey });
    expect(swapped.res.status).toBe(401);
  });

  it("incomplete 400 and bad_label 400", async () => {
    const { getBundle, submit, answersFor } = setup();
    const kp = generateKeypair();
    const { body } = await getBundle(kp);
    const answers = answersFor(body);
    const partial = { ...answers };
    delete partial[body.items[0].id];
    const r1 = await submit(kp, body.bundleId, partial);
    expect(r1.res.status).toBe(400);
    expect(r1.body.error).toBe("incomplete");
    const r2 = await submit(kp, body.bundleId, { ...answers, [body.items[0].id]: "zzz" });
    expect(r2.res.status).toBe(400);
    expect(r2.body.error).toBe("bad_label");
  });

  it("missing_key / bad_key / bad_request on POST", async () => {
    const { submit, app } = setup();
    const kp = generateKeypair();
    const r1 = await submit(kp, "b_x", {}, { key: "" });
    expect(r1.res.status).toBe(400);
    expect(r1.body.error).toBe("missing_key");
    const r2 = await submit(kp, "b_x", {}, { key: "nope" });
    expect(r2.body.error).toBe("bad_key");
    const r3 = await submit(kp, "b_x", {}, { raw: "{not json" });
    expect(r3.res.status).toBe(400);
    expect(r3.body.error).toBe("bad_request");
    const r4 = await app.request(`${TASK_URL}/b_x`, {
      method: "POST",
      headers: { "content-type": "application/json", [HEADERS.key]: kp.publicKey },
      body: JSON.stringify({ answers: {} }),
    });
    expect((await r4.json()).error).toBe("bad_request");
  });

  it("persists the model family from body.model or the header", async () => {
    const { earn, d, getBundle, submit, answersFor } = setup();
    const a = generateKeypair();
    await earn(a, "ten", "perfect", "claude");
    expect(d.agents.get(a.publicKey)!.model).toBe("claude");

    const b = generateKeypair();
    const { body } = await getBundle(b);
    await submit(b, body.bundleId, answersFor(body), { headers: { [HEADERS.model]: "gpt" } });
    expect(d.agents.get(b.publicKey)!.model).toBe("gpt");
  });
});

// ---------------------------------------------------------------------------
// Votes and resolution (SPEC 5.1, 5.3)
// ---------------------------------------------------------------------------

describe("votes and resolution", () => {
  /** Raise a key's accuracy with golden-only bundles (tier "one" has 1 golden, 0 unknowns). */
  async function warm(earn: ReturnType<typeof setup>["earn"], kp: Keypair, n: number, model?: string) {
    for (let i = 0; i < n; i++) expect((await earn(kp, "one", "perfect", model)).res.status).toBe(200);
  }

  it("records votes with the pre-update accuracy and resolves at >= 2.0 across >= 2 keys", async () => {
    const dir = tmp();
    const db = join(dir, "votes.db");
    const { earn, d } = setup({ db }, makeItems(10, 6));
    const keys = [generateKeypair(), generateKeypair(), generateKeypair()];
    // 3 warm-ups each -> accuracy (3+1)/(3+2) = 0.8 before the voting bundle
    for (const kp of keys) await warm(earn, kp, 3);
    for (const kp of keys.slice(0, 2)) expect((await earn(kp, "ten")).res.status).toBe(200);
    // 2 x 0.8 = 1.6 < 2.0 -> nothing resolved yet
    expect(d.tasks.stats().resolved).toBe(0);
    expect((await earn(keys[2]!, "ten")).res.status).toBe(200);
    // 3 x 0.8 = 2.4 >= 2.0 with 3 distinct keys -> resolved
    const stats = d.tasks.stats();
    expect(stats.resolved).toBe(6);
    expect(stats.unknownOpen).toBe(0);
    const resolved = d.tasks.exportResolved();
    expect(resolved).toHaveLength(6);
    expect(resolved[0]).toEqual({ id: "u1", text: "unknown 1", answer: "a", weight: expect.any(Number), voters: 3 });
    expect(resolved[0]!.weight).toBeCloseTo(2.4);

    // the stored weight is the pre-bundle accuracy (0.8), not the post-bundle one
    const raw = new SqliteStore(db);
    const w = raw.itemVotes("u1").map((v) => v.weight);
    raw.close();
    expect(w).toHaveLength(3);
    for (const x of w) expect(x).toBeCloseTo(0.8);
  });

  it("first-bundle votes carry the prior weight 0.5", async () => {
    const dir = tmp();
    const db = join(dir, "prior.db");
    const { earn } = setup({ db }, makeItems(10, 6));
    await earn(generateKeypair(), "ten");
    const raw = new SqliteStore(db);
    const votes = raw.itemVotes("u1");
    raw.close();
    expect(votes).toHaveLength(1);
    expect(votes[0]!.weight).toBe(0.5);
  });

  it("a failed bundle records no votes", async () => {
    const dir = tmp();
    const db = join(dir, "fail.db");
    const { earn } = setup({ db }, makeItems(10, 6));
    expect((await earn(generateKeypair(), "ten", "wrong")).res.status).toBe(422);
    const raw = new SqliteStore(db);
    expect(raw.itemVotes("u1")).toHaveLength(0);
    raw.close();
  });

  it("does not resolve on weight alone: at least 2 distinct keys are required", async () => {
    const dir = tmp();
    const db = join(dir, "keys.db");
    const { earn, d } = setup({ db }, makeItems(10, 6));
    // plant a single heavy vote from one key
    const raw = new SqliteStore(db);
    raw.insertVotes([{ itemId: "u1", agent: "planted", answer: "b", weight: 5, bundleId: "b_planted", model: null }]);
    raw.close();
    // another key votes "a" on u1 (weight 0.5); top answer "b" has 5.0 but only one key
    expect((await earn(generateKeypair(), "ten")).res.status).toBe(200);
    expect(d.tasks.stats().resolved).toBe(0);
    expect(d.tasks.exportResolved()).toEqual([]);
  });

  it("requireModelFamilies needs 2 distinct declared models", async () => {
    const same = setup({ requireModelFamilies: true }, makeItems(10, 6));
    const keys = [generateKeypair(), generateKeypair(), generateKeypair()];
    for (const kp of keys) await warm(same.earn, kp, 3, "claude");
    for (const kp of keys) expect((await same.earn(kp, "ten", "perfect", "claude")).res.status).toBe(200);
    expect(same.d.tasks.stats().resolved).toBe(0);

    const mixed = setup({ requireModelFamilies: true }, makeItems(10, 6));
    const models = ["claude", "claude", "gpt"];
    const keys2 = [generateKeypair(), generateKeypair(), generateKeypair()];
    for (let i = 0; i < 3; i++) await warm(mixed.earn, keys2[i]!, 3, models[i]);
    for (let i = 0; i < 3; i++) {
      expect((await mixed.earn(keys2[i]!, "ten", "perfect", models[i])).res.status).toBe(200);
    }
    expect(mixed.d.tasks.stats().resolved).toBe(6);
  });

  it("resolved items leave the pool", async () => {
    const { earn, getBundle, d } = setup({}, makeItems(10, 6));
    const keys = [generateKeypair(), generateKeypair(), generateKeypair()];
    for (const kp of keys) await warm(earn, kp, 3);
    for (const kp of keys) expect((await earn(kp, "ten")).res.status).toBe(200);
    expect(d.tasks.stats().resolved).toBe(6);
    const { body } = await getBundle(generateKeypair(), "ten");
    expect(body.items.every((i: any) => isGolden(i.id))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Spending (SPEC 6, 7)
// ---------------------------------------------------------------------------

describe("gate", () => {
  async function voucherFor(s: ReturnType<typeof setup>, kp = generateKeypair(), tier = "two") {
    const { res, body } = await s.earn(kp, tier);
    expect(res.status).toBe(200);
    return { voucher: body.voucher as string, calls: body.calls as number, jti: decodeJwt(body.voucher).jti as string, kp };
  }

  it("missing_voucher 402 with the offer body", async () => {
    const { app } = setup();
    const res = await app.request("/search");
    expect(res.status).toBe(402);
    const body = await res.json();
    expect(body.error).toBe("missing_voucher");
    expect(OfferSchema.safeParse(body).success).toBe(true);
    expect(body.accepts[0].scheme).toBe("d402");
  });

  it("runs once per request even when mounted on both /search and /search/*", async () => {
    const s = setup();
    const { voucher, jti } = await voucherFor(s);
    const res = await s.spend(voucher, "/search");
    expect(res.status).toBe(200);
    expect(res.headers.get(HEADERS.callsRemaining)).toBe("2");
    expect(s.d.vouchers.get(jti)!.callsLeft).toBe(2);
  });

  it("spends, decrements, sets D402-Calls-Remaining, then exhausts", async () => {
    const s = setup();
    const { voucher, calls, jti } = await voucherFor(s); // tier two -> 3 calls
    expect(calls).toBe(3);
    for (let i = calls - 1; i >= 0; i--) {
      const res = await s.spend(voucher);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ hits: [] });
      expect(res.headers.get(HEADERS.callsRemaining)).toBe(String(i));
      expect(s.d.vouchers.get(jti)!.callsLeft).toBe(i);
    }
    const res = await s.spend(voucher);
    expect(res.status).toBe(402);
    expect((await res.json()).error).toBe("voucher_exhausted");
    expect(res.headers.get(HEADERS.callsRemaining)).toBeNull();
  });

  it("matches scope by path prefix and rejects paths outside it", async () => {
    const s = setup();
    const { voucher } = await voucherFor(s);
    expect((await s.spend(voucher, "/search/deep")).status).toBe(200);
    expect((await s.spend(voucher, "/search?q=x")).status).toBe(200);
    const res = await s.spend(voucher, "/other");
    expect(res.status).toBe(402);
    expect((await res.json()).error).toBe("scope_mismatch");
  });

  it("voucher_expired after voucherTtl", async () => {
    const s = setup({ voucherTtl: 100 });
    const { voucher } = await voucherFor(s);
    s.clock.advance(99);
    expect((await s.spend(voucher)).status).toBe(200);
    s.clock.advance(1);
    const res = await s.spend(voucher);
    expect(res.status).toBe(402);
    expect((await res.json()).error).toBe("voucher_expired");
  });

  it("voucher_invalid for a tampered token, a foreign secret, or an unknown jti", async () => {
    const s = setup();
    const { voucher } = await voucherFor(s);
    const [h, p, sig] = voucher.split(".");
    const tampered = `${h}.${p}.${sig!.slice(0, -2)}xx`;
    let res = await s.spend(tampered);
    expect(res.status).toBe(402);
    expect((await res.json()).error).toBe("voucher_invalid");

    const other = setup({ secret: "another-secret" });
    const foreign = await voucherFor(other);
    res = await s.spend(foreign.voucher);
    expect((await res.json()).error).toBe("voucher_invalid");

    res = await s.spend("garbage");
    expect((await res.json()).error).toBe("voucher_invalid");

    // same secret, same seller, but the jti was never minted by this store
    const twin = setup();
    const unknown = await voucherFor(twin);
    res = await s.spend(unknown.voucher);
    expect((await res.json()).error).toBe("voucher_invalid");
  });

  it("vouchers keep working after the key is blocked", async () => {
    const s = setup();
    const kp = generateKeypair();
    const { voucher } = await voucherFor(s, kp, "ten");
    for (let i = 0; i < 4; i++) expect((await s.earn(kp, "ten", "wrong")).res.status).toBe(422);
    expect(s.d.agents.get(kp.publicKey)!.blocked).toBe(true);
    expect((await s.spend(voucher)).status).toBe(200);
  });

  describe("bindVouchers (SPEC 7.1)", () => {
    function bound(kp: Keypair, jti: string, ts: number, method = "GET", path = "/search") {
      return {
        [HEADERS.key]: kp.publicKey,
        [HEADERS.timestamp]: String(ts),
        [HEADERS.sig]: signSpend(kp.privateKey, method, path, jti, ts),
      };
    }

    it("happy path, including a query string and a non-GET method", async () => {
      const s = setup({ bindVouchers: true });
      const { voucher, jti, kp } = await voucherFor(s);
      const t = s.clock.now();
      let res = await s.spend(voucher, "/search?q=hello", bound(kp, jti, t));
      expect(res.status).toBe(200);
      expect(res.headers.get(HEADERS.callsRemaining)).toBe("2");
      res = await s.spend(voucher, "/search", bound(kp, jti, t, "POST"), "POST");
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ posted: true });
    });

    it("rejects a missing or mismatched key", async () => {
      const s = setup({ bindVouchers: true });
      const { voucher, jti, kp } = await voucherFor(s);
      const other = generateKeypair();
      let res = await s.spend(voucher, "/search", bound(other, jti, s.clock.now()));
      expect(res.status).toBe(402);
      expect((await res.json()).error).toBe("bad_key");
      res = await s.spend(voucher);
      expect((await res.json()).error).toBe("bad_key");
      expect(s.d.vouchers.get(jti)!.callsLeft).toBe(3);
      void kp;
    });

    it("rejects a stale timestamp", async () => {
      const s = setup({ bindVouchers: true });
      const { voucher, jti, kp } = await voucherFor(s);
      const stale = s.clock.now() - DEFAULTS.spendTimestampSkew - 1;
      let res = await s.spend(voucher, "/search", bound(kp, jti, stale));
      expect(res.status).toBe(402);
      expect((await res.json()).error).toBe("stale_timestamp");
      const edge = s.clock.now() - DEFAULTS.spendTimestampSkew;
      res = await s.spend(voucher, "/search", bound(kp, jti, edge));
      expect(res.status).toBe(200);
    });

    it("rejects a bad or missing signature", async () => {
      const s = setup({ bindVouchers: true });
      const { voucher, jti, kp } = await voucherFor(s);
      const t = s.clock.now();
      // signed for another path
      let res = await s.spend(voucher, "/search", bound(kp, jti, t, "GET", "/search/deep"));
      expect(res.status).toBe(402);
      expect((await res.json()).error).toBe("bad_signature");
      // signed by another key but header carries the right key
      const other = generateKeypair();
      const h = bound(other, jti, t);
      h[HEADERS.key] = kp.publicKey;
      res = await s.spend(voucher, "/search", h);
      expect((await res.json()).error).toBe("bad_signature");
      // no sig at all
      res = await s.spend(voucher, "/search", { [HEADERS.key]: kp.publicKey, [HEADERS.timestamp]: String(t) });
      expect((await res.json()).error).toBe("bad_signature");
      expect(s.d.vouchers.get(jti)!.callsLeft).toBe(3);
    });
  });
});

// ---------------------------------------------------------------------------
// Rate limits (SPEC 9)
// ---------------------------------------------------------------------------

describe("rate limits", () => {
  it("per key per hour with Retry-After", async () => {
    const { getBundle, clock } = setup({ bundlesPerKeyPerHour: 2 });
    const kp = generateKeypair();
    expect((await getBundle(kp)).res.status).toBe(200);
    clock.advance(100);
    expect((await getBundle(kp)).res.status).toBe(200);
    clock.advance(100);
    const { res, body } = await getBundle(kp);
    expect(res.status).toBe(429);
    expect(body.error).toBe("rate_limited");
    expect(res.headers.get("Retry-After")).toBe(String(3600 - 200));
    // another key is unaffected
    expect((await getBundle(generateKeypair())).res.status).toBe(200);
    // the window slides
    clock.advance(3600 - 200);
    expect((await getBundle(kp)).res.status).toBe(200);
  });

  it("per IP per hour across keys, via x-forwarded-for", async () => {
    const { getBundle } = setup({ bundlesPerIpPerHour: 2 });
    const ip = { "x-forwarded-for": "203.0.113.9, 10.0.0.1" };
    expect((await getBundle(generateKeypair(), "ten", ip)).res.status).toBe(200);
    expect((await getBundle(generateKeypair(), "ten", ip)).res.status).toBe(200);
    const { res, body } = await getBundle(generateKeypair(), "ten", ip);
    expect(res.status).toBe(429);
    expect(body.error).toBe("rate_limited");
    expect(Number(res.headers.get("Retry-After"))).toBeGreaterThan(0);
    expect((await getBundle(generateKeypair(), "ten", { "x-forwarded-for": "198.51.100.1" })).res.status).toBe(200);
  });

  it("open-bundle cap per key, released by submit or expiry", async () => {
    const { getBundle, submit, answersFor, clock } = setup({ maxOpenBundlesPerKey: 2, bundleTtl: 600 });
    const kp = generateKeypair();
    const b1 = await getBundle(kp);
    expect((await getBundle(kp)).res.status).toBe(200);
    clock.advance(10);
    const { res, body } = await getBundle(kp);
    expect(res.status).toBe(429);
    expect(body.error).toBe("rate_limited");
    expect(res.headers.get("Retry-After")).toBe(String(600 - 10));

    expect((await submit(kp, b1.body.bundleId, answersFor(b1.body))).res.status).toBe(200);
    expect((await getBundle(kp)).res.status).toBe(200);
    expect((await getBundle(kp)).res.status).toBe(429);

    clock.advance(600);
    expect((await getBundle(kp)).res.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Pool management and CLI
// ---------------------------------------------------------------------------

describe("tasks and stats", () => {
  it("tasks.load ignores duplicate ids and reports the count inserted", () => {
    const { d } = setup({}, []);
    expect(d.tasks.load(makeItems(2, 3))).toBe(5);
    expect(d.tasks.load(makeItems(2, 4))).toBe(1);
    expect(d.tasks.stats()).toMatchObject({ total: 6, golden: 2, unknownOpen: 4 });
  });

  it("stats counts agents, open bundles and vouchers", async () => {
    const { d, getBundle, earn, clock } = setup({ bundleTtl: 100 });
    const kp = generateKeypair();
    await getBundle(kp);
    await earn(generateKeypair(), "two");
    expect(d.tasks.stats()).toMatchObject({ agents: 2, openBundles: 1, vouchers: 1, blockedAgents: 0 });
    clock.advance(100);
    expect(d.tasks.stats().openBundles).toBe(0);
  });

  it("loadFile reads JSONL, skipping blank lines, and rejects bad lines", () => {
    const dir = tmp();
    const file = join(dir, "items.jsonl");
    writeFileSync(file, '{"id":"g1","text":"t","golden":"a"}\n\n{"id":"u1","type":"classify","text":"x"}\n');
    const { d } = setup({}, []);
    expect(d.tasks.loadFile(file)).toBe(2);
    expect(d.tasks.loadFile(file)).toBe(0);
    const bad = join(dir, "bad.jsonl");
    writeFileSync(bad, '{"id":"g1"}\n');
    expect(() => d.tasks.loadFile(bad)).toThrow(/line 1/);
  });

  it("CLI: load, stats and export against a db file", async () => {
    const dir = tmp();
    const db = join(dir, "cli.db");
    const file = join(dir, "items.jsonl");
    writeFileSync(
      file,
      makeItems(10, 6)
        .map((i) => JSON.stringify(i))
        .join("\n") + "\n",
    );
    const root = join(import.meta.dirname, "..", "..", "..");
    const cli = join(import.meta.dirname, "cli.ts");
    const run = (...args: string[]) => {
      const r = spawnSync(process.execPath, ["--import", "tsx", cli, ...args], { cwd: root, encoding: "utf8" });
      return { status: r.status, out: r.stdout, err: r.stderr };
    };

    const load = run("load", db, file);
    expect(load.status, load.err).toBe(0);
    expect(load.out).toMatch(/loaded 16 item/);
    expect(run("load", db, file).out).toMatch(/loaded 0 item/);

    let stats = run("stats", db);
    expect(stats.status).toBe(0);
    expect(JSON.parse(stats.out)).toMatchObject({ total: 16, golden: 10, unknownOpen: 6, resolved: 0 });

    expect(run("export", db).out).toBe("");

    // resolve the pool through a server on the same db file, then export via the CLI
    const { earn, d } = setup({ db }, []);
    const keys = [generateKeypair(), generateKeypair(), generateKeypair()];
    for (const kp of keys) for (let i = 0; i < 3; i++) expect((await earn(kp, "one")).res.status).toBe(200);
    for (const kp of keys) expect((await earn(kp, "ten")).res.status).toBe(200);
    expect(d.tasks.stats().resolved).toBe(6);
    d.close();

    stats = run("stats", db);
    expect(JSON.parse(stats.out)).toMatchObject({ resolved: 6, unknownOpen: 0, agents: 3 });
    const exp = run("export", db);
    expect(exp.status).toBe(0);
    const lines = exp.out.trim().split("\n").map((l) => JSON.parse(l));
    expect(lines).toHaveLength(6);
    expect(lines[0]).toMatchObject({ id: "u1", text: "unknown 1", answer: "a", voters: 3 });

    expect(run().status).toBe(2);
    expect(run("bogus", db).status).toBe(2);
    expect(readFileSync(file, "utf8")).toContain('"g1"');
  });
});
