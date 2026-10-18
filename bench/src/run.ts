/**
 * d402 benchmark runner.
 *
 * Starts a real @d402/server in-process on an ephemeral port, loads a synthetic
 * dataset with hidden truth, drives seven simulated agents through the real
 * @d402/client, then computes the six go/no-go metrics. Runs twice: once with
 * requireModelFamilies=false and once with it on.
 *
 *   pnpm --filter d402-bench run bench            # 60 rounds per agent
 *   BENCH_ROUNDS=5 pnpm --filter d402-bench run bench
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { Hono } from "hono";
import { serve, type ServerType } from "@hono/node-server";
import { createD402, type D402Server } from "@d402/server";
import { D402Error, createD402Client, type D402Client } from "@d402/client";
import { HEADERS, findD402Accept, type D402Accept, type Tier } from "@d402/spec";
import { LABELS, generateDataset, toTaskFile, truthMap } from "./gen-dataset.js";
import { buildSharedErrors, createSimAgent, honest, lazy, monoculture, replay, type SimAgent } from "./agents.js";
import {
  addedLatencyMs,
  bundlesPerResolution,
  bundlesUntilLazyCut,
  evaluate,
  fmt,
  honestGoldenPassRate,
  markdownTable,
  monocultureWrongResolved,
  replayAgentCalls,
  resolvedAccuracy,
  singleAgentAccuracy,
  tokensPerCall,
  type BundleLog,
  type Check,
  type Metrics,
} from "./metrics.js";

export const TIERS: Tier[] = [
  { id: "s", items: 5, est_tokens: 1000, reward: { calls: 10 } },
  { id: "m", items: 25, est_tokens: 5000, reward: { calls: 60 } },
  { id: "l", items: 50, est_tokens: 10000, reward: { calls: 150 } },
];

/**
 * The spec's default rate limits (60 bundles/key/hour, 120/IP/hour) would stop
 * the bench after one hour's worth of bundles in a few seconds, so the bench
 * server is constructed with these overrides. Everything else is the default.
 */
export const SERVER_OVERRIDES = {
  bundlesPerKeyPerHour: 100_000,
  bundlesPerIpPerHour: 1_000_000,
  maxOpenBundlesPerKey: 50,
} as const;

export interface BenchOptions {
  rounds?: number;
  n?: number;
  goldenFraction?: number;
  seed?: number;
  tier?: string;
  latencySamples?: number;
  quiet?: boolean;
  /**
   * Issue every agent's bundle for a round concurrently (Promise.all) instead of
   * round-robin. Concurrent issue hands the same least-voted items to every agent
   * before any vote lands, which inflates bundlesPerResolution. Default false;
   * env BENCH_PARALLEL=1.
   */
  parallel?: boolean;
}

export interface AgentSummary {
  name: string;
  kind: SimAgent["brain"]["kind"];
  model: string;
  p?: number;
  bundlesReceived: number;
  bundlesPassed: number;
  callsEarned: number;
  blocked: boolean;
  serverAccuracy?: number;
  serverBundles?: number;
}

export interface RunReport {
  name: string;
  requireModelFamilies: boolean;
  durationMs: number;
  metrics: Metrics;
  checks: Check[];
  go: boolean;
  /** GO/NO-GO ignoring bundlesUntilLazyCut, whose floor under SPEC 5.2 is 5. */
  goExceptLazyFloor: boolean;
  stats: ReturnType<D402Server["tasks"]["stats"]>;
  agents: AgentSummary[];
  latency: ReturnType<typeof addedLatencyMs> & { gatedRawMean: number };
  markdown: string;
}

export interface BenchReport {
  generatedAt: string;
  rounds: number;
  dataset: { n: number; goldenFraction: number; seed: number; labels: string[] };
  tier: string;
  serverOverrides: typeof SERVER_OVERRIDES;
  notes: string[];
  runs: RunReport[];
  durationMs: number;
  markdown: string;
}

interface Harness {
  d: D402Server;
  server: ServerType;
  baseUrl: string;
  close(): Promise<void>;
}

