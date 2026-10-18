import { describe, expect, it } from "vitest";
import { LABELS, generateDataset, mulberry32, toTaskFile, truthMap } from "./gen-dataset.js";

describe("generateDataset", () => {
  it("is deterministic for the same seed and differs across seeds", () => {
    const a = generateDataset(200, 7);
    const b = generateDataset(200, 7);
    const c = generateDataset(200, 8);
    expect(a).toEqual(b);
    expect(a.map((i) => i.text)).not.toEqual(c.map((i) => i.text));
  });

  it("balances the four labels", () => {
    const items = generateDataset(400, 1);
    const counts: Record<string, number> = {};
    for (const it of items) counts[it.truth] = (counts[it.truth] ?? 0) + 1;
    for (const l of LABELS) expect(counts[l]).toBe(100);
  });

  it("produces unique ids and non-empty text", () => {
    const items = generateDataset(500, 3);
    expect(new Set(items.map((i) => i.id)).size).toBe(500);
    for (const it of items) expect(it.text.length).toBeGreaterThan(10);
  });

  it("does not leak the label through id ordering", () => {
    const items = generateDataset(40, 11);
    const first = items.slice(0, 8).map((i) => i.truth);
    expect(new Set(first).size).toBeGreaterThan(1);
  });
});

describe("toTaskFile", () => {
  it("marks goldenFraction of items with golden = truth", () => {
    const items = generateDataset(1000, 5);
    const rows = toTaskFile(items, 0.15, 5);
    const golden = rows.filter((r) => r.golden !== undefined);
    expect(golden.length).toBe(150);
    const truth = truthMap(items);
    for (const g of golden) expect(g.golden).toBe(truth[g.id]);
    for (const r of rows) expect(r.type).toBe("classify");
    expect(rows.map((r) => r.id)).toEqual(items.map((i) => i.id));
  });

  it("is deterministic in which items are golden", () => {
    const items = generateDataset(300, 9);
    const a = toTaskFile(items, 0.2, 9).filter((r) => r.golden).map((r) => r.id);
    const b = toTaskFile(items, 0.2, 9).filter((r) => r.golden).map((r) => r.id);
    expect(a).toEqual(b);
  });
});

describe("mulberry32", () => {
  it("yields floats in [0,1) with a roughly uniform mean", () => {
    const rng = mulberry32(123);
    let sum = 0;
    for (let i = 0; i < 10_000; i++) {
      const x = rng();
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThan(1);
      sum += x;
    }
    expect(sum / 10_000).toBeCloseTo(0.5, 1);
  });
});
