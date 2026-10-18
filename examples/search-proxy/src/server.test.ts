import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { HEADERS, findD402Accept, generateKeypair, type Offer, type TaskFileItem } from "@d402/spec";
import { D402Error, createD402Client, createLookupSolver } from "@d402/client";
import { TASKS_PATH, TIERS, createApp } from "./server.js";
import { search } from "./corpus.js";

const BASE = "http://localhost:8787";

/** Goldens from the committed task file; any label is fine for unknown items. */
function goldenLookup(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of readFileSync(TASKS_PATH, "utf8").split("\n")) {
    if (!line.trim()) continue;
    const row = JSON.parse(line) as TaskFileItem;
    if (row.golden) out[row.id] = row.golden;
  }
  return out;
}

describe("search-proxy example", () => {
  const { app, d402 } = createApp({ secret: "test-secret" });
  const fetchViaApp: typeof fetch = (input, init) => app.request(input as string | Request, init);
  afterAll(() => d402.close());

  it("loads the committed task file at boot", () => {
    const s = d402.tasks.stats();
    expect(s.total).toBe(300);
    expect(s.golden).toBe(60);
  });

  it("GET /health is open", async () => {
    const res = await app.request("/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, total: 300 });
  });

  it("GET /search without a voucher returns 402 with a d402 offer", async () => {
    const res = await app.request("/search?q=ceasefire");
    expect(res.status).toBe(402);
    const offer = (await res.json()) as Offer;
    expect(offer.d402).toBe("1");
    const accept = findD402Accept(offer);
    expect(accept).toBeDefined();
    expect(accept!.scope).toEqual(["/search"]);
    expect(accept!.taskUrl).toBe(`${BASE}/.well-known/d402/tasks`);
    expect(accept!.tiers.map((t) => t.id)).toEqual(["s", "m", "l"]);
    expect(accept!.tiers).toEqual(TIERS);
  });

  it("GET /.well-known/d402 serves the same offer", async () => {
    const a = (await (await app.request("/.well-known/d402")).json()) as Offer;
    const b = (await (await app.request("/search?q=x")).json()) as Offer;
    expect(a.accepts).toEqual(b.accepts);
  });

  it("a garbage voucher is rejected with voucher_invalid", async () => {
    const res = await app.request("/search?q=x", { headers: { [HEADERS.voucher]: "not.a.jwt" } });
    expect(res.status).toBe(402);
    expect(await res.json()).toMatchObject({ d402: "1", error: "voucher_invalid" });
  });

  it("earn + spend round trip with the real client and a golden lookup solver", async () => {
    const goldens = goldenLookup();
    const client = createD402Client({
      keypair: generateKeypair(),
      solver: createLookupSolver((item) => goldens[item.id] ?? "world"),
      model: "test",
      tier: "s",
      fetch: fetchViaApp,
    });

    const res = await client.fetch(`${BASE}/search?q=ceasefire`);
    expect(res.status).toBe(200);
    expect(res.headers.get(HEADERS.callsRemaining)).toBe("9");
    const body = (await res.json()) as { hits: { title: string; url: string; snippet: string }[] };
    expect(body.hits.length).toBeGreaterThan(0);
    expect(body.hits[0]!.title).toBe("Ceasefire agreed along disputed border");
    expect(body.hits[0]!.snippet.toLowerCase()).toContain("ceasefire");

    const vouchers = await client.status();
    expect(vouchers).toHaveLength(1);
    expect(vouchers[0]!.calls).toBe(9);
    expect(d402.vouchers.get(vouchers[0]!.jti)?.callsLeft).toBe(9);

    const second = await client.fetch(`${BASE}/search?q=gpu`);
    expect(second.status).toBe(200);
    expect(second.headers.get(HEADERS.callsRemaining)).toBe("8");

    const agent = d402.agents.get(client.keypair.publicKey);
    expect(agent?.bundles).toBe(1);
    expect(agent?.goldenCorrect).toBe(agent?.goldenSeen);
  });

  it("a wrong solver fails the bundle with 422 quality and earns nothing", async () => {
    const goldens = goldenLookup();
    const wrong = (label: string) => (label === "sports" ? "tech" : "sports");
    const client = createD402Client({
      keypair: generateKeypair(),
      solver: createLookupSolver((item) => wrong(goldens[item.id] ?? "world")),
      tier: "s",
      fetch: fetchViaApp,
      maxEarnAttempts: 1,
    });
    const offer = await client.discover(BASE);
    const accept = findD402Accept(offer)!;
    // earn() retries on 422 quality and wraps the last failure as earn_failed.
    const err = (await client.earn(accept, "s").catch((e: unknown) => e)) as D402Error;
    expect(err).toBeInstanceOf(D402Error);
    expect(err).toMatchObject({ code: "earn_failed", status: 422 });
    expect((err.cause as D402Error).code).toBe("quality");
    expect(await client.status()).toHaveLength(0);
    // the bare submit path surfaces the 422 directly
    const bundle = await client.getBundle(accept.taskUrl, "s");
    const answers = Object.fromEntries(bundle.items.map((i) => [i.id, wrong(goldens[i.id] ?? "world")]));
    await expect(client.submit(accept.taskUrl, bundle, answers, accept)).rejects.toMatchObject({ code: "quality", status: 422 });
  });

  it("search is case-insensitive and empty for unknown terms", () => {
    expect(search("CEASEFIRE")[0]!.title).toBe("Ceasefire agreed along disputed border");
    expect(search("zzzz-not-in-corpus")).toEqual([]);
    expect(search("   ")).toEqual([]);
  });
});