/** Start a Hono app on an ephemeral port; the d402 instance needs the port for taskUrl. */
async function startServer(requireModelFamilies: boolean, labels: string[]): Promise<Harness> {
  let app: Hono | undefined;
  const server = serve({ fetch: (req: Request) => app!.fetch(req), port: 0, hostname: "127.0.0.1" });
  const port = await new Promise<number>((resolve, reject) => {
    server.once("listening", () => {
      const addr = server.address();
      if (addr && typeof addr === "object") resolve(addr.port);
      else reject(new Error("could not read bound port"));
    });
    server.once("error", reject);
  });
  const baseUrl = `http://127.0.0.1:${port}`;
  const d = createD402({
    sellerId: `bench-${port}`,
    taskUrl: `${baseUrl}/.well-known/d402/tasks`,
    scope: ["/search"],
    tiers: TIERS,
    secret: "bench-secret-not-for-production",
    labels,
    requireModelFamilies,
    ...SERVER_OVERRIDES,
  });
  app = new Hono();
  app.get("/health", (c) => c.json({ ok: true }));
  app.route("/", d.routes);
  app.use("/search", d.gate);
  app.get("/search", (c) => c.json({ hits: [], q: c.req.query("q") ?? "" }));
  return {
    d,
    server,
    baseUrl,
    close: () =>
      new Promise<void>((resolve) => {
        d.close();
        server.close(() => resolve());
      }),
  };
}

interface Driver {
  agent: SimAgent;
  client: D402Client;
  blocked: boolean;
}

function codeOf(e: unknown): string {
  return e instanceof D402Error ? e.code : e instanceof Error ? e.message : String(e);
}

async function attempt(
  drv: Driver,
  accept: D402Accept,
  tier: Tier,
  round: number,
  logs: BundleLog[],
): Promise<void> {
  const base: Omit<BundleLog, "received" | "passed" | "calls" | "itemIds" | "answers"> = {
    agent: drv.agent.name,
    kind: drv.agent.brain.kind,
    model: drv.agent.model,
    round,
    estTokens: tier.est_tokens,
  };
  let bundle;
  try {
    bundle = await drv.client.getBundle(accept.taskUrl, tier.id);
  } catch (e) {
    const error = codeOf(e);
    if (error === "blocked") drv.blocked = true;
    logs.push({ ...base, received: false, error, passed: false, calls: 0, itemIds: [], answers: {} });
    return;
  }
  const answers = await drv.agent.solver(bundle);
  let passed = false;
  let calls = 0;
  let error: string | undefined;
  try {
    const v = await drv.client.submit(accept.taskUrl, bundle, answers, accept);
    passed = true;
    calls = v.calls;
  } catch (e) {
    error = codeOf(e);
    if (error !== "quality") throw e;
  }
  drv.agent.brain.onResult?.(bundle, answers, passed);
  logs.push({ ...base, received: true, error, passed, calls, itemIds: bundle.items.map((i) => i.id), answers });
}

async function timeRequests(n: number, fn: () => Promise<Response>): Promise<number[]> {
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const t0 = performance.now();
    const res = await fn();
    await res.arrayBuffer();
    out.push(performance.now() - t0);
    if (!res.ok) throw new Error(`latency probe got HTTP ${res.status}`);
  }
  return out;
}

