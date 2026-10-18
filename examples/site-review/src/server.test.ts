import { describe, expect, it } from "vitest";
import { HEADERS, generateKeypair } from "@d402/spec";
import { createApp } from "./server.js";
import { fakerReviewer, honestReviewer, honestWorker, lazyReviewer, randomWorker, reviewAndCall, workAndCall, type Reviewer, type Worker } from "./agents.js";
import type { JobListing } from "./market.js";
import { BUG_CATALOG, pageKey } from "./site.js";
import { evidencePath, signReview, type Assignment } from "./review.js";

const BASE = "http://localhost:8788";
const API = `${BASE}/api/products?q=lamp`;

function setup() {
  const ctx = createApp({ baseUrl: BASE, secret: "test-secret", adminToken: "test-admin", slowMs: 1200 });
  const fetchViaApp: typeof fetch = (input, init) => ctx.app.request(input as string, init);
  const state = () => ctx.review.state();
  const review = (reviewer: Reviewer, model = "test", keypair = generateKeypair()) =>
    reviewAndCall({ apiUrl: API, keypair, model, reviewer, fetch: fetchViaApp, slowThresholdMs: 600 });
  const work = (job: string, worker: Worker, model = "test", keypair = generateKeypair()) =>
    workAndCall({ apiUrl: API, job, keypair, model, worker, fetch: fetchViaApp });
  return { ...ctx, fetchViaApp, state, review, work };
}

async function getAssignment(f: typeof fetch, publicKey: string): Promise<Assignment> {
  const res = await f(`${BASE}/.well-known/d402/tasks?tier=review`, { headers: { [HEADERS.key]: publicKey } });
  expect(res.status).toBe(200);
  return (await res.json()) as Assignment;
}

