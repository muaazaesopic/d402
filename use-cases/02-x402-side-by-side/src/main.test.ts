import { describe, expect, it } from "vitest";
import { run } from "./main.js";

describe("02 x402 side by side", () => {
  it("the offer carries both schemes; the wallet-less agent gets the data via d402", async () => {
    const s = await run({ silent: true });
    expect(s.schemes).toEqual(["d402", "exact"]);
    expect(s.wallet.status).toBe(402);
    expect(s.wallet.wouldPayUsdc).toBeCloseTo(0.007, 6);
    expect(s.wallet.settled).toBe(false);
    expect(s.noWallet.status).toBe(200);
    expect(s.noWallet.bundles).toBeGreaterThanOrEqual(1);
    expect(s.noWallet.callsRemaining).toBe("9");
    expect(s.noWallet.body).toMatchObject({ symbol: "ACME", currency: "USD" });
  });
});