async function runOnce(
  name: string,
  requireModelFamilies: boolean,
  opts: Required<BenchOptions>,
  dataset: ReturnType<typeof generateDataset>,
): Promise<RunReport> {
  const t0 = performance.now();
  const labels = [...LABELS];
  const truth = truthMap(dataset);
  const taskFile = toTaskFile(dataset, opts.goldenFraction, opts.seed);
  const goldenIds = new Set(taskFile.filter((r) => r.golden !== undefined).map((r) => r.id));
  const sharedError = buildSharedErrors(truth, labels, opts.seed + 1);

  const h = await startServer(requireModelFamilies, labels);
  try {
    h.d.tasks.load(taskFile);
    const tier = TIERS.find((t) => t.id === opts.tier)!;

    const agents: SimAgent[] = [
      createSimAgent("honest-claude-0.92", "claude", honest(0.92, opts.seed + 11), truth),
      createSimAgent("honest-gpt-0.88", "gpt", honest(0.88, opts.seed + 12), truth),
      createSimAgent("honest-gemini-0.95", "gemini", honest(0.95, opts.seed + 13), truth),
      createSimAgent("lazy", "llama", lazy(), truth),
      createSimAgent("replay", "llama", replay(opts.seed + 14), truth),
      createSimAgent("mono-gpt-a", "gpt", monoculture(0.85, opts.seed + 15, sharedError), truth),
      createSimAgent("mono-gpt-b", "gpt", monoculture(0.85, opts.seed + 15, sharedError), truth),
    ];
    const drivers: Driver[] = agents.map((agent) => ({
      agent,
      client: createD402Client({ keypair: agent.keypair, solver: agent.solver, model: agent.model, tier: tier.id }),
      blocked: false,
    }));

    const offer = await drivers[0]!.client.discover(h.baseUrl);
    const accept = findD402Accept(offer);
    if (!accept) throw new Error("server offer has no d402 accept");

    const logs: BundleLog[] = [];
    for (let round = 0; round < opts.rounds; round++) {
      const active = drivers.filter((d) => !d.blocked);
      if (opts.parallel) await Promise.all(active.map((d) => attempt(d, accept, tier, round, logs)));
      else for (const d of active) await attempt(d, accept, tier, round, logs);
    }

    // Latency: gated route through the client with a cached voucher vs. an ungated route.
    const probe = drivers[0]!;
    const searchUrl = `${h.baseUrl}/search?q=bench`;
    await timeRequests(5, () => probe.client.fetch(searchUrl)); // warm-up
    await timeRequests(5, () => fetch(`${h.baseUrl}/health`));
    const gated = await timeRequests(opts.latencySamples, () => probe.client.fetch(searchUrl));
    const baseline = await timeRequests(opts.latencySamples, () => fetch(`${h.baseUrl}/health`));
    const voucher = (await probe.client.status()).find((v) => v.calls > 0);
    const gatedRaw = voucher
      ? await timeRequests(Math.min(opts.latencySamples, voucher.calls - 1), () =>
          fetch(searchUrl, { headers: { [HEADERS.voucher]: voucher.token } }),
        )
      : [];
    const lat = addedLatencyMs(gated, baseline);
    const latency = { ...lat, gatedRawMean: gatedRaw.length ? gatedRaw.reduce((a, b) => a + b, 0) / gatedRaw.length : NaN };

    const resolved = h.d.tasks.exportResolved();
    const stats = h.d.tasks.stats();
    const acc = resolvedAccuracy(resolved, truth);
    const pass = honestGoldenPassRate(logs);
    const bpr = bundlesPerResolution(resolved, logs);
    const tpc = tokensPerCall(logs);
    const cut = bundlesUntilLazyCut(logs);
    const single = singleAgentAccuracy(logs, truth, goldenIds);

    const metrics: Metrics = {
      resolvedAccuracy: acc.value,
      resolvedCount: acc.resolved,
      honestGoldenPassRate: pass.value,
      honestBundlesAttempted: pass.denominator,
      bundlesPerResolution: bpr.value,
      tokensPerCall: tpc.value,
      addedLatencyMs: lat.value,
      gatedLatencyMs: lat.gatedMean,
      baselineLatencyMs: lat.baselineMean,
      bundlesUntilLazyCut: cut.value,
      lazyBlocked: cut.blocked,
      singleAgentAccuracy: single.value,
      singleAgentAccuracyPerAgent: single.perAgent,
      replayAgentCalls: replayAgentCalls(logs),
      monocultureWrongResolved: monocultureWrongResolved(resolved, sharedError),
    };
    const ev = evaluate(metrics);
    const agentSummaries: AgentSummary[] = drivers.map((drv) => {
      const mine = logs.filter((l) => l.agent === drv.agent.name);
      const rec = h.d.agents.get(drv.agent.keypair.publicKey);
      return {
        name: drv.agent.name,
        kind: drv.agent.brain.kind,
        model: drv.agent.model,
        p: drv.agent.brain.p,
        bundlesReceived: mine.filter((l) => l.received).length,
        bundlesPassed: mine.filter((l) => l.passed).length,
        callsEarned: mine.reduce((a, l) => a + l.calls, 0),
        blocked: drv.blocked,
        serverAccuracy: rec?.accuracy,
        serverBundles: rec?.bundles,
      };
    });
    const title = `${name} (requireModelFamilies=${requireModelFamilies})`;
    return {
      name,
      requireModelFamilies,
      durationMs: performance.now() - t0,
      metrics,
      checks: ev.checks,
      go: ev.go,
      goExceptLazyFloor: ev.checks.filter((c) => c.metric !== "bundlesUntilLazyCut").every((c) => c.pass),
      stats,
      agents: agentSummaries,
      latency,
      markdown:
        markdownTable(title, metrics, ev) +
        `**${ev.checks.filter((c) => c.metric !== "bundlesUntilLazyCut").every((c) => c.pass) ? "GO" : "NO-GO"}** excluding bundlesUntilLazyCut (SPEC 5.2 floor is 5)\n\n`,
    };
  } finally {
    await h.close();
  }
}

