import { describe, expect, it } from "vitest";
import { run } from "./main.js";

describe("06 trust tiers", () => {
  it("the honest agent moves down the golden bands; the lazy agent is blocked after 5 bundles", async () => {
    const s = await run({ silent: true });
    expect(s.checkpoints.map((c) => c.bundles)).toEqual([0, 10, 20, 30, 40, 50, 60]);
    expect(s.checkpoints[0]!.band).toBe(0.4);
    expect(s.checkpoints[1]!.band).toBe(0.2); // bundles >= 10 and accuracy >= 0.9
    expect(s.honest.finalBand).toBeLessThanOrEqual(0.2);
    expect(s.honest.passed).toBeGreaterThanOrEqual(50);
    expect(s.honest.calls).toBe(s.honest.passed * 40);
    expect(s.lazy.bundles).toBe(5);
    expect(s.lazy.blockedAt).toBe(6);
    expect(s.lazy.calls).toBe(0);
    const bands = s.checkpoints.map((c) => c.band);
    for (let i = 1; i < bands.length; i++) expect(bands[i]!).toBeLessThanOrEqual(bands[i - 1]!);
  });
});
