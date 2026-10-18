import { describe, expect, it } from "vitest";
import { run } from "./main.js";

describe("04 MCP agent", () => {
  it("drives the real d402-mcp binary over stdio: discover, bundle, submit, fetch", async () => {
    const s = await run({ silent: true });
    for (const t of ["d402_discover", "d402_get_bundle", "d402_submit", "d402_fetch", "d402_status"]) {
      expect(s.tools).toContain(t);
    }
    expect(s.discover.sellerId).toBe("docs.example");
    expect(s.bundleItems).toBe(5);
    expect(s.submit.calls).toBe(10);
    expect(s.fetch.status).toBe(200);
    expect(s.fetch.callsRemaining).toBe("9");
    expect(s.fetch.body).toMatchObject({ term: "d402" });
    expect(s.vouchers).toBe(1);
  });
});
