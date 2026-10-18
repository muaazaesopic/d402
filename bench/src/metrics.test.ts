import { describe, expect, it } from "vitest";
import {
  addedLatencyMs,
  bundlesPerResolution,
  bundlesUntilLazyCut,
  evaluate,
  honestGoldenPassRate,
  markdownTable,
  monocultureWrongResolved,
  replayAgentCalls,
  resolvedAccuracy,
  singleAgentAccuracy,
  tokensPerCall,
  type BundleLog,
  type Metrics,
} from "./metrics.js";

function log(partial: Partial<BundleLog> & Pick<BundleLog, "kind" | "passed">): BundleLog {
  return {
    agent: partial.kind,
    model: "claude",
    round: 0,
    received: true,
    calls: partial.passed ? 60 : 0,
    estTokens: 5000,
    itemIds: Object.keys(partial.answers ?? {}),
    answers: {},
    ...partial,
  };
}

const truth = { a: "tech", b: "sports", c: "world", d: "business" };

describe("metrics", () => {
  it("resolvedAccuracy counts correct resolved items", () => {
    const r = resolvedAccuracy(
      [
        { id: "a", answer: "tech" },
        { id: "b", answer: "sports" },
        { id: "c", answer: "tech" },
      ],
      truth,
    );
    expect(r.value).toBeCloseTo(2 / 3);
    expect(r.resolved).toBe(3);
  });

  it("honestGoldenPassRate only counts honest received bundles", () => {
    const logs = [
      log({ kind: "honest", passed: true }),
      log({ kind: "honest", passed: false, error: "quality" }),
      log({ kind: "honest", passed: false, received: false, error: "rate_limited" }),
      log({ kind: "lazy", passed: false }),
    ];
    expect(honestGoldenPassRate(logs).value).toBeCloseTo(0.5);
  });

  it("bundlesPerResolution uses the runner's vote log and falls back to voters", () => {
    const logs = [
      log({ kind: "honest", passed: true, answers: { a: "tech", b: "sports" } }),
      log({ kind: "honest", passed: true, answers: { a: "tech" } }),
      log({ kind: "honest", passed: false, answers: { a: "x", b: "x" } }),
      log({ kind: "honest", passed: true, answers: { a: "tech" } }),
    ];
    const r = bundlesPerResolution(
      [
        { id: "a", answer: "tech" },
        { id: "b", answer: "sports" },
      ],
      logs,
    );
    expect(r.value).toBe(2); // a: 3 passed, b: 1 passed
    expect(r.samples).toBe(2);
    expect(bundlesPerResolution([{ id: "z", answer: "tech", voters: ["k1", "k2", "k3"] }]).value).toBe(3);
    expect(bundlesPerResolution([{ id: "z", answer: "tech", voters: 4 }]).value).toBe(4);
  });

  it("tokensPerCall divides est_tokens by calls over passed bundles", () => {
    const logs = [
      log({ kind: "honest", passed: true, calls: 60, estTokens: 5000 }),
      log({ kind: "honest", passed: true, calls: 10, estTokens: 1000 }),
      log({ kind: "honest", passed: false, calls: 0, estTokens: 5000 }),
    ];
    expect(tokensPerCall(logs).value).toBeCloseTo(6000 / 70);
  });

  it("addedLatencyMs is mean gated minus mean baseline", () => {
    const r = addedLatencyMs([3, 5, 7], [1, 2, 3]);
    expect(r.value).toBeCloseTo(3);
    expect(r.gatedP50).toBe(5);
    expect(r.samples).toBe(3);
  });

  it("bundlesUntilLazyCut counts received bundles before the first 403 blocked", () => {
    const logs = [
      log({ kind: "honest", passed: true }),
      log({ kind: "lazy", passed: false }),
      log({ kind: "lazy", passed: false }),
      log({ kind: "lazy", passed: false, received: false, error: "blocked" }),
      log({ kind: "lazy", passed: false, received: false, error: "blocked" }),
    ];
    expect(bundlesUntilLazyCut(logs)).toEqual({ value: 2, blocked: true });
    expect(bundlesUntilLazyCut(logs.slice(0, 3))).toEqual({ value: 2, blocked: false });
  });

  it("singleAgentAccuracy ignores golden items and non-honest agents", () => {
    const logs = [
      log({ kind: "honest", agent: "h1", passed: true, answers: { a: "tech", b: "x", c: "world" } }),
      log({ kind: "lazy", agent: "l", passed: false, answers: { a: "sports" } }),
    ];
    const r = singleAgentAccuracy(logs, truth, new Set(["c"]));
    expect(r.value).toBeCloseTo(0.5);
    expect(r.perAgent.h1).toBeCloseTo(0.5);
  });

  it("replayAgentCalls and monocultureWrongResolved", () => {
    const logs = [log({ kind: "replay", passed: true, calls: 60 }), log({ kind: "replay", passed: false, calls: 0 })];
    expect(replayAgentCalls(logs)).toBe(60);
    const shared = new Map([
      ["a", "world"],
      ["b", "tech"],
    ]);
    expect(
      monocultureWrongResolved(
        [
          { id: "a", answer: "world" },
          { id: "b", answer: "sports" },
        ],
        shared,
      ),
    ).toBe(1);
  });

  it("evaluate applies the go/no-go bars and renders a table", () => {
    const m: Metrics = {
      resolvedAccuracy: 0.95,
      resolvedCount: 100,
      honestGoldenPassRate: 0.9,
      honestBundlesAttempted: 100,
      bundlesPerResolution: 3,
      tokensPerCall: 83,
      addedLatencyMs: 2,
      gatedLatencyMs: 3,
      baselineLatencyMs: 1,
      bundlesUntilLazyCut: 3,
      lazyBlocked: true,
      singleAgentAccuracy: 0.9,
      singleAgentAccuracyPerAgent: {},
      replayAgentCalls: 0,
      monocultureWrongResolved: 0,
    };
    expect(evaluate(m).go).toBe(true);
    expect(evaluate({ ...m, singleAgentAccuracy: 0.96 }).go).toBe(false);
    expect(evaluate({ ...m, lazyBlocked: false }).go).toBe(false);
    expect(evaluate({ ...m, bundlesUntilLazyCut: 5 }).go).toBe(false);
    const md = markdownTable("run", m, evaluate(m));
    expect(md).toContain("| resolvedAccuracy | 0.950 |");
    expect(md).toContain("**GO**");
  });
});
