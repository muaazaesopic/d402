import { readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { run } from "./main.js";

describe("01 dataset builder", () => {
  it("three agents label 500 tickets and the seller exports accurate resolved labels", async () => {
    const outFile = join(mkdtempSync(join(tmpdir(), "d402-uc01-")), "labels.jsonl");
    const s = await run({ silent: true, outFile });
    expect(s.unknown).toBe(500);
    expect(s.resolved).toBeGreaterThanOrEqual(250);
    expect(s.accuracy).toBeGreaterThanOrEqual(0.95);
    expect(s.agents).toHaveLength(3);
    for (const a of s.agents) expect(a.serverAccuracy).toBeGreaterThan(0.8);

    const lines = readFileSync(outFile, "utf8").trim().split("\n");
    expect(lines).toHaveLength(s.resolved);
    const row = JSON.parse(lines[0]!) as { id: string; label: string; voters: number };
    expect(["low", "medium", "high", "critical"]).toContain(row.label);
    expect(row.voters).toBeGreaterThanOrEqual(2);
  });
});
