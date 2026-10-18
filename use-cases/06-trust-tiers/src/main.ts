/**
 * 06 trust tiers: what the seller's trust rule does over 60 bundles.
 *
 * An honest agent (p = 0.95) earns 60 bundles. Every 10 bundles we print the
 * seller's accuracy estimate, the golden ratio band it puts the agent in
 * (SPEC 5.2, recomputed with the exported goldenRatio) and the calls earned.
 * A lazy agent that always answers the first label is cut off with 403 blocked
 * after 5 bundles.
 */
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { createD402, goldenCount, goldenRatio } from "@d402/server";
import { D402Error, createD402Client, createLookupSolver } from "@d402/client";
import { findD402Accept, generateKeypair, type Answers, type Bundle } from "@d402/spec";
import { DOMAINS, generateDataset, mulberry32, noisyLookup, toTaskFile, truthMap } from "../../_shared/gen.js";
import { createLog, isMain, listen, runMain } from "../../_shared/harness.js";

const ROUNDS = 60;
const ITEMS = 20;
const CALLS = 40;

export interface Checkpoint {
  bundles: number;
  accuracy: number;
  goldenSeen: number;
  goldenCorrect: number;
  band: number;
  goldensNext: number;
  calls: number;
}

export interface Summary {
  checkpoints: Checkpoint[];
  honest: { bundles: number; passed: number; calls: number; finalBand: number };
  lazy: { bundles: number; blockedAt: number | undefined; calls: number };
}

const SEED = 606;
/** Noise seed of the honest agent. Which goldens a model is consistently wrong on decides its band; see the README. */
const HONEST_SEED = 608;

export async function run(opts: { silent?: boolean; seed?: number; honestSeed?: number } = {}): Promise<Summary> {
  const log = createLog(opts.silent);
  const seed = opts.seed ?? SEED;
  const honestSeed = opts.honestSeed ?? HONEST_SEED;
  const domain = DOMAINS.news;
  log.header("06 trust tiers", `An honest agent (p=0.95) over ${ROUNDS} bundles next to a lazy one. Bands: 0.4 -> 0.2 -> 0.1 goldens per bundle.`);

  // 1. Seller with rate limits raised so 60 rounds fit in seconds.
  const items = generateDataset("news", 1300, seed);
  const truth = truthMap(items);
  const site = await listen(serve);
  const d402 = createD402({
    sellerId: "trust.example",
    taskUrl: `${site.baseUrl}/.well-known/d402/tasks`,
    scope: ["/api"],
    secret: "uc06-secret",
    labels: domain.labels,
    instructions: domain.instructions,
    tiers: [{ id: "m", items: ITEMS, est_tokens: 3000, reward: { calls: CALLS } }],
    bundlesPerKeyPerHour: 100_000,
    bundlesPerIpPerHour: 1_000_000,
    maxOpenBundlesPerKey: 50,
    random: mulberry32(seed),
  });
  d402.tasks.load(toTaskFile(items, 100, seed));
  const app = new Hono();
  app.route("/", d402.routes);
  app.use("/api/*", d402.gate);
  app.get("/api/ping", (c) => c.json({ pong: true }));
  site.setHandler((req, env) => app.fetch(req, env));
  const accept = findD402Accept(await (await fetch(`${site.baseUrl}/.well-known/d402`)).json())!;
  log.step(1, `seller up at ${site.baseUrl}: 1300 snippets (100 golden), tier m: ${ITEMS} items -> ${CALLS} calls, rate limits raised`);

  // 2. Two agents.
  const honestSolver = createLookupSolver(noisyLookup(truth, domain.labels, 0.95, honestSeed));
  const honest = createD402Client({ keypair: generateKeypair(), model: "claude", tier: "m" });
  const lazy = createD402Client({ keypair: generateKeypair(), model: "llama", tier: "m" });
  const lazySolver = async (b: Bundle): Promise<Answers> => Object.fromEntries(b.items.map((it) => [it.id, b.labels[0]!]));
  log.step(2, `honest agent ${honest.keypair.publicKey.slice(0, 8)}... (claude, p=0.95) and lazy agent ${lazy.keypair.publicKey.slice(0, 8)}... (always "${domain.labels[0]}")`);

  const checkpoints: Checkpoint[] = [];
  const snapshot = (bundles: number, calls: number): Checkpoint => {
    const rec = d402.agents.get(honest.keypair.publicKey) ?? { goldenSeen: 0, goldenCorrect: 0, bundles: 0, accuracy: 0.5 };
    const band = goldenRatio(rec);
    return { bundles, accuracy: rec.accuracy, goldenSeen: rec.goldenSeen, goldenCorrect: rec.goldenCorrect, band, goldensNext: goldenCount(ITEMS, rec), calls };
  };
  const show = (c: Checkpoint) =>
    log.line(
      `after ${String(c.bundles).padStart(2)} bundles: accuracy ${c.accuracy.toFixed(3)} (${c.goldenCorrect}/${c.goldenSeen} goldens), ` +
        `band ${c.band} -> ${c.goldensNext} goldens in the next ${ITEMS}, calls earned ${c.calls}`,
    );

  log.step(3, "honest agent, every 10 bundles (lazy agent interleaved for its first attempts):");
  let honestPassed = 0;
  let honestCalls = 0;
  let lazyBundles = 0;
  let lazyCalls = 0;
  let lazyBlockedAt: number | undefined;
  checkpoints.push(snapshot(0, 0));
  show(checkpoints[0]!);
  for (let r = 1; r <= ROUNDS; r++) {
    const bundle = await honest.getBundle(accept.taskUrl, "m");
    try {
      const v = await honest.submit(accept.taskUrl, bundle, await honestSolver(bundle), accept);
      honestPassed++;
      honestCalls += v.calls;
    } catch (err) {
      if (!(err instanceof D402Error && err.code === "quality")) throw err;
    }
    if (lazyBlockedAt === undefined && r <= 8) {
      try {
        const lb = await lazy.getBundle(accept.taskUrl, "m");
        lazyBundles++;
        try {
          const v = await lazy.submit(accept.taskUrl, lb, await lazySolver(lb), accept);
          lazyCalls += v.calls;
        } catch (err) {
          if (!(err instanceof D402Error && err.code === "quality")) throw err;
        }
      } catch (err) {
        if (err instanceof D402Error && err.code === "blocked") {
          lazyBlockedAt = r;
          const rec = d402.agents.get(lazy.keypair.publicKey)!;
          log.line(`lazy agent: HTTP ${err.status} blocked on its ${r}th request after ${lazyBundles} bundles (accuracy ${rec.accuracy.toFixed(3)}, ${lazyCalls} calls earned)`);
        } else throw err;
      }
    }
    if (r % 10 === 0) {
      const c = snapshot(r, honestCalls);
      checkpoints.push(c);
      show(c);
    }
  }
  const finalBand = checkpoints[checkpoints.length - 1]!.band;

  await site.close();
  d402.close();
  log.result(
    `honest: ${honestPassed}/${ROUNDS} bundles passed, ${honestCalls} calls, band ${finalBand}; lazy: blocked after ${lazyBundles} bundles with ${lazyCalls} calls`,
  );
  return {
    checkpoints,
    honest: { bundles: ROUNDS, passed: honestPassed, calls: honestCalls, finalBand },
    lazy: { bundles: lazyBundles, blockedAt: lazyBlockedAt, calls: lazyCalls },
  };
}

if (isMain(import.meta.url)) runMain(run);
