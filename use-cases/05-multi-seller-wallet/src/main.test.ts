import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { run } from "./main.js";

describe("05 multi-seller wallet", () => {
  it("one cache dir holds 3 vouchers and a solver-less client spends them", async () => {
    const s = await run({ silent: true });
    expect(s.afterEarn).toHaveLength(3);
    expect(new Set(s.afterEarn.map((v) => v.sellerId))).toEqual(new Set(["news.example", "helpdesk.example", "shop.example"]));
    expect(s.afterEarn.map((v) => v.calls).sort((a, b) => a - b)).toEqual([9, 14, 19]);
    expect(Object.values(s.bundlesPerSeller)).toEqual([1, 1, 1]);
    for (const r of s.secondClient) expect(r.status).toBe(200);
    expect(s.afterSpend.map((v) => v.calls).sort((a, b) => a - b)).toEqual([8, 13, 18]);
    expect(existsSync(join(s.cacheDir, "vouchers.json"))).toBe(true);
  });
});
