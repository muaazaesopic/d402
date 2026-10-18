import { describe, expect, it } from "vitest";
import { runBench } from "./run.js";

const SIX = [
  "resolvedAccuracy",
  "honestGoldenPassRate",
  "bundlesPerResolution",
  "tokensPerCall",
  "addedLatencyMs",
  "bundlesUntilLazyCut",
] as const;

describe("bench smoke (real @d402/server + @d402/client)", () => {
  it("runs both configurations with BENCH_ROUNDS=5 and reports six finite metrics", async () => {
    const report = await runBench({ rounds: 5, quiet: true, latencySamples: 10 });
    expect(report.runs).toHaveLength(2);
    expect(report.runs[0]!.requireModelFamilies).toBe(false);
    expect(report.runs[1]!.requireModelFamilies).toBe(true);
    for (const run of report.runs) {
      for (const k of SIX) expect(Number.isFinite(run.metrics[k]), `${run.name}.${k}`).toBe(true);
      expect(run.checks).toHaveLength(6);
      expect(typeof run.go).toBe("boolean");
      expect(run.metrics.tokensPerCall).toBeCloseTo(5000 / 60);
      expect(run.metrics.honestBundlesAttempted).toBe(15);
      expect(run.stats.total).toBe(2000);
      expect(run.stats.golden).toBe(300);
      expect(run.markdown).toContain("| resolvedAccuracy |");
    }
    expect(report.markdown).toContain("# d402 bench report");
  }, 60_000);
});