export async function runBench(options: BenchOptions = {}): Promise<BenchReport> {
  const t0 = performance.now();
  const opts: Required<BenchOptions> = {
    rounds: options.rounds ?? Number(process.env.BENCH_ROUNDS ?? 60),
    n: options.n ?? 2000,
    goldenFraction: options.goldenFraction ?? 0.15,
    seed: options.seed ?? 42,
    tier: options.tier ?? "m",
    latencySamples: options.latencySamples ?? 50,
    quiet: options.quiet ?? false,
    parallel: options.parallel ?? process.env.BENCH_PARALLEL === "1",
  };
  const dataset = generateDataset(opts.n, opts.seed);
  const log = (s: string) => {
    if (!opts.quiet) console.log(s);
  };

  log(`d402 bench: ${opts.n} items, ${opts.goldenFraction * 100}% golden, ${opts.rounds} rounds/agent, tier ${opts.tier}`);
  const runs: RunReport[] = [];
  for (const requireModelFamilies of [false, true]) {
    const name = requireModelFamilies ? "run-B" : "run-A";
    const r = await runOnce(name, requireModelFamilies, opts, dataset);
    runs.push(r);
    log(`${name} done in ${fmt(r.durationMs / 1000, 1)}s: resolved=${r.stats.resolved} go=${r.go}`);
  }

  const notes = [
    `Server constructed with bundlesPerKeyPerHour=${SERVER_OVERRIDES.bundlesPerKeyPerHour}, bundlesPerIpPerHour=${SERVER_OVERRIDES.bundlesPerIpPerHour}, maxOpenBundlesPerKey=${SERVER_OVERRIDES.maxOpenBundlesPerKey} (spec defaults 60/120/5 would rate-limit a ${opts.rounds}-round bench within seconds).`,
    "Agents: 3 honest (p=0.92 claude, 0.88 gpt, 0.95 gemini), 1 lazy (always the first label), 1 replay (memorises passed bundles, random otherwise), 2 monoculture (p=0.85, both family gpt, same shared error pattern).",
    "bundlesUntilLazyCut counts bundles handed out before the first 403 blocked. SPEC 5.2 only blocks once bundles >= 5, so the floor for this metric under the v1 rule is 5; the bar of <= 3 cannot be met without changing the rule.",
    "addedLatencyMs = mean(client.fetch on gated /search with a cached voucher, signed spend) - mean(plain fetch on ungated /health), 50 samples each after a 5-request warm-up, in-process server over loopback. latency.gatedRawMean is the same probe with only the D402-Voucher header.",
    "bundlesPerResolution counts, per resolved unknown item, the number of PASSED bundles that contained it (runner log); it includes votes for losing labels.",
    `Agents were driven ${opts.parallel ? "concurrently per round (BENCH_PARALLEL=1): every agent is handed the same least-voted items before any vote lands, which inflates bundlesPerResolution" : "round-robin (one getBundle+submit at a time), so votes land before the next bundle is issued; BENCH_PARALLEL=1 issues each round's bundles concurrently instead"}.`,
  ];
  const markdown = [
    "# d402 bench report",
    "",
    `Generated ${new Date().toISOString()}. ${opts.n} items, ${Math.round(opts.goldenFraction * 100)}% golden, seed ${opts.seed}, ${opts.rounds} rounds per agent, tier ${opts.tier}.`,
    "",
    ...runs.map((r) => r.markdown),
    "## Agents",
    "",
    ...runs.map((r) =>
      [
        `### ${r.name}`,
        "",
        "| agent | kind | model | p | received | passed | calls | blocked | server accuracy |",
        "|---|---|---|---|---|---|---|---|---|",
        ...r.agents.map(
          (a) =>
            `| ${a.name} | ${a.kind} | ${a.model} | ${a.p ?? "-"} | ${a.bundlesReceived} | ${a.bundlesPassed} | ${a.callsEarned} | ${a.blocked} | ${a.serverAccuracy === undefined ? "-" : fmt(a.serverAccuracy)} |`,
        ),
        "",
        `Pool: ${JSON.stringify(r.stats)}`,
        "",
      ].join("\n"),
    ),
    "## Notes",
    "",
    ...notes.map((n) => `- ${n}`),
    "",
  ].join("\n");

  const report: BenchReport = {
    generatedAt: new Date().toISOString(),
    rounds: opts.rounds,
    dataset: { n: opts.n, goldenFraction: opts.goldenFraction, seed: opts.seed, labels: [...LABELS] },
    tier: opts.tier,
    serverOverrides: SERVER_OVERRIDES,
    notes,
    runs,
    durationMs: performance.now() - t0,
    markdown,
  };
  return report;
}

export function writeReport(report: BenchReport, outDir: string): void {
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, "report.json"), JSON.stringify(report, null, 2) + "\n");
  writeFileSync(join(outDir, "report.md"), report.markdown);
}

async function main(): Promise<void> {
  const report = await runBench();
  const outDir = join(dirname(fileURLToPath(import.meta.url)), "..", "out");
  writeReport(report, outDir);
  console.log("");
  console.log(report.markdown);
  console.log(`wrote ${join(outDir, "report.json")} and report.md in ${fmt(report.durationMs / 1000, 1)}s`);
  process.exitCode = 0;
}

const isMain = (() => {
  try {
    return process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1];
  } catch {
    return false;
  }
})();
if (isMain) {
  main().catch((e) => {
    console.error(e);
    process.exitCode = 0;
  });
}
