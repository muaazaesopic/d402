/**
 * Abuse and edge cases, hand-rolled over fetch with the @d402/spec signing
 * helpers (no client wrapper), against a real server on an ephemeral port.
 */
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULTS, HEADERS, findD402Accept, generateKeypair, signSubmit, type Bundle, type TaskFileItem } from "@d402/spec";
import { goldenCount } from "@d402/server";
import {
  LABELS,
  answersFor,
  lazySolver,
  newAgent,
  perfectSolver,
  rawEarn,
  rawGetBundle,
  rawSpend,
  rawSubmit,
  startSeller,
  tamperJwtSignature,
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

async function bundleFor(s: Seller, publicKey: string, tier = "s"): Promise<Bundle> {
  const got = await rawGetBundle(s, publicKey, tier);
  expect(got.status, JSON.stringify(got.body)).toBe(200);
  return got.body as Bundle;
}

describe("submit signatures", () => {
  it("a signature from a different keypair is 401 bad_signature", async () => {
    const s = await seller();
    const a = generateKeypair();
    const b = generateKeypair();
    const bundle = await bundleFor(s, a.publicKey);
    const answers = answersFor(bundle, s.truth);
    const res = await rawSubmit(s, a, bundle.bundleId, answers, { sig: signSubmit(b.privateKey, bundle.bundleId, answers) });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("bad_signature");
    expect(res.body.voucher).toBeUndefined();
    expect(s.d402.tasks.stats().vouchers).toBe(0);
    // the bundle is still open: a correctly signed submit afterwards passes
    const ok = await rawSubmit(s, a, bundle.bundleId, answers);
    expect(ok.status).toBe(200);
  });

  it("submitting A's bundle under B's key header (signed by B) yields no voucher", async () => {
    const s = await seller();
    const a = generateKeypair();
    const b = generateKeypair();
    const bundle = await bundleFor(s, a.publicKey);
    const answers = answersFor(bundle, s.truth);
    const res = await rawSubmit(s, b, bundle.bundleId, answers);
    expect([401, 404]).toContain(res.status);
    expect(["bad_signature", "unknown_bundle"]).toContain(res.body.error);
    expect(res.body.voucher).toBeUndefined();
    expect(s.d402.tasks.stats().vouchers).toBe(0);
    expect(s.d402.agents.get(b.publicKey)?.bundles ?? 0).toBe(0);
  });

  it("a signature over different answers than the ones sent is bad_signature", async () => {
    const s = await seller();
    const a = generateKeypair();
    const bundle = await bundleFor(s, a.publicKey);
    const answers = answersFor(bundle, s.truth);
    const other = { ...answers, [bundle.items[0]!.id]: LABELS.find((l) => l !== answers[bundle.items[0]!.id])! };
    const res = await rawSubmit(s, a, bundle.bundleId, other, { sig: signSubmit(a.privateKey, bundle.bundleId, answers) });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("bad_signature");
  });

  it("resubmitting a passed bundle is 409 already_submitted and mints no second voucher", async () => {
    const s = await seller();
    const a = generateKeypair();
    const bundle = await bundleFor(s, a.publicKey);
    const answers = answersFor(bundle, s.truth);
    const first = await rawSubmit(s, a, bundle.bundleId, answers);
    expect(first.status).toBe(200);
    const second = await rawSubmit(s, a, bundle.bundleId, answers);
    expect(second.status).toBe(409);
    expect(second.body.error).toBe("already_submitted");
    expect(s.d402.tasks.stats().vouchers).toBe(1);
    expect(s.d402.agents.get(a.publicKey)?.bundles).toBe(1);
  });

  it("resubmitting a failed bundle is also already_submitted (no second try on the same goldens)", async () => {
    const s = await seller();
    const a = generateKeypair();
    const bundle = await bundleFor(s, a.publicKey);
    const bad = await wrongSolver(s.truth)(bundle);
    expect((await rawSubmit(s, a, bundle.bundleId, bad)).status).toBe(422);
    const retry = await rawSubmit(s, a, bundle.bundleId, answersFor(bundle, s.truth));
    expect(retry.status).toBe(409);
    expect(retry.body.error).toBe("already_submitted");
  });

  it("an unknown bundle id is 404 unknown_bundle", async () => {
    const s = await seller();
    const a = generateKeypair();
    const res = await rawSubmit(s, a, "b_nope", {});
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("unknown_bundle");
  });
});

describe("vouchers", () => {
  it("a tampered voucher signature is 402 voucher_invalid", async () => {
    const s = await seller();
    const a = generateKeypair();
    const { sub } = await rawEarn(s, a, perfectSolver(s.truth));
    expect(sub.status).toBe(200);
    const res = await rawSpend(s, tamperJwtSignature(sub.body.voucher!));
    expect(res.status).toBe(402);
    expect(res.body.error).toBe("voucher_invalid");
    // the real one still has all its calls
    const claims = JSON.parse(Buffer.from(sub.body.voucher!.split(".")[1]!, "base64url").toString()) as { jti: string };
    expect(s.d402.vouchers.get(claims.jti)?.callsLeft).toBe(10);
  });

  it("a voucher with a forged payload (more scope) is voucher_invalid", async () => {
    const s = await seller();
    const a = generateKeypair();
    const { sub } = await rawEarn(s, a, perfectSolver(s.truth));
    const [h, p, sig] = sub.body.voucher!.split(".");
    const claims = JSON.parse(Buffer.from(p!, "base64url").toString()) as Record<string, unknown>;
    claims.scope = ["/", "/search"];
    const forged = [h, Buffer.from(JSON.stringify(claims)).toString("base64url"), sig].join(".");
    const res = await rawSpend(s, forged);
    expect(res.status).toBe(402);
    expect(res.body.error).toBe("voucher_invalid");
  });

  it("a voucher is voucher_expired once the seller clock passes exp; the client evicts and re-earns", async () => {
    const s = await seller();
    const agent = newAgent(s.baseUrl, { solver: perfectSolver(s.truth) });
    const first = await agent.fetch(`${s.baseUrl}/search?q=x`);
    expect(first.status).toBe(200);
    const old = (await agent.status())[0]!;

    s.clock.t += DEFAULTS.voucherTtl + 1;
    const raw = await rawSpend(s, old.token);
    expect(raw.status).toBe(402);
    expect(raw.body.error).toBe("voucher_expired");

    // the client's own clock is real time, so it still believes in the voucher,
    // sends it, gets voucher_expired, evicts it and earns a fresh one
    const again = await agent.fetch(`${s.baseUrl}/search?q=y`);
    expect(again.status).toBe(200);
    expect(again.headers.get(HEADERS.callsRemaining)).toBe("9");
    const now = await agent.status();
    expect(now.map((v) => v.jti)).not.toContain(old.jti);
    expect(now).toHaveLength(1);
    expect(s.d402.agents.get(agent.keypair.publicKey)?.bundles).toBe(2);
  });

  it("a missing voucher header is 402 missing_voucher with the offer", async () => {
    const s = await seller();
    const res = await rawSpend(s, undefined);
    expect(res.status).toBe(402);
    expect(res.body.error).toBe("missing_voucher");
    expect(findD402Accept(res.body as never)).toBeDefined();
  });

  it("a voucher minted by a seller with another secret is voucher_invalid here", async () => {
    const s1 = await seller();
    const s2 = await seller({ secret: "other-secret" });
    const a = generateKeypair();
    const { sub } = await rawEarn(s2, a, perfectSolver(s2.truth));
    expect(sub.status).toBe(200);
    const res = await rawSpend(s1, sub.body.voucher!);
    expect(res.status).toBe(402);
    expect(res.body.error).toBe("voucher_invalid");
  });
});

describe("bundle lifecycle", () => {
  it("a bundle submitted after bundleTtl is 410 expired_bundle", async () => {
    const s = await seller();
    const a = generateKeypair();
    const bundle = await bundleFor(s, a.publicKey);
    s.clock.t += DEFAULTS.bundleTtl + 1;
    const res = await rawSubmit(s, a, bundle.bundleId, answersFor(bundle, s.truth));
    expect(res.status).toBe(410);
    expect(res.body.error).toBe("expired_bundle");
    expect(s.d402.agents.get(a.publicKey)?.bundles).toBe(0);
  });

  it("a bundle submitted just before expiry still passes", async () => {
    const s = await seller();
    const a = generateKeypair();
    const bundle = await bundleFor(s, a.publicKey);
    s.clock.t += DEFAULTS.bundleTtl - 1;
    const res = await rawSubmit(s, a, bundle.bundleId, answersFor(bundle, s.truth));
    expect(res.status).toBe(200);
  });

  it("answers missing an item are 400 incomplete", async () => {
    const s = await seller();
    const a = generateKeypair();
    const bundle = await bundleFor(s, a.publicKey);
    const answers = answersFor(bundle, s.truth);
    delete answers[bundle.items[2]!.id];
    const res = await rawSubmit(s, a, bundle.bundleId, answers);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("incomplete");
    // not consumed: the same bundle can still be completed
    expect((await rawSubmit(s, a, bundle.bundleId, answersFor(bundle, s.truth))).status).toBe(200);
  });

  it("a label outside the seller's labels is 400 bad_label", async () => {
    const s = await seller();
    const a = generateKeypair();
    const bundle = await bundleFor(s, a.publicKey);
    const answers = answersFor(bundle, s.truth);
    answers[bundle.items[0]!.id] = "politics";
    const res = await rawSubmit(s, a, bundle.bundleId, answers);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("bad_label");
  });

  it("a non-JSON body is 400 bad_request, and so is JSON of the wrong shape", async () => {
    const s = await seller();
    const a = generateKeypair();
    const bundle = await bundleFor(s, a.publicKey);
    const text = await rawSubmit(s, a, bundle.bundleId, {}, { rawBody: "this is not json" });
    expect(text.status).toBe(400);
    expect(text.body.error).toBe("bad_request");
    const shape = await rawSubmit(s, a, bundle.bundleId, {}, { rawBody: JSON.stringify({ answers: "x" }) });
    expect(shape.status).toBe(400);
    expect(shape.body.error).toBe("bad_request");
  });

  it("missing / malformed D402-Key on GET tasks is 400", async () => {
    const s = await seller();
    const none = await fetch(`${s.taskUrl}?tier=s`);
    expect(none.status).toBe(400);
    expect(((await none.json()) as { error: string }).error).toBe("missing_key");
    const bad = await rawGetBundle(s, "not-a-key", "s");
    expect(bad.status).toBe(400);
    expect(bad.body.error).toBe("bad_key");
    const tier = await rawGetBundle(s, generateKeypair().publicKey, "xl");
    expect(tier.status).toBe(400);
    expect(tier.body.error).toBe("bad_tier");
  });
});

describe("rate limits", () => {
  it("bundlesPerKeyPerHour=3: the 4th GET is 429 with Retry-After >= 1; +3601s lifts it", async () => {
    const s = await seller({ bundlesPerKeyPerHour: 3 });
    const a = generateKeypair();
    for (let i = 0; i < 3; i++) expect((await rawGetBundle(s, a.publicKey)).status).toBe(200);
    const limited = await rawGetBundle(s, a.publicKey);
    expect(limited.status).toBe(429);
    expect(limited.body.error).toBe("rate_limited");
    const retry = Number(limited.headers.get("retry-after"));
    expect(retry).toBeGreaterThanOrEqual(1);
    expect(retry).toBeLessThanOrEqual(3600);
    // another key is unaffected
    expect((await rawGetBundle(s, generateKeypair().publicKey)).status).toBe(200);
    s.clock.t += 3601;
    expect((await rawGetBundle(s, a.publicKey)).status).toBe(200);
  });

  it("per-IP limit via x-forwarded-for applies across two keys sharing an IP", async () => {
    const s = await seller({ bundlesPerIpPerHour: 2 });
    const a = generateKeypair();
    const b = generateKeypair();
    const ip = { "x-forwarded-for": "203.0.113.9, 10.0.0.1" };
    expect((await rawGetBundle(s, a.publicKey, "s", ip)).status).toBe(200);
    expect((await rawGetBundle(s, a.publicKey, "s", ip)).status).toBe(200);
    const limited = await rawGetBundle(s, b.publicKey, "s", ip);
    expect(limited.status).toBe(429);
    expect(limited.body.error).toBe("rate_limited");
    expect(limited.body.message).toMatch(/IP/);
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThanOrEqual(1);
    // a different forwarded IP is fine
    expect((await rawGetBundle(s, b.publicKey, "s", { "x-forwarded-for": "198.51.100.7" })).status).toBe(200);
  });

  it("maxOpenBundlesPerKey=2: a third GET without submitting is 429, submitting frees a slot", async () => {
    const s = await seller({ maxOpenBundlesPerKey: 2 });
    const a = generateKeypair();
    const b1 = await bundleFor(s, a.publicKey);
    await bundleFor(s, a.publicKey);
    const third = await rawGetBundle(s, a.publicKey);
    expect(third.status).toBe(429);
    expect(third.body.error).toBe("rate_limited");
    expect(third.body.message).toMatch(/open/);
    expect(Number(third.headers.get("retry-after"))).toBe(DEFAULTS.bundleTtl);
    expect((await rawSubmit(s, a, b1.bundleId, answersFor(b1, s.truth))).status).toBe(200);
    expect((await rawGetBundle(s, a.publicKey)).status).toBe(200);
  });
});

describe("unknown hand-out", () => {
  /**
   * From store.unknownCandidates: an unknown is never re-handed to a key that
   * has it in a submitted or still-open bundle. The helper pool knows which
   * ids are golden, so the assertion is exact: with one key and a perfect
   * solver, (1) no unknown id appears twice across bundles, (2) the distinct
   * unknowns seen equals the whole unknown pool once it is exhausted, and
   * (3) later bundles are filled entirely with goldens (which may repeat).
   */
  it("a key never sees the same unknown twice; once exhausted, bundles are all goldens", async () => {
    const pool = {
      items: [] as TaskFileItem[],
      truth: new Map<string, (typeof LABELS)[number]>(),
      goldenIds: new Set<string>(),
    };
    for (let i = 0; i < 20; i++) {
      const label = LABELS[i % 4]!;
      const id = `g${i}`;
      pool.items.push({ id, type: "classify", text: `golden ${i}`, golden: label });
      pool.truth.set(id, label);
      pool.goldenIds.add(id);
    }
    for (let i = 0; i < 12; i++) {
      const label = LABELS[i % 4]!;
      pool.items.push({ id: `u${i}`, type: "classify", text: `unknown ${i}` });
      pool.truth.set(`u${i}`, label);
    }
    const s = await seller({ pool });
    const a = generateKeypair();
    const seenUnknown: string[] = [];
    const perBundleUnknowns: number[] = [];
    for (let i = 0; i < 8; i++) {
      const { bundle, sub } = await rawEarn(s, a, perfectSolver(s.truth), "s");
      expect(sub.status).toBe(200);
      const unknowns = bundle.items.filter((it) => !s.goldenIds.has(it.id)).map((it) => it.id);
      perBundleUnknowns.push(unknowns.length);
      seenUnknown.push(...unknowns);
      expect(bundle.items).toHaveLength(5);
    }
    expect(new Set(seenUnknown).size).toBe(seenUnknown.length); // no unknown repeats
    expect(new Set(seenUnknown).size).toBe(12); // the whole unknown pool was handed out exactly once
    // 5 items, 2 goldens (40%) -> 3 unknowns per bundle until the pool runs dry: 3,3,3,3,0,0,0,0
    expect(perBundleUnknowns).toEqual([3, 3, 3, 3, 0, 0, 0, 0]);
    expect(s.d402.tasks.stats()).toMatchObject({ unknownOpen: 12, resolved: 0 });
  });

  it("an unknown in an open (unsubmitted) bundle is not re-handed to the same key but is to another", async () => {
    const s = await seller();
    const a = generateKeypair();
    const b = generateKeypair();
    const b1 = await bundleFor(s, a.publicKey, "m");
    const b2 = await bundleFor(s, a.publicKey, "m");
    const u1 = new Set(b1.items.filter((i) => !s.goldenIds.has(i.id)).map((i) => i.id));
    const u2 = b2.items.filter((i) => !s.goldenIds.has(i.id)).map((i) => i.id);
    expect(u2.length).toBeGreaterThan(0);
    for (const id of u2) expect(u1.has(id)).toBe(false);
    const other = await bundleFor(s, b.publicKey, "m");
    const uo = other.items.filter((i) => !s.goldenIds.has(i.id)).map((i) => i.id);
    // key B starts from the fewest-votes-first pool, i.e. the same unknowns A got
    expect(uo.filter((id) => u1.has(id)).length).toBe(uo.length);
  });
});

describe("golden retirement", () => {
  it("goldenMaxExposures=2 with 3 goldens and no unknowns: 6 one-item bundles, then 409 no_tasks", async () => {
    const pool = { items: [] as TaskFileItem[], truth: new Map<string, (typeof LABELS)[number]>(), goldenIds: new Set<string>() };
    for (let i = 0; i < 3; i++) {
      const label = LABELS[i]!;
      pool.items.push({ id: `g${i}`, type: "classify", text: `golden ${i}`, golden: label });
      pool.truth.set(`g${i}`, label);
      pool.goldenIds.add(`g${i}`);
    }
    const s = await seller({
      pool,
      goldenMaxExposures: 2,
      tiers: [{ id: "one", items: 1, est_tokens: 10, reward: { calls: 1 } }],
    });
    const a = generateKeypair();
    const exposures = new Map<string, number>();
    for (let i = 0; i < 6; i++) {
      const { bundle, sub } = await rawEarn(s, a, perfectSolver(s.truth), "one");
      expect(sub.status).toBe(200);
      expect(bundle.items).toHaveLength(1);
      const id = bundle.items[0]!.id;
      exposures.set(id, (exposures.get(id) ?? 0) + 1);
      expect(exposures.get(id)).toBeLessThanOrEqual(2);
    }
    expect([...exposures.values()]).toEqual([2, 2, 2]);
    const seventh = await rawGetBundle(s, a.publicKey, "one");
    expect(seventh.status).toBe(409);
    expect(seventh.body.error).toBe("no_tasks");
    expect(s.d402.tasks.stats()).toMatchObject({ golden: 3, retiredGolden: 3 });
  });

  it("an empty pool is 409 no_tasks from the first GET", async () => {
    const s = await seller({ pool: { items: [], truth: new Map(), goldenIds: new Set() } });
    const res = await rawGetBundle(s, generateKeypair().publicKey);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("no_tasks");
  });
});

describe("blocking", () => {
  it("a lazy solver is 403 blocked by the 6th GET tasks at the latest", async () => {
    const s = await seller();
    const a = generateKeypair();
    let blockedAt: number | undefined;
    for (let i = 1; i <= 6; i++) {
      const got = await rawGetBundle(s, a.publicKey, "s");
      if (got.status === 403) {
        expect(got.body.error).toBe("blocked");
        blockedAt = i;
        break;
      }
      expect(got.status).toBe(200);
      const bundle = got.body as Bundle;
      const sub = await rawSubmit(s, a, bundle.bundleId, await lazySolver()(bundle));
      expect([200, 422]).toContain(sub.status);
    }
    expect(blockedAt).toBeDefined();
    expect(blockedAt!).toBeLessThanOrEqual(6);
    const rec = s.d402.agents.get(a.publicKey)!;
    expect(rec.blocked).toBe(true);
    expect(rec.bundles).toBeGreaterThanOrEqual(5);
    expect(rec.accuracy).toBeLessThan(0.6);
    expect(s.d402.tasks.stats().blockedAgents).toBe(1);
    // POST is blocked too
    const post = await rawSubmit(s, a, "b_whatever", {});
    expect(post.status).toBe(403);
    expect(post.body.error).toBe("blocked");
  });

  it("a voucher earned before the key was blocked still spends", async () => {
    const s = await seller();
    const a = generateKeypair();
    const { sub } = await rawEarn(s, a, perfectSolver(s.truth));
    expect(sub.status).toBe(200);
    // 1 good + 4 wrong = 5 bundles, 10 goldens seen, 2 correct -> 3/12 = 0.25 < 0.6
    for (let i = 0; i < 4; i++) {
      const { sub: bad } = await rawEarn(s, a, wrongSolver(s.truth));
      expect(bad.status).toBe(422);
    }
    expect(s.d402.agents.get(a.publicKey)).toMatchObject({ bundles: 5, blocked: true });
    expect((await rawGetBundle(s, a.publicKey)).status).toBe(403);
    const spend = await rawSpend(s, sub.body.voucher!);
    expect(spend.status).toBe(200);
    expect(spend.headers.get(HEADERS.callsRemaining)).toBe("9");
  });

  it("5 bundles with accuracy exactly at the floor are not blocked", async () => {
    // 5 bundles x 2 goldens = 10 seen; (c + 1) / 12 >= 0.6 needs c >= 7
    const s = await seller();
    const a = generateKeypair();
    for (let i = 0; i < 5; i++) {
      const got = await bundleFor(s, a.publicKey);
      const answers = answersFor(got, s.truth);
      if (i < 3) {
        // get one golden wrong in the first three bundles -> 7 of 10 correct
        const golden = got.items.find((it) => s.goldenIds.has(it.id))!;
        answers[golden.id] = LABELS.find((l) => l !== answers[golden.id])!;
      }
      await rawSubmit(s, a, got.bundleId, answers);
    }
    const rec = s.d402.agents.get(a.publicKey)!;
    expect(rec).toMatchObject({ bundles: 5, goldenSeen: 10, goldenCorrect: 7, blocked: false });
    expect((await rawGetBundle(s, a.publicKey)).status).toBe(200);
  });
});

describe("trust bands", () => {
  /** The helper pool knows which ids are golden, so the ratio is observable directly. */
  it("golden share drops from 40% to 20% after 10 clean bundles and to ~10% after 50", async () => {
    const s = await seller({ bundlesPerKeyPerHour: 1000, poolSize: 2000, goldenFraction: 0.1 });
    const a = generateKeypair();
    const counts: number[] = [];
    for (let i = 0; i < 51; i++) {
      const { bundle, sub } = await rawEarn(s, a, perfectSolver(s.truth), "m");
      expect(sub.status).toBe(200);
      const rec = s.d402.agents.get(a.publicKey)!;
      counts.push(bundle.items.filter((it) => s.goldenIds.has(it.id)).length);
      // the bundle was built with the record as it was BEFORE this submit
      expect(counts[i]).toBe(goldenCount(25, { ...rec, bundles: rec.bundles - 1, goldenSeen: rec.goldenSeen - counts[i]!, goldenCorrect: rec.goldenCorrect - counts[i]! }));
    }
    expect(counts.slice(0, 10)).toEqual(Array(10).fill(10)); // 25 * 0.4
    expect(counts.slice(10, 50)).toEqual(Array(40).fill(5)); // 25 * 0.2
    expect(counts[50]).toBe(3); // round(25 * 0.1) = round(2.5) = 3 in JS
    expect(s.d402.agents.get(a.publicKey)!.accuracy).toBeGreaterThanOrEqual(0.95);
  });
});
