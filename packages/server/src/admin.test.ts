import { Hono } from "hono";
import { afterEach, describe, expect, it } from "vitest";
import { HEADERS, generateKeypair, signSubmit, type Bundle, type Keypair, type TaskFileItem, type Tier } from "@d402/spec";
import { createD402, type D402ServerOptions } from "./index.js";
import { ADMIN_PATH, deriveAdminEvents, type AdminEvent, type AdminStatsBody } from "./admin.js";
import { SqliteStore } from "./store.js";

// ---------------------------------------------------------------------------
// Fixtures (mirrors server.test.ts)
// ---------------------------------------------------------------------------

const LABELS = ["a", "b", "c"];
const T0 = 1_760_000_000;
const TASK_URL = "http://localhost/.well-known/d402/tasks";
const TOKEN = "s3cret-admin";
const AUTH = { authorization: `Bearer ${TOKEN}` };

const TIERS: Tier[] = [
  { id: "one", items: 1, est_tokens: 100, reward: { calls: 2 } },
  { id: "two", items: 2, est_tokens: 200, reward: { calls: 3 } },
  { id: "ten", items: 10, est_tokens: 1000, reward: { calls: 10 } },
];

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
  const clock = { now: () => t, advance: (s: number) => (t += s) };
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
    adminToken: TOKEN,
    ...over,
  });
  d.tasks.load(items);
  cleanups.push(() => d.close());

  const app = new Hono();
  app.route("/", d.routes);
  app.use("/search", d.gate);
  app.get("/search", (c) => c.json({ hits: [] }));

  async function getBundle(kp: Keypair, tier = "ten") {
    const res = await app.request(`${TASK_URL}?tier=${tier}`, { headers: { [HEADERS.key]: kp.publicKey } });
    return { res, body: (await res.json()) as any };
  }

  async function submit(kp: Keypair, bundleId: string, answers: Record<string, string>) {
    const res = await app.request(`${TASK_URL}/${bundleId}`, {
      method: "POST",
      headers: { "content-type": "application/json", [HEADERS.key]: kp.publicKey },
      body: JSON.stringify({ answers, sig: signSubmit(kp.privateKey, bundleId, answers) }),
    });
    return { res, body: (await res.json()) as any };
  }

  function answersFor(b: Bundle, mode: "perfect" | "wrong" = "perfect") {
    const a: Record<string, string> = {};
    for (const it of b.items) {
      if (isGolden(it.id)) a[it.id] = mode === "perfect" ? GOLDEN_ANSWER(it.id) : WRONG(it.id);
      else a[it.id] = "a";
    }
    return a;
  }

  /** Earn one bundle and submit it; returns { bundleId, res, body }. */
  async function earn(kp: Keypair, tier = "ten", mode: "perfect" | "wrong" = "perfect") {
    const { res, body } = await getBundle(kp, tier);
    expect(res.status, JSON.stringify(body)).toBe(200);
    const out = await submit(kp, body.bundleId, answersFor(body, mode));
    return { bundleId: body.bundleId as string, ...out };
  }

  const admin = (path: string, headers: Record<string, string> = AUTH) =>
    app.request(`http://localhost${ADMIN_PATH}${path}`, { headers });

  return { d, app, clock, getBundle, submit, answersFor, earn, admin };
}