describe("site-review example", () => {
  it("serves the website and gates the API with an offer listing every job", async () => {
    const { app } = setup();
    const home = await app.request("/");
    expect(home.status).toBe(200);
    expect(await home.text()).toContain("Acme Home");

    const res = await app.request("/api/products?q=lamp");
    expect(res.status).toBe(402);
    const offer = (await res.json()) as { accepts: Array<{ taskTypes: string[]; tiers: Array<{ id: string }>; market: string }>; error: string };
    expect(offer.error).toBe("missing_voucher");
    expect(offer.accepts[0]!.taskTypes).toEqual(["review", "classify", "extract"]);
    expect(offer.accepts[0]!.tiers.map((t) => t.id)).toEqual(["review", "review-sentiment", "ticket-triage", "invoice-extract"]);
    expect(offer.accepts[0]!.market).toBe(`${BASE}/market/jobs`);
  });

  it("an honest reviewer finds the planted bugs, passes, and spends the voucher", async () => {
    const { review, state } = setup();
    const r = await review(honestReviewer, "claude");
    expect(r.outcome).toBe("passed");
    expect(r.status).toBe(200);
    expect(r.callsRemaining).toBe("49");

    const rec = state().reviews[0]!;
    expect(rec.passed).toBe(true);
    expect(rec.plantedFound).toBe(rec.planted);
    expect(rec.falsePositives).toBe(0);
    expect(rec.goalsDone.sort()).toEqual(["add-to-cart", "checkout", "signup"]);
    expect(rec.pagesVisited.length).toBeGreaterThanOrEqual(5);
  });

  it("rejects a lazy reviewer that never opened the site", async () => {
    const { review, state } = setup();
    const r = await review(lazyReviewer);
    expect(r.outcome).toBe("rejected");
    const rec = state().reviews[0]!;
    expect(rec.passed).toBe(false);
    expect(rec.reasons.join(" ")).toMatch(/loaded 0 distinct page/);
    expect(rec.reasons.join(" ")).toMatch(/goal "signup" never happened/);
  });

  it("rejects a faker: ungrounded findings, wrong codes, false positives", async () => {
    const { review, state } = setup();
    const r = await review(fakerReviewer);
    expect(r.outcome).toBe("rejected");
    const reasons = state().reviews[0]!.reasons.join(" | ");
    expect(reasons).toMatch(/on pages it never loaded/);
    expect(reasons).toMatch(/false positive/);
    // usability opinions from rejected reviews are not counted
    expect(state().stats.avgUsability).toBeNull();
  });

  it("rejects correct-looking codes copied from a different session", async () => {
    const { fetchViaApp, state } = setup();
    const kp = generateKeypair();
    const a1 = await getAssignment(fetchViaApp, kp.publicKey);
    const a2 = await getAssignment(fetchViaApp, kp.publicKey);
    // Do the work honestly on session 1, then submit that report for session 2.
    const report = await honestReviewer(a1, { fetch: fetchViaApp, log: () => {}, slowThresholdMs: 600 });
    const res = await fetchViaApp(`${BASE}/.well-known/d402/tasks/${a2.assignmentId}`, {
      method: "POST",
      headers: { [HEADERS.key]: kp.publicKey, "content-type": "application/json" },
      body: JSON.stringify({ report, sig: signReview(kp.privateKey, a2.assignmentId, report) }),
    });
    expect(res.status).toBe(422);
    expect(state().reviews[0]!.reasons.join(" ")).toMatch(/checkpoint code|never happened|never loaded/);
  });

  it("rejects a tampered report (signature covers the report as sent)", async () => {
    const { fetchViaApp } = setup();
    const kp = generateKeypair();
    const a = await getAssignment(fetchViaApp, kp.publicKey);
    const report = { findings: [], checkpoints: {}, usability: { score: 5, summary: "fine", suggestions: [] } };
    const sig = signReview(kp.privateKey, a.assignmentId, report);
    const res = await fetchViaApp(`${BASE}/.well-known/d402/tasks/${a.assignmentId}`, {
      method: "POST",
      headers: { [HEADERS.key]: kp.publicKey, "content-type": "application/json" },
      body: JSON.stringify({ report: { ...report, usability: { ...report.usability, score: 1 } }, sig }),
    });
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: string }).error).toBe("bad_signature");
  });

  it("blocks a key that keeps submitting junk (SPEC 5.2 floor)", async () => {
    const { review } = setup();
    const kp = generateKeypair();
    const outcomes: string[] = [];
    for (let i = 0; i < 6; i++) outcomes.push((await review(lazyReviewer, "x", kp)).outcome);
    expect(outcomes.slice(0, 5)).toEqual(Array(5).fill("rejected"));
    expect(outcomes[5]).toBe("blocked");
  });

  it("confirms the site's real bugs only once independent reviewers agree", async () => {
    const { review, state } = setup();
    for (const model of ["claude", "gpt", "gemini"]) await review(honestReviewer, model);
    expect(state().issues.filter((i) => i.confirmed)).toEqual([]);
    await review(honestReviewer, "llama");
    const confirmed = state()
      .issues.filter((i) => i.confirmed)
      .map((i) => `${i.page}|${i.category}`)
      .sort();
    expect(confirmed).toEqual(["/about|broken-link", "/contact|server-error"]);
    // planted bugs are controls, never "confirmed issues"
    for (const b of BUG_CATALOG) expect(confirmed).not.toContain(`${b.page}|${b.category}`);
    expect(state().stats.avgUsability).not.toBeNull();
  });

  it("pageKey and evidencePath normalise what agents write", () => {
    expect(pageKey("/product/3?x=1")).toBe("/product");
    expect(pageKey("http://localhost:8788/")).toBe("/");
    expect(evidencePath("http://localhost:8788/careers -> 404")).toBe("/careers");
    expect(evidencePath("/careers -> HTTP 404")).toBe("/careers");
    expect(evidencePath("no link here")).toBeUndefined();
  });
});

