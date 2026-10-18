/**
 * Pure metric functions over server exports and runner logs.
 */
import type { AgentBrain } from "./agents.js";

export interface ResolvedItem {
  id: string;
  text?: string;
  answer: string;
  weight?: number;
  /** Either a count of voters or the list of voter keys, depending on the server. */
  voters?: number | string[] | unknown;
}

/** One bundle attempt as recorded by the runner. */
export interface BundleLog {
  agent: string;
  kind: AgentBrain["kind"];
  model: string;
  round: number;
  /** false when the task endpoint refused to hand out a bundle (blocked / rate limited / no tasks). */
  received: boolean;
  /** error code when not received or when the submit failed (e.g. "quality", "blocked"). */
  error?: string;
  passed: boolean;
  /** Calls earned by this bundle (0 unless passed). */
  calls: number;
  /** tier.est_tokens for the bundle's tier. */
  estTokens: number;
  itemIds: string[];
  answers: Record<string, string>;
}

export interface Ratio {
  value: number;
  numerator: number;
  denominator: number;
}

function ratio(numerator: number, denominator: number): Ratio {
  return { value: denominator > 0 ? numerator / denominator : NaN, numerator, denominator };
}

export function mean(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN;
}

export function median(xs: number[]): number {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

/** 1. Fraction of resolved items whose answer equals the hidden truth. */
export function resolvedAccuracy(resolved: ResolvedItem[], truth: Record<string, string>): Ratio & { resolved: number } {
  let correct = 0;
  for (const r of resolved) if (truth[r.id] === r.answer) correct++;
  return { ...ratio(correct, resolved.length), resolved: resolved.length };
}

/** 2. Bundles passed / bundles attempted (received) for honest agents. */
export function honestGoldenPassRate(logs: BundleLog[]): Ratio {
  const honest = logs.filter((l) => l.kind === "honest" && l.received);
  return ratio(honest.filter((l) => l.passed).length, honest.length);
}

/** Votes per item id: number of PASSED bundles that contained the item. */
export function votesPerItem(logs: BundleLog[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const l of logs) {
    if (!l.passed) continue;
    for (const id of l.itemIds) m.set(id, (m.get(id) ?? 0) + 1);
  }
  return m;
}

function voterCount(v: ResolvedItem["voters"]): number | undefined {
  if (typeof v === "number") return v;
  if (Array.isArray(v)) return v.length;
  return undefined;
}

/**
 * 3. Mean number of bundle-votes a resolved item received before resolving.
 * Prefers the runner's log (every passed bundle containing the item); falls back
 * to the server's `voters` field when no log is available.
 */
export function bundlesPerResolution(resolved: ResolvedItem[], logs: BundleLog[] = []): { value: number; samples: number } {
  const votes = votesPerItem(logs);
  const counts: number[] = [];
  for (const r of resolved) {
    const fromLog = votes.get(r.id);
    const n = fromLog ?? voterCount(r.voters);
    if (n !== undefined) counts.push(n);
  }
  return { value: mean(counts), samples: counts.length };
}

/** 4. Sum of est_tokens over passed bundles / sum of calls earned. */
export function tokensPerCall(logs: BundleLog[]): Ratio {
  let tokens = 0;
  let calls = 0;
  for (const l of logs) {
    if (!l.passed) continue;
    tokens += l.estTokens;
    calls += l.calls;
  }
  return ratio(tokens, calls);
}

/** 5. Added latency of a gated request (cached voucher) over an ungated baseline. */
export function addedLatencyMs(gatedMs: number[], baselineMs: number[]): {
  value: number;
  gatedMean: number;
  gatedP50: number;
  baselineMean: number;
  baselineP50: number;
  samples: number;
} {
  const gatedMean = mean(gatedMs);
  const baselineMean = mean(baselineMs);
  return {
    value: gatedMean - baselineMean,
    gatedMean,
    gatedP50: median(gatedMs),
    baselineMean,
    baselineP50: median(baselineMs),
    samples: Math.min(gatedMs.length, baselineMs.length),
  };
}

/** 6. Bundles the lazy agent received before its first 403 blocked. */
export function bundlesUntilLazyCut(logs: BundleLog[]): { value: number; blocked: boolean } {
  let n = 0;
  for (const l of logs) {
    if (l.kind !== "lazy") continue;
    if (!l.received && l.error === "blocked") return { value: n, blocked: true };
    if (l.received) n++;
  }
  return { value: n, blocked: false };
}

/** Observed accuracy of honest agents on unknown (non-golden) items, pass or fail. */
export function singleAgentAccuracy(
  logs: BundleLog[],
  truth: Record<string, string>,
  goldenIds: Set<string>,
): Ratio & { perAgent: Record<string, number> } {
  let correct = 0;
  let total = 0;
  const per: Record<string, { c: number; n: number }> = {};
  for (const l of logs) {
    if (l.kind !== "honest" || !l.received) continue;
    const acc = (per[l.agent] ??= { c: 0, n: 0 });
    for (const [id, label] of Object.entries(l.answers)) {
      if (goldenIds.has(id)) continue;
      total++;
      acc.n++;
      if (truth[id] === label) {
        correct++;
        acc.c++;
      }
    }
  }
  const perAgent: Record<string, number> = {};
  for (const [k, v] of Object.entries(per)) perAgent[k] = v.n ? v.c / v.n : NaN;
  return { ...ratio(correct, total), perAgent };
}

/** Calls the replay agent earned. */
export function replayAgentCalls(logs: BundleLog[]): number {
  return logs.filter((l) => l.kind === "replay" && l.passed).reduce((a, l) => a + l.calls, 0);
}

/** Resolved items whose answer is the monoculture agents' shared wrong label. */
export function monocultureWrongResolved(resolved: ResolvedItem[], sharedError: Map<string, string>): number {
  let n = 0;
  for (const r of resolved) if (sharedError.get(r.id) === r.answer) n++;
  return n;
}

export interface Metrics {
  resolvedAccuracy: number;
  resolvedCount: number;
  honestGoldenPassRate: number;
  honestBundlesAttempted: number;
  bundlesPerResolution: number;
  tokensPerCall: number;
  addedLatencyMs: number;
  gatedLatencyMs: number;
  baselineLatencyMs: number;
  bundlesUntilLazyCut: number;
  lazyBlocked: boolean;
  singleAgentAccuracy: number;
  singleAgentAccuracyPerAgent: Record<string, number>;
  replayAgentCalls: number;
  monocultureWrongResolved: number;
}

export const BARS = {
  resolvedAccuracy: 0.9,
  honestGoldenPassRate: 0.85,
  bundlesPerResolution: 4,
  tokensPerCall: 200,
  addedLatencyMs: 500,
  bundlesUntilLazyCut: 3,
} as const;

export interface Check {
  metric: keyof typeof BARS;
  value: number;
  bar: string;
  pass: boolean;
}

export function evaluate(m: Metrics): { checks: Check[]; go: boolean } {
  const checks: Check[] = [
    {
      metric: "resolvedAccuracy",
      value: m.resolvedAccuracy,
      bar: `>= ${BARS.resolvedAccuracy} and > single-agent (${fmt(m.singleAgentAccuracy)})`,
      pass: m.resolvedAccuracy >= BARS.resolvedAccuracy && m.resolvedAccuracy > m.singleAgentAccuracy,
    },
    {
      metric: "honestGoldenPassRate",
      value: m.honestGoldenPassRate,
      bar: `> ${BARS.honestGoldenPassRate}`,
      pass: m.honestGoldenPassRate > BARS.honestGoldenPassRate,
    },
    {
      metric: "bundlesPerResolution",
      value: m.bundlesPerResolution,
      bar: `< ${BARS.bundlesPerResolution}`,
      pass: m.bundlesPerResolution < BARS.bundlesPerResolution,
    },
    { metric: "tokensPerCall", value: m.tokensPerCall, bar: `< ${BARS.tokensPerCall}`, pass: m.tokensPerCall < BARS.tokensPerCall },
    { metric: "addedLatencyMs", value: m.addedLatencyMs, bar: `< ${BARS.addedLatencyMs}`, pass: m.addedLatencyMs < BARS.addedLatencyMs },
    {
      metric: "bundlesUntilLazyCut",
      value: m.bundlesUntilLazyCut,
      bar: `<= ${BARS.bundlesUntilLazyCut}`,
      pass: m.lazyBlocked && m.bundlesUntilLazyCut <= BARS.bundlesUntilLazyCut,
    },
  ];
  return { checks, go: checks.every((c) => c.pass) };
}

export function fmt(x: number, digits = 3): string {
  if (!Number.isFinite(x)) return String(x);
  return Number.isInteger(x) ? String(x) : x.toFixed(digits);
}

export function markdownTable(title: string, m: Metrics, ev: ReturnType<typeof evaluate>): string {
  const lines = [
    `### ${title}`,
    "",
    "| metric | value | bar | pass |",
    "|---|---|---|---|",
    ...ev.checks.map((c) => `| ${c.metric} | ${fmt(c.value)} | ${c.bar} | ${c.pass ? "yes" : "no"} |`),
    `| singleAgentAccuracy | ${fmt(m.singleAgentAccuracy)} | (reference) | - |`,
    `| resolvedCount | ${m.resolvedCount} | (reference) | - |`,
    `| honestBundlesAttempted | ${m.honestBundlesAttempted} | (reference) | - |`,
    `| gatedLatencyMs / baselineLatencyMs | ${fmt(m.gatedLatencyMs)} / ${fmt(m.baselineLatencyMs)} | (reference) | - |`,
    `| lazyBlocked | ${m.lazyBlocked} | (reference) | - |`,
    `| replayAgentCalls | ${m.replayAgentCalls} | (reference) | - |`,
    `| monocultureWrongResolved | ${m.monocultureWrongResolved} | (reference) | - |`,
    "",
    `**${ev.go ? "GO" : "NO-GO"}** (${title})`,
    "",
  ];
  return lines.join("\n");
}
