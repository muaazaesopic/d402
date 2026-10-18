/**
 * 01 dataset builder: a seller with no product to sell, who only wants labels.
 *
 * The seller has 500 unlabelled support tickets and 60 it labelled by hand
 * (the goldens). It gates a trivial GET /thanks route so there is something to
 * pay for; what it is really buying is urgency labels. Three agents with
 * different model families earn the one call each bundle is worth, and the
 * seller exports the tickets that resolved by multi-agent agreement.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { createD402 } from "@d402/server";
import { D402Error, createD402Client, createLookupSolver } from "@d402/client";
import { findD402Accept, generateKeypair, type Bundle } from "@d402/spec";
import { DOMAINS, generateDataset, mulberry32, noisyLookup, scoreAgainstTruth, toJsonl, toTaskFile, truthMap } from "../../_shared/gen.js";
import { createLog, isMain, listen, runMain } from "../../_shared/harness.js";

const UNKNOWN = 500;
const GOLDEN = 60;
const SEED = 2026;
const HERE = dirname(fileURLToPath(import.meta.url));

export interface Summary {
  unknown: number;
  resolved: number;
  accuracy: number;
  bundles: number;
  agents: { model: string; p: number; bundles: number; serverAccuracy: number }[];
  outFile: string;
}

export async function run(opts: { silent?: boolean; outFile?: string } = {}): Promise<Summary> {
  const log = createLog(opts.silent);
  const outFile = opts.outFile ?? join(HERE, "..", "out", "labels.jsonl");
  const domain = DOMAINS.tickets;

  log.header("01 dataset builder", `A helpdesk wants ${UNKNOWN} tickets labelled by urgency. It has no API to sell, only a thank-you.`);

  // 1. The seller: 500 unknown tickets + 60 hand-labelled goldens, one gated route.
  const items = generateDataset("tickets", UNKNOWN + GOLDEN, SEED);
  const truth = truthMap(items);
  const rows = toTaskFile(items, GOLDEN, SEED);
  const site = await listen(serve);
  const d402 = createD402({
    sellerId: "helpdesk.example",
    taskUrl: `${site.baseUrl}/.well-known/d402/tasks`,
    scope: ["/thanks"],
    secret: "uc01-secret",
    labels: domain.labels,
    instructions: domain.instructions,
    tiers: [{ id: "l", items: 50, est_tokens: 6000, reward: { calls: 1 } }],
    bundlesPerKeyPerHour: 10_000,
    bundlesPerIpPerHour: 100_000,
    random: mulberry32(SEED),
  });
  d402.tasks.load(rows);
  const app = new Hono();
  app.route("/", d402.routes);
  app.use("/thanks", d402.gate);
  app.get("/thanks", (c) => c.json({ thanks: "labels received", from: "helpdesk.example" }));
  site.setHandler((req, env) => app.fetch(req, env));
  const stats = d402.tasks.stats();
  log.step(1, `seller up at ${site.baseUrl}: ${stats.total} tickets in the pool (${stats.golden} golden, ${stats.unknownOpen} unknown), 1 tier: 50 items -> 1 call to /thanks`);

  // 2. Three agents, three model families, ~90% accurate each.
  const specs = [
    { model: "claude", p: 0.9, seed: 11 },
    { model: "gpt", p: 0.88, seed: 12 },
    { model: "gemini", p: 0.92, seed: 13 },
  ];
  const offer = await (await fetch(`${site.baseUrl}/.well-known/d402`)).json();
  const accept = findD402Accept(offer)!;
  let totalBundles = 0;
  const agents: Summary["agents"] = [];
  log.step(2, `three agents label until the seller has nothing new for them:`);
  for (const spec of specs) {
    const seen = new Set<string>();
    let newInLast = Infinity;
    const lookup = noisyLookup(truth, domain.labels, spec.p, spec.seed);
    const base = createLookupSolver(lookup);
    const solver = async (bundle: Bundle) => {
      newInLast = bundle.items.filter((it) => !seen.has(it.id)).length;
      for (const it of bundle.items) seen.add(it.id);
      return base(bundle);
    };
    const client = createD402Client({ keypair: generateKeypair(), solver, model: spec.model, tier: "l", maxEarnAttempts: 1 });
    let bundles = 0;
    let passed = 0;
    let failed = 0;
    while (newInLast >= 5 && bundles < 40) {
      try {
        await client.earn(accept);
        passed++;
      } catch (err) {
        if (err instanceof D402Error && err.code === "earn_failed") failed++;
        else if (err instanceof D402Error && err.code === "no_tasks") break;
        else throw err;
      }
      bundles++;
    }
    totalBundles += bundles;
    const rec = d402.agents.get(client.keypair.publicKey)!;
    agents.push({ model: spec.model, p: spec.p, bundles, serverAccuracy: rec.accuracy });
    const thanks = await client.fetch(`${site.baseUrl}/thanks`);
    log.line(
      `${spec.model.padEnd(6)} (p=${spec.p}): ${bundles} bundles, ${passed} passed, ${failed} failed quality, ` +
        `seller's accuracy estimate ${rec.accuracy.toFixed(3)}, GET /thanks -> ${thanks.status}`,
    );
  }

  // 3. The seller exports what resolved and checks it against the hidden truth (only we can).
  const resolved = d402.tasks.exportResolved();
  const score = scoreAgainstTruth(resolved, truth);
  mkdirSync(dirname(outFile), { recursive: true });
  writeFileSync(outFile, toJsonl(resolved.map((r) => ({ id: r.id, text: r.text, label: r.answer, weight: Number(r.weight.toFixed(3)), voters: r.voters }))));
  const after = d402.tasks.stats();
  log.step(3, `seller exports resolved labels with d402.tasks.exportResolved():`);
  log.line(`${resolved.length} of ${UNKNOWN} tickets resolved (${after.unknownOpen} still need a 4th opinion), ${totalBundles} bundles in total`);
  log.line(`accuracy vs hidden truth: ${score.correct}/${score.total} = ${(score.accuracy * 100).toFixed(1)}%`);
  log.line(`written to ${outFile}`);
  for (const r of resolved.slice(0, 3)) log.line(`  ${r.id} ${r.answer.padEnd(8)} w=${r.weight.toFixed(2)} voters=${r.voters}  ${JSON.stringify(r.text)}`);

  await site.close();
  d402.close();
  log.result(`${resolved.length}/${UNKNOWN} tickets labelled at ${(score.accuracy * 100).toFixed(1)}% accuracy from ${totalBundles} bundles, no money moved; export at ${outFile}`);
  return { unknown: UNKNOWN, resolved: resolved.length, accuracy: score.accuracy, bundles: totalBundles, agents, outFile };
}

if (isMain(import.meta.url)) runMain(run);