describe("job market", () => {
  const admin = { authorization: "Bearer test-admin", "content-type": "application/json" };
  const listings = async (f: typeof fetch) => ((await (await f(`${BASE}/market/jobs`)).json()) as { jobs: JobListing[] }).jobs;
  const job = async (f: typeof fetch, id: string) => (await listings(f)).find((j) => j.id === id)!;

  it("lists every job publicly without leaking answers, and serves the market page", async () => {
    const { app, fetchViaApp } = setup();
    const jobs = await listings(fetchViaApp);
    expect(jobs.map((j) => j.type)).toEqual(["review", "classify", "classify", "extract"]);
    for (const j of jobs) expect(j.taskUrl).toBe(`${BASE}/.well-known/d402/tasks?tier=${j.id}`);
    expect(JSON.stringify(jobs)).not.toContain("golden");

    const page = await app.request("/market");
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("Job market");
  });

  it("a task never tells the agent which items are controls", async () => {
    const { fetchViaApp } = setup();
    const res = await fetchViaApp(`${BASE}/.well-known/d402/tasks?tier=review-sentiment`, { headers: { [HEADERS.key]: generateKeypair().publicKey } });
    const task = (await res.json()) as { type: string; labels: string[]; items: Array<Record<string, unknown>> };
    expect(task.type).toBe("classify");
    expect(task.labels).toEqual(["positive", "negative"]);
    expect(task.items).toHaveLength(5);
    for (const it of task.items) expect(Object.keys(it).sort()).toEqual(["id", "text"]);
  });

  it("any job pays for the same API: classify and extract earn vouchers worth their reward", async () => {
    const { work } = setup();
    const a = await work("review-sentiment", honestWorker);
    expect(a).toMatchObject({ outcome: "passed", status: 200, callsRemaining: "9" });
    const b = await work("ticket-triage", honestWorker);
    expect(b).toMatchObject({ outcome: "passed", callsRemaining: "9" });
    const c = await work("invoice-extract", honestWorker);
    expect(c).toMatchObject({ outcome: "passed", callsRemaining: "19" });
  });

  it("a guesser fails the hidden controls on dataset jobs", async () => {
    const { work, fetchViaApp } = setup();
    // Random labels on 2 binary controls pass 1 time in 4; extract answers of "unknown" never do.
    const r = await work("invoice-extract", randomWorker);
    expect(r.outcome).toBe("rejected");
    expect(await job(fetchViaApp, "invoice-extract")).toMatchObject({ stats: { taken: 1, passed: 0, rejected: 1 } });
  });

  it("independent agents resolve items, and the poster exports them", async () => {
    const { work, fetchViaApp, app } = setup();
    const keys = ["claude", "gpt", "gemini", "llama"].map((m) => ({ m, kp: generateKeypair() }));
    for (let round = 0; round < 3; round++) for (const k of keys) expect((await work("ticket-triage", honestWorker, k.m, k.kp)).outcome).toBe("passed");
    const triage = await job(fetchViaApp, "ticket-triage");
    expect(triage.progress.done).toBeGreaterThan(0);

    expect((await app.request("/market/jobs/ticket-triage/results")).status).toBe(401);
    const out = (await (await app.request("/market/jobs/ticket-triage/results", { headers: admin })).json()) as { results: Array<{ text: string; label: string }> };
    expect(out.results.length).toBe(triage.progress.done);
    for (const r of out.results) expect(["billing", "shipping", "bug", "account"]).toContain(r.label);
  });

  it("trust is shared: a key blocked on one job is blocked on every job", async () => {
    const { work, review } = setup();
    const kp = generateKeypair();
    for (let i = 0; i < 5; i++) expect((await work("invoice-extract", randomWorker, "x", kp)).outcome).toBe("rejected");
    expect((await work("review-sentiment", honestWorker, "x", kp)).outcome).toBe("blocked");
    expect((await review(honestReviewer, "x", kp)).outcome).toBe("blocked");
  });

  it("a poster adds a new job at runtime, and agents can take it straight away", async () => {
    const { app, work, fetchViaApp } = setup();
    const spec = {
      id: "toxicity",
      type: "classify",
      title: "Comment moderation",
      poster: "Forum team",
      instructions: "Label each comment.",
      labels: ["positive", "negative"],
      reward: { calls: 7 },
      items: [
        { id: "c1", text: "I love this forum, great people", golden: "positive" },
        { id: "c2", text: "Terrible advice, I want a refund", golden: "negative" },
        { id: "c3", text: "Excellent write-up, would recommend", golden: "positive" },
        { id: "c4", text: "This thread is cheap and disappointed me" },
        { id: "c5", text: "Perfect answer, thanks" },
      ],
    };
    expect((await app.request("/market/jobs", { method: "POST", body: JSON.stringify(spec) })).status).toBe(401);
    const created = await app.request("/market/jobs", { method: "POST", headers: admin, body: JSON.stringify(spec) });
    expect(created.status).toBe(201);
    expect(((await created.json()) as JobListing).summary).toMatch(/positive \/ negative/);

    const offer = (await (await app.request("/api/products")).json()) as { accepts: Array<{ tiers: Array<{ id: string }> }> };
    expect(offer.accepts[0]!.tiers.map((t) => t.id)).toContain("toxicity");
    expect(await work("toxicity", honestWorker)).toMatchObject({ outcome: "passed", callsRemaining: "6" });
    expect((await job(fetchViaApp, "toxicity")).stats.passed).toBe(1);

    expect((await app.request("/market/jobs", { method: "POST", headers: admin, body: JSON.stringify(spec) })).status).toBe(409);
    const noControls = { ...spec, id: "no-controls", items: spec.items.map(({ id, text }) => ({ id, text })) };
    const bad = await app.request("/market/jobs", { method: "POST", headers: admin, body: JSON.stringify(noControls) });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { message: string }).message).toMatch(/golden/);
  });
});