async function events(s: ReturnType<typeof setup>, qs = ""): Promise<AdminEvent[]> {
  const res = await s.admin(`/events${qs}`);
  expect(res.status).toBe(200);
  return ((await res.json()) as { events: AdminEvent[] }).events;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("admin: mounting and auth", () => {
  it("is not mounted when adminToken is unset (404)", async () => {
    const s = setup({ adminToken: undefined });
    for (const p of ["/stats", "/export", "/agents", "/events"]) {
      expect((await s.admin(p)).status, p).toBe(404);
    }
  });

  it("treats an empty adminToken as unset", async () => {
    const s = setup({ adminToken: "" });
    expect((await s.admin("/stats")).status).toBe(404);
  });

  it("returns 401 { error: 'unauthorized' } without a bearer token", async () => {
    const s = setup();
    for (const p of ["/stats", "/export", "/agents", "/events"]) {
      const res = await s.admin(p, {});
      expect(res.status, p).toBe(401);
      expect(await res.json()).toEqual({ error: "unauthorized" });
      expect(res.headers.get("www-authenticate")).toMatch(/^Bearer/);
    }
  });

  it("returns 401 for a wrong token, a wrong scheme and a token prefix", async () => {
    const s = setup();
    expect((await s.admin("/stats", { authorization: "Bearer nope" })).status).toBe(401);
    expect((await s.admin("/stats", { authorization: `Basic ${TOKEN}` })).status).toBe(401);
    expect((await s.admin("/stats", { authorization: `Bearer ${TOKEN.slice(0, -1)}` })).status).toBe(401);
    expect((await s.admin("/stats", { authorization: `Bearer ${TOKEN}x` })).status).toBe(401);
  });

  it("accepts the token case-insensitively on the scheme and with extra spaces", async () => {
    const s = setup();
    expect((await s.admin("/stats", { authorization: `bearer   ${TOKEN}` })).status).toBe(200);
  });

  it("does not leak admin routes through the gate or the offer", async () => {
    const s = setup();
    const offer = (await (await s.app.request("http://localhost/.well-known/d402")).json()) as any;
    expect(JSON.stringify(offer)).not.toContain("admin");
    const res = await s.admin("/stats");
    expect(res.headers.get("cache-control")).toBe("no-store");
  });
});

describe("admin: stats and agents", () => {
  it("GET /stats has { stats, agents, resolvedCount, now }", async () => {
    const s = setup();
    const kp = generateKeypair();
    await s.earn(kp, "ten");
    const res = await s.admin("/stats");
    expect(res.status).toBe(200);
    const body = (await res.json()) as AdminStatsBody;
    expect(body.now).toBe(T0);
    expect(body.resolvedCount).toBe(0);
    expect(body.stats).toEqual(s.d.tasks.stats());
    expect(body.stats).toMatchObject({ total: 40, golden: 10, unknownOpen: 30, resolved: 0, agents: 1, vouchers: 1 });
    expect(body.agents).toEqual(s.d.agents.list());
    expect(body.agents[0]).toMatchObject({ publicKey: kp.publicKey, bundles: 1, blocked: false });
  });

  it("GET /agents lists AgentRecords with accuracy and blocked", async () => {
    const s = setup();
    const good = generateKeypair();
    const bad = generateKeypair();
    await s.earn(good, "ten");
    for (let i = 0; i < 5; i++) await s.earn(bad, "ten", "wrong");
    const res = await s.admin("/agents");
    expect(res.status).toBe(200);
    const list = (await res.json()) as any[];
    expect(list).toHaveLength(2);
    const g = list.find((a) => a.publicKey === good.publicKey);
    const b = list.find((a) => a.publicKey === bad.publicKey);
    expect(g).toMatchObject({ bundles: 1, blocked: false });
    expect(g.goldenCorrect).toBe(g.goldenSeen);
    expect(g.accuracy).toBeGreaterThan(0.5);
    expect(b).toMatchObject({ bundles: 5, goldenCorrect: 0, blocked: true });
    expect(b.accuracy).toBeLessThan(0.6);
  });
});

describe("admin: export", () => {
  it("GET /export is an empty application/x-ndjson body when nothing is resolved", async () => {
    const s = setup();
    const res = await s.admin("/export");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/^application\/x-ndjson/);
    expect(await res.text()).toBe("");
  });

  it("GET /export streams JSONL after 3 agents resolve an item", async () => {
    // 5 goldens, 1 unknown: tier "two" hands out 1 golden + u1 to everyone.
    const s = setup({}, makeItems(5, 1));
    const agents = [generateKeypair(), generateKeypair(), generateKeypair()];
    // Warm up: a golden-only bundle lifts each key's accuracy to 2/3 so three votes reach weight 2.0.
    for (const kp of agents) {
      const r = await s.earn(kp, "one");
      expect(r.res.status).toBe(200);
    }
    for (const kp of agents) {
      s.clock.advance(1);
      const r = await s.earn(kp, "two");
      expect(r.res.status).toBe(200);
    }
    expect(s.d.tasks.stats().resolved).toBe(1);

    const res = await s.admin("/export");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/^application\/x-ndjson/);
    const text = await res.text();
    expect(text.endsWith("\n")).toBe(true);
    const lines = text.trimEnd().split("\n").map((l) => JSON.parse(l));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ id: "u1", text: "unknown 1", answer: "a", voters: 3 });
    expect(lines[0].weight).toBeCloseTo(2, 9);
    expect(lines).toEqual(s.d.tasks.exportResolved());

    const stats = (await (await s.admin("/stats")).json()) as AdminStatsBody;
    expect(stats.resolvedCount).toBe(1);
  });
});

