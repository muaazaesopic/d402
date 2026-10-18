import { describe, expect, it } from "vitest";
import { FREE_PER_MINUTE, run } from "./main.js";

describe("03 rate limit upgrade", () => {
  it("5 free requests, then a 402 offer, then paid requests on an earned voucher", async () => {
    const s = await run({ silent: true });
    expect(s.free).toBe(FREE_PER_MINUTE);
    expect(s.paid).toBe(12 - FREE_PER_MINUTE);
    expect(s.offers402).toBe(1);
    expect(s.bundles).toBeGreaterThanOrEqual(1);
    expect(s.finalCallsRemaining).toBe(String(10 - (12 - FREE_PER_MINUTE)));
    // The 6th forecast request on the wire is the 402; it is followed by bundle GET, submit POST, retry 200.
    const forecasts = s.wire.filter((e) => e.path.startsWith("/forecast"));
    expect(forecasts[5]!.status).toBe(402);
    expect(forecasts.slice(0, 5).every((e) => e.tier === "free")).toBe(true);
    expect(s.wire.some((e) => e.status === 429)).toBe(false);
  });
});
