/**
 * 07 paid crawl: a content site gates its articles; a crawler earns once and reads all ten.
 *
 * GET /articles/:id is behind d402 with scope ["/articles"]. The tier pays 12
 * calls for 5 labelled snippets, so one bundle covers the whole crawl. The
 * crawler is an ordinary client.fetch loop with maxEarnAttempts 3.
 */
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { createD402 } from "@d402/server";
import { createD402Client, createLookupSolver } from "@d402/client";
import { HEADERS, generateKeypair, type Bundle } from "@d402/spec";
import { DOMAINS, generateDataset, mulberry32, noisyLookup, toTaskFile, truthMap } from "../../_shared/gen.js";
import { createLog, isMain, listen, runMain } from "../../_shared/harness.js";

const SEED = 707;
export const ARTICLE_COUNT = 10;
export const CALLS_PER_BUNDLE = 12;

export interface Summary {
  fetched: { id: string; status: number; callsRemaining: string | null; title: string }[];
  attempts: number;
  vouchers: number;
  serverBundles: number;
}

export async function run(opts: { silent?: boolean } = {}): Promise<Summary> {
  const log = createLog(opts.silent);
  const domain = DOMAINS.news;
  log.header("07 paid crawl", `A magazine with ${ARTICLE_COUNT} articles behind d402. A crawler earns once and reads them all.`);

  // 1. The content site. Articles are generated; the label pool is separate.
  const articles = generateDataset("news", ARTICLE_COUNT, SEED + 1).map((it, i) => ({
    id: `a${i + 1}`,
    section: it.truth,
    title: it.text.replace(/\.$/, ""),
    body: `${it.text} (${320 + i * 17} words follow.)`,
  }));
  const pool = generateDataset("news", 60, SEED);
  const truth = truthMap(pool);
  const site = await listen(serve);
  const d402 = createD402({
    sellerId: "magazine.example",
    taskUrl: `${site.baseUrl}/.well-known/d402/tasks`,
    scope: ["/articles"],
    secret: "uc07-secret",
    labels: domain.labels,
    instructions: domain.instructions,
    tiers: [{ id: "crawl", items: 5, est_tokens: 800, reward: { calls: CALLS_PER_BUNDLE } }],
    random: mulberry32(SEED),
  });
  d402.tasks.load(toTaskFile(pool, 15, SEED));
  const app = new Hono();
  app.route("/", d402.routes);
  app.use("/articles/*", d402.gate);
  app.get("/articles/:id", (c) => {
    const a = articles.find((x) => x.id === c.req.param("id"));
    return a ? c.json(a) : c.json({ error: "not_found" }, 404);
  });
  site.setHandler((req, env) => app.fetch(req, env));
  log.step(1, `site up at ${site.baseUrl}: ${articles.length} articles under /articles, tier "crawl": 5 items -> ${CALLS_PER_BUNDLE} calls`);

  // 2. The crawler.
  let attempts = 0;
  const base = createLookupSolver(noisyLookup(truth, domain.labels, 0.9, 9));
  const solver = async (b: Bundle) => {
    attempts++;
    return base(b);
  };
  const crawler = createD402Client({ keypair: generateKeypair(), solver, model: "claude", maxEarnAttempts: 3 });
  log.step(2, "crawler fetches every article with client.fetch:");
  const fetched: Summary["fetched"] = [];
  for (const a of articles) {
    const res = await crawler.fetch(`${site.baseUrl}/articles/${a.id}`);
    const body = (await res.json()) as { title?: string };
    const callsRemaining = res.headers.get(HEADERS.callsRemaining);
    fetched.push({ id: a.id, status: res.status, callsRemaining, title: body.title ?? "" });
    const earned = fetched.length === 1 ? ` (earned a voucher first: ${attempts} bundle${attempts === 1 ? "" : "s"} labelled)` : "";
    log.line(`GET /articles/${a.id.padEnd(3)} -> ${res.status}, calls remaining ${String(callsRemaining).padStart(2)}  ${JSON.stringify(body.title)}${earned}`);
  }
  const vouchers = (await crawler.status()).length;
  const serverBundles = d402.agents.get(crawler.keypair.publicKey)?.bundles ?? 0;

  await site.close();
  d402.close();
  const ok = fetched.filter((f) => f.status === 200).length;
  log.result(`${ok}/${ARTICLE_COUNT} articles fetched, ${vouchers} voucher earned (${attempts} bundle attempt${attempts === 1 ? "" : "s"}), ${fetched[fetched.length - 1]!.callsRemaining} calls left over`);
  return { fetched, attempts, vouchers, serverBundles };
}

if (isMain(import.meta.url)) runMain(run);