describe("admin: events", () => {
  it("records bundle_issued then bundle_passed, oldest first", async () => {
    const s = setup();
    const kp = generateKeypair();
    const { body: b } = await s.getBundle(kp, "ten");
    s.clock.advance(5);
    await s.submit(kp, b.bundleId, s.answersFor(b));

    const ev = await events(s);
    const types = ev.map((e) => e.type);
    expect(types).toEqual(["bundle_issued", "bundle_passed", "voucher_issued"]);
    expect(ev[0]).toMatchObject({ t: T0, key: kp.publicKey, bundleId: b.bundleId, tier: "ten" });
    expect(ev[1]).toMatchObject({ t: T0 + 5, key: kp.publicKey, bundleId: b.bundleId, tier: "ten" });
    expect(ev[2]).toMatchObject({ t: T0 + 5, key: kp.publicKey, calls: 10 });
    expect(typeof ev[2]!.jti).toBe("string");
    expect(s.d.vouchers.get(ev[2]!.jti!)?.callsLeft).toBe(10);
  });

  it("records bundle_failed with no voucher on a quality failure", async () => {
    const s = setup();
    const kp = generateKeypair();
    const r = await s.earn(kp, "ten", "wrong");
    expect(r.res.status).toBe(422);
    const ev = await events(s);
    expect(ev.map((e) => e.type)).toEqual(["bundle_issued", "bundle_failed"]);
    expect(ev[1]).toMatchObject({ bundleId: r.bundleId, key: kp.publicKey });
  });

  it("marks a golden-only bundle as passed via its voucher (no votes to go on)", async () => {
    const s = setup();
    const kp = generateKeypair();
    const r = await s.earn(kp, "one");
    expect(r.res.status).toBe(200);
    const ev = await events(s);
    expect(ev.map((e) => e.type)).toEqual(["bundle_issued", "bundle_passed", "voucher_issued"]);
  });

  it("records item_resolved and agent_blocked", async () => {
    const s = setup({}, makeItems(5, 1));
    const agents = [generateKeypair(), generateKeypair(), generateKeypair()];
    for (const kp of agents) await s.earn(kp, "one");
    for (const kp of agents) {
      s.clock.advance(10);
      await s.earn(kp, "two");
    }
    const bad = generateKeypair();
    for (let i = 0; i < 5; i++) {
      s.clock.advance(10);
      await s.earn(bad, "one", "wrong");
    }

    const ev = await events(s);
    const resolved = ev.filter((e) => e.type === "item_resolved");
    expect(resolved).toHaveLength(1);
    expect(resolved[0]).toMatchObject({ itemId: "u1", answer: "a", voters: 3, t: T0 + 30 });
    const blocked = ev.filter((e) => e.type === "agent_blocked");
    expect(blocked).toHaveLength(1);
    expect(blocked[0]).toMatchObject({ key: bad.publicKey, t: T0 + 80 });
    // the blocked event is the last thing that happened
    expect(ev[ev.length - 1]!.type).toBe("agent_blocked");
  });

  it("is sorted ascending by t and never reorders issued after passed", async () => {
    const s = setup();
    const kps = [generateKeypair(), generateKeypair(), generateKeypair()];
    for (const kp of kps) {
      await s.earn(kp, "ten");
      s.clock.advance(7);
    }
    const ev = await events(s);
    expect(ev).toHaveLength(9);
    for (let i = 1; i < ev.length; i++) expect(ev[i]!.t).toBeGreaterThanOrEqual(ev[i - 1]!.t);
    for (let i = 0; i < ev.length; i += 3) {
      expect(ev[i]!.type).toBe("bundle_issued");
      expect(ev[i + 1]!.type).toBe("bundle_passed");
      expect(ev[i + 2]!.type).toBe("voucher_issued");
      expect(ev[i]!.bundleId).toBe(ev[i + 1]!.bundleId);
    }
  });

  it("filters with ?since=", async () => {
    const s = setup();
    const kp = generateKeypair();
    await s.earn(kp, "ten");
    s.clock.advance(100);
    const second = await s.earn(kp, "ten");
    const ev = await events(s, `?since=${T0 + 100}`);
    expect(ev.map((e) => e.type)).toEqual(["bundle_issued", "bundle_passed", "voucher_issued"]);
    expect(ev[0]!.bundleId).toBe(second.bundleId);
    expect(await events(s, `?since=${T0 + 101}`)).toEqual([]);
    expect(await events(s, "?since=")).toHaveLength(6);
  });

  it("rejects a non-numeric since with 400", async () => {
    const s = setup();
    const res = await s.admin("/events?since=yesterday");
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "bad_request" });
    expect((await s.admin("/events?since=-5")).status).toBe(400);
  });

  it("caps the stream at the last 200 events", async () => {
    const s = setup({}, makeItems(10, 500));
    const kp = generateKeypair();
    for (let i = 0; i < 80; i++) {
      await s.earn(kp, "two");
      s.clock.advance(1);
    }
    const ev = await events(s);
    expect(ev).toHaveLength(200);
    // the newest events are kept
    expect(ev[ev.length - 1]!.t).toBe(T0 + 79);
    expect(ev[0]!.t).toBeGreaterThan(T0);
  });

  it("includes `now` next to the events", async () => {
    const s = setup();
    s.clock.advance(3);
    const body = (await (await s.admin("/events")).json()) as { events: AdminEvent[]; now: number };
    expect(body).toEqual({ events: [], now: T0 + 3 });
  });

  it("deriveAdminEvents falls back to agent_blocked only for a non-sqlite store", () => {
    const sqlite = new SqliteStore(":memory:");
    cleanups.push(() => sqlite.close());
    const a = sqlite.ensureAgent("k1");
    a.bundles = 5;
    a.goldenSeen = 5;
    a.goldenCorrect = 0;
    sqlite.updateAgent(a);
    // A store that is not a SqliteStore: only listAgents() is consulted.
    const fake = { listAgents: () => sqlite.listAgents() } as unknown as SqliteStore;
    expect(deriveAdminEvents(fake, { voucherTtl: 10 })).toEqual([{ t: 0, type: "agent_blocked", key: "k1" }]);
    expect(deriveAdminEvents(sqlite, { voucherTtl: 10 })).toEqual([{ t: 0, type: "agent_blocked", key: "k1" }]);
  });
});
