import { describe, expect, it } from "vitest";
import { ARTICLE_COUNT, CALLS_PER_BUNDLE, run } from "./main.js";

describe("07 paid crawl", () => {
  it("crawls all 10 articles on a single earned voucher", async () => {
    const s = await run({ silent: true });
    expect(s.fetched).toHaveLength(ARTICLE_COUNT);
    expect(s.fetched.every((f) => f.status === 200)).toBe(true);
    expect(s.fetched.every((f) => f.title.length > 0)).toBe(true);
    expect(s.vouchers).toBe(1);
    expect(s.attempts).toBeLessThanOrEqual(3);
    expect(s.serverBundles).toBe(s.attempts);
    const remaining = s.fetched.map((f) => Number(f.callsRemaining));
    expect(remaining).toEqual(Array.from({ length: ARTICLE_COUNT }, (_, i) => CALLS_PER_BUNDLE - 1 - i));
  });
});
