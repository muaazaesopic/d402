/**
 * End-to-end tests for the d402 MCP binary over real stdio.
 *
 * Every test starts a real seller (`@d402/server` behind `@hono/node-server`)
 * and spawns the real MCP server process (`node --import tsx packages/mcp/src/bin.ts`),
 * then drives it with the MCP SDK client over stdin/stdout.
 *
 * Run: pnpm exec vitest run tests/e2e/mcp-stdio
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { signSubmit } from "@d402/spec";
import {
  LABELS,
  MCP_BIN_TS,
  REPO_ROOT,
  SELLER_ID,
  answerBundle,
  call,
  makeHome,
  processAlive,
  solverCmd,
  startBareServer,
  startMcp,
  startSeller,
  waitForExit,
  writeTruth,
  wrongAnswers,
  type McpHandle,
  type McpOptions,
  type SellerHandle,
  type SellerOptions,
} from "./mcp-helpers.js";

const TOOL_NAMES = ["d402_discover", "d402_get_bundle", "d402_submit", "d402_fetch", "d402_status"];
const CALLS_REMAINING = "D402-Calls-Remaining";

// ---------------------------------------------------------------------------
// Fixture bookkeeping: everything started in a test is closed in afterEach.
// ---------------------------------------------------------------------------

let liveMcps: McpHandle[] = [];
let liveClosers: Array<() => Promise<void>> = [];

async function seller(opts?: SellerOptions): Promise<SellerHandle> {
  const s = await startSeller(opts);
  liveClosers.push(s.close);
  return s;
}

async function mcp(env: Record<string, string> = {}, opts?: McpOptions): Promise<McpHandle> {
  const m = await startMcp(env, opts);
  liveMcps.push(m);
  return m;
}

afterEach(async () => {
  // Children first so their keep-alive sockets do not hold the seller open.
  for (const m of liveMcps) await m.destroy();
  for (const close of liveClosers) await close();
  liveMcps = [];
  liveClosers = [];
});

/** Manual earn: get the smallest bundle, answer it from the truth map, submit. */
async function earnManually(m: McpHandle, s: SellerHandle) {
  const bundle = await call(m.client, "d402_get_bundle", { baseUrl: s.baseUrl });
  expect(bundle.isError, bundle.text).toBe(false);
  const submit = await call(m.client, "d402_submit", {
    taskUrl: bundle.data.taskUrl,
    bundleId: bundle.data.bundleId,
    answers: answerBundle(bundle.data, s.truth),
  });
  expect(submit.isError, submit.text).toBe(false);
  return { bundle, submit };
}

// ---------------------------------------------------------------------------

describe("tools/list over stdio", () => {
  it("exposes exactly the five d402 tools with object input schemas", async () => {
    const m = await mcp();
    const { tools } = await m.client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([...TOOL_NAMES].sort());
    for (const t of tools) {
      expect(t.inputSchema.type, t.name).toBe("object");
      expect(t.description, t.name).toBeTruthy();
    }
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    expect(byName.d402_discover!.inputSchema.required).toEqual(["baseUrl"]);
    expect(byName.d402_fetch!.inputSchema.required).toEqual(["url"]);
    expect(Object.keys(byName.d402_fetch!.inputSchema.properties ?? {}).sort()).toEqual(
      ["autoEarn", "body", "headers", "method", "url"].sort(),
    );
    expect(byName.d402_submit!.inputSchema.required?.sort()).toEqual(["answers", "bundleId", "taskUrl"]);
    expect(Object.keys(byName.d402_get_bundle!.inputSchema.properties ?? {}).sort()).toEqual(["baseUrl", "taskUrl", "tier"]);
    expect(byName.d402_status!.inputSchema.required ?? []).toEqual([]);
  });

  it("identifies itself as d402 and its instructions describe the earn flow", async () => {
    const m = await mcp();
    expect(m.client.getServerVersion()?.name).toBe("d402");
    const instructions = m.client.getInstructions() ?? "";
    for (const name of TOOL_NAMES) expect(instructions).toContain(name);
  });
});

// ---------------------------------------------------------------------------

describe("d402_status", () => {
  it("creates keypair.json (0600) on a fresh home and reports the public key with no vouchers", async () => {
    const m = await mcp();
    const r = await call(m.client, "d402_status");
    expect(r.isError, r.text).toBe(false);

    const keyFile = join(m.home, "keypair.json");
    expect(existsSync(keyFile)).toBe(true);
    expect(statSync(keyFile).mode & 0o777).toBe(0o600);
    const onDisk = JSON.parse(readFileSync(keyFile, "utf8")) as { publicKey: string; privateKey: string };

    const pk = r.data.publicKey as string;
    expect(pk).toMatch(/^[A-Za-z0-9_-]{43,44}$/);
    expect(pk).toBe(onDisk.publicKey);
    expect(r.data.vouchers).toEqual([]);
    expect(r.data.pendingBundles).toEqual([]);
    expect(typeof r.data.now).toBe("number");
    expect(r.structured?.publicKey).toBe(pk);
  });

  it("keeps the same key across calls and does not rewrite the keypair file", async () => {
    const m = await mcp();
    const a = await call(m.client, "d402_status");
    const mtime = statSync(join(m.home, "keypair.json")).mtimeMs;
    const b = await call(m.client, "d402_status");
    expect(b.data.publicKey).toBe(a.data.publicKey);
    expect(statSync(join(m.home, "keypair.json")).mtimeMs).toBe(mtime);
  });
});

// ---------------------------------------------------------------------------

describe("d402_discover", () => {
  it("returns sellerId, taskUrl, scope and tiers for a real seller", async () => {
    const s = await seller();
    const m = await mcp();
    const r = await call(m.client, "d402_discover", { baseUrl: s.baseUrl });
    expect(r.isError, r.text).toBe(false);
    expect(r.data.sellerId).toBe(SELLER_ID);
    expect(r.data.taskUrl).toBe(s.taskUrl);
    expect(r.data.scope).toEqual(["/search"]);
    expect(r.data.taskTypes).toEqual(["classify"]);
    expect(r.data.tiers.map((t: { id: string; items: number }) => [t.id, t.items])).toEqual([
      ["s", 5],
      ["m", 25],
      ["l", 50],
    ]);
    expect(r.data.hint).toContain("d402_get_bundle");
  });

  it("returns an isError result with a clear message for an origin without d402", async () => {
    const bare = await startBareServer();
    liveClosers.push(bare.close);
    const m = await mcp();
    const r = await call(m.client, "d402_discover", { baseUrl: bare.baseUrl });
    expect(r.isError).toBe(true);
    expect(r.data.code).toBe("no_d402");
    expect(r.text).toMatch(/does not offer d402/);
    expect(r.text).toContain(bare.baseUrl);
    expect(r.text).toContain("/.well-known/d402");
  });

  it("returns an isError result when the seller cannot be reached", async () => {
    // Grab a port, release it, then point discover at it.
    const s = await startSeller();
    const dead = s.baseUrl;
    await s.close();
    const m = await mcp();
    const r = await call(m.client, "d402_discover", { baseUrl: dead });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("discover failed");
  });
});

// ---------------------------------------------------------------------------

describe("manual earn flow", () => {
  it("get_bundle -> submit -> status -> fetch spends the voucher and counts down", async () => {
    const s = await seller();
    const m = await mcp();

    const bundle = await call(m.client, "d402_get_bundle", { baseUrl: s.baseUrl });
    expect(bundle.isError, bundle.text).toBe(false);
    expect(bundle.data.tier).toBe("s");
    expect(bundle.data.type).toBe("classify");
    expect(bundle.data.items).toHaveLength(5);
    expect(bundle.data.labels).toEqual([...LABELS]);
    expect(bundle.data.taskUrl).toBe(s.taskUrl);
    expect(bundle.data.bundleId).toMatch(/^b_/);
    expect(bundle.data.hint).toContain("d402_submit");
    for (const it of bundle.data.items as { id: string; text: string }[]) {
      expect(s.truth.has(it.id), it.id).toBe(true);
      expect(typeof it.text).toBe("string");
    }

    const pending = await call(m.client, "d402_status");
    expect(pending.data.pendingBundles).toEqual([bundle.data.bundleId]);

    const submit = await call(m.client, "d402_submit", {
      taskUrl: bundle.data.taskUrl,
      bundleId: bundle.data.bundleId,
      answers: answerBundle(bundle.data, s.truth),
    });
    expect(submit.isError, submit.text).toBe(false);
    expect(submit.data.calls).toBe(10);
    expect(submit.data.sellerId).toBe(SELLER_ID);
    expect(submit.data.scope).toEqual(["/search"]);
    expect(submit.data.jti).toMatch(/^v_/);
    expect(s.d402.vouchers.get(submit.data.jti)?.callsLeft).toBe(10);

    const status = await call(m.client, "d402_status");
    expect(status.data.vouchers).toHaveLength(1);
    expect(status.data.vouchers[0]).toMatchObject({ jti: submit.data.jti, sellerId: SELLER_ID, calls: 10, scope: ["/search"], expired: false });
    expect(status.data.pendingBundles).toEqual([]);

    const first = await call(m.client, "d402_fetch", { url: `${s.baseUrl}/search?q=tech` });
    expect(first.isError, first.text).toBe(false);
    expect(first.data.status).toBe(200);
    expect(first.data.ok).toBe(true);
    expect(first.data.headers[CALLS_REMAINING]).toBe("9");
    expect(first.data.truncated).toBe(false);
    expect(JSON.parse(first.data.body)).toMatchObject({ q: "tech" });

    const second = await call(m.client, "d402_fetch", { url: `${s.baseUrl}/search?q=tech` });
    expect(second.data.status).toBe(200);
    expect(second.data.headers[CALLS_REMAINING]).toBe("8");

    const after = await call(m.client, "d402_status");
    expect(after.data.vouchers[0].calls).toBe(8);
    expect(s.d402.vouchers.get(submit.data.jti)?.callsLeft).toBe(8);
    expect(s.d402.tasks.stats().vouchers).toBe(1);
  });

  it("a non-gated route goes through d402_fetch without a voucher", async () => {
    const s = await seller();
    const m = await mcp();
    const r = await call(m.client, "d402_fetch", { url: `${s.baseUrl}/health` });
    expect(r.isError, r.text).toBe(false);
    expect(r.data.status).toBe(200);
    expect(r.data.headers[CALLS_REMAINING]).toBeUndefined();
    expect(JSON.parse(r.data.body)).toEqual({ ok: true });
  });
});

// ---------------------------------------------------------------------------

describe("d402_submit validation", () => {
  it("rejects answers that leave an item out and names the item", async () => {
    const s = await seller();
    const m = await mcp();
    const bundle = await call(m.client, "d402_get_bundle", { baseUrl: s.baseUrl });
    const answers = answerBundle(bundle.data, s.truth);
    const dropped = bundle.data.items[2].id as string;
    delete answers[dropped];

    const r = await call(m.client, "d402_submit", { taskUrl: s.taskUrl, bundleId: bundle.data.bundleId, answers });
    expect(r.isError).toBe(true);
    expect(r.data.code).toBe("invalid_answers");
    expect(r.text).toContain(dropped);
    expect(r.data.missing).toEqual([dropped]);
    // Nothing reached the seller: the bundle is still open and no voucher exists.
    expect((await call(m.client, "d402_status")).data.pendingBundles).toEqual([bundle.data.bundleId]);
    expect(s.d402.tasks.stats().vouchers).toBe(0);
    expect(s.d402.tasks.stats().openBundles).toBe(1);
  });

  it("rejects a label that is not in the bundle's labels", async () => {
    const s = await seller();
    const m = await mcp();
    const bundle = await call(m.client, "d402_get_bundle", { baseUrl: s.baseUrl });
    const answers = answerBundle(bundle.data, s.truth);
    const victim = bundle.data.items[0].id as string;
    answers[victim] = "weather";

    const r = await call(m.client, "d402_submit", { taskUrl: s.taskUrl, bundleId: bundle.data.bundleId, answers });
    expect(r.isError).toBe(true);
    expect(r.data.code).toBe("invalid_answers");
    expect(r.data.message).toContain(`${victim}="weather"`);
    expect(r.data.message).toContain("allowed: sports, business, tech, world");
    expect(r.data.badLabels).toEqual([{ id: victim, label: "weather" }]);
  });

  it("rejects answers for ids that are not in the bundle", async () => {
    const s = await seller();
    const m = await mcp();
    const bundle = await call(m.client, "d402_get_bundle", { baseUrl: s.baseUrl });
    const answers = { ...answerBundle(bundle.data, s.truth), i_999999: "tech" };
    const r = await call(m.client, "d402_submit", { taskUrl: s.taskUrl, bundleId: bundle.data.bundleId, answers });
    expect(r.isError).toBe(true);
    expect(r.data.unknownIds).toEqual(["i_999999"]);
    expect(r.text).toContain("i_999999");
  });

  it("rejects an unknown bundleId without contacting the seller", async () => {
    const s = await seller();
    const m = await mcp();
    const r = await call(m.client, "d402_submit", { taskUrl: s.taskUrl, bundleId: "b_nope", answers: { i_1: "tech" } });
    expect(r.isError).toBe(true);
    expect(r.data.code).toBe("unknown_bundle");
    expect(r.text).toContain("b_nope");
    expect(r.text).toContain("d402_get_bundle");
  });

  it("rejects submitting the same bundle twice", async () => {
    const s = await seller();
    const m = await mcp();
    const { bundle, submit } = await earnManually(m, s);
    expect(submit.isError).toBe(false);

    const again = await call(m.client, "d402_submit", {
      taskUrl: s.taskUrl,
      bundleId: bundle.data.bundleId,
      answers: answerBundle(bundle.data, s.truth),
    });
    expect(again.isError).toBe(true);
    // The MCP server forgets a bundle once it is submitted, so the second call
    // is refused locally (unknown_bundle) before the seller can say already_submitted.
    expect(["unknown_bundle", "already_submitted"]).toContain(again.data.code);
    expect(again.text).toContain("d402_get_bundle");
    expect(s.d402.tasks.stats().vouchers).toBe(1);
  });

  it("the seller itself answers already_submitted for a bundle the MCP server already submitted", async () => {
    const s = await seller();
    const m = await mcp();
    const { bundle } = await earnManually(m, s);

    // Resubmit directly with the MCP process's own keypair, bypassing its local check.
    const kp = JSON.parse(readFileSync(join(m.home, "keypair.json"), "utf8")) as { publicKey: string; privateKey: string };
    const answers = answerBundle(bundle.data, s.truth);
    const res = await fetch(`${s.taskUrl}/${bundle.data.bundleId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "D402-Key": kp.publicKey },
      body: JSON.stringify({ answers, sig: signSubmit(kp.privateKey, bundle.data.bundleId, answers) }),
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "already_submitted" });
    expect(s.d402.agents.get(kp.publicKey)?.bundles).toBe(1);
  });
});

// ---------------------------------------------------------------------------

describe("quality failure", () => {
  it("wrong answers on every item yield an isError that points at another bundle, and no voucher", async () => {
    const s = await seller();
    const m = await mcp();
    const bundle = await call(m.client, "d402_get_bundle", { baseUrl: s.baseUrl });
    const r = await call(m.client, "d402_submit", {
      taskUrl: s.taskUrl,
      bundleId: bundle.data.bundleId,
      answers: wrongAnswers(bundle.data, s.truth),
    });
    expect(r.isError).toBe(true);
    expect(r.data.code).toBe("quality");
    expect(r.data.status).toBe(422);
    expect(r.text).toMatch(/quality/i);
    expect(r.text).toMatch(/different bundle|another bundle|d402_get_bundle/);

    const status = await call(m.client, "d402_status");
    expect(status.data.vouchers).toEqual([]);
    expect(status.data.pendingBundles).toEqual([]);
    expect(s.d402.tasks.stats().vouchers).toBe(0);
    const agent = s.d402.agents.get(status.data.publicKey);
    expect(agent?.bundles).toBe(1);
    expect(agent?.goldenCorrect).toBe(0);
    expect(agent?.goldenSeen).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------

describe("d402_fetch without a voucher", () => {
  it("autoEarn false returns the offer and instructions naming d402_get_bundle and d402_submit", async () => {
    const s = await seller();
    const m = await mcp();
    const r = await call(m.client, "d402_fetch", { url: `${s.baseUrl}/search?q=tech` });
    expect(r.isError, r.text).toBe(false);
    expect(r.data.status).toBe(402);
    expect(r.data.needsVoucher).toBe(true);
    expect(r.data.reason).toBe("missing_voucher");
    expect(r.data.offer.sellerId).toBe(SELLER_ID);
    expect(r.data.offer.taskUrl).toBe(s.taskUrl);
    expect(r.data.offer.tiers).toHaveLength(3);
    expect(r.data.instructions).toContain("d402_get_bundle");
    expect(r.data.instructions).toContain("d402_submit");
    expect(r.data.instructions).toContain(s.taskUrl);
    expect(r.data.instructions).toContain('tier: "s"');
    expect(s.d402.tasks.stats().vouchers).toBe(0);
  });

  it("autoEarn true without D402_SOLVER_CMD is an isError that names the variable", async () => {
    const s = await seller();
    const m = await mcp();
    const r = await call(m.client, "d402_fetch", { url: `${s.baseUrl}/search?q=tech`, autoEarn: true });
    expect(r.isError).toBe(true);
    expect(r.data.code).toBe("no_solver");
    expect(r.text).toContain("D402_SOLVER_CMD");
    expect(r.data.offer.taskUrl).toBe(s.taskUrl);
    expect(s.d402.tasks.stats().vouchers).toBe(0);
    expect(s.d402.tasks.stats().openBundles).toBe(0);
  });

  it("a relative url is rejected before any request is made", async () => {
    const m = await mcp();
    const r = await call(m.client, "d402_fetch", { url: "/search?q=tech" });
    expect(r.isError).toBe(true);
    expect(r.data.code).toBe("bad_url");
  });
});

// ---------------------------------------------------------------------------

describe("autoEarn with D402_SOLVER_CMD", () => {
  it("earns through the solver command and serves the first fetch with 200", async () => {
    const s = await seller();
    const home = makeHome();
    const truthPath = writeTruth(s.truth, home);
    const m = await mcp({ D402_SOLVER_CMD: solverCmd(truthPath, home) }, { home });

    const r = await call(m.client, "d402_fetch", { url: `${s.baseUrl}/search?q=tech`, autoEarn: true });
    expect(r.isError, r.text).toBe(false);
    expect(r.data.status).toBe(200);
    expect(r.data.headers[CALLS_REMAINING]).toBe("9");
    expect(JSON.parse(r.data.body)).toMatchObject({ q: "tech" });

    const status = await call(m.client, "d402_status");
    expect(status.data.vouchers).toHaveLength(1);
    expect(status.data.vouchers[0]).toMatchObject({ sellerId: SELLER_ID, calls: 9 });
    expect(s.d402.tasks.stats().vouchers).toBe(1);
    expect(s.d402.agents.get(status.data.publicKey)?.bundles).toBe(1);
  });
});

// ---------------------------------------------------------------------------

describe("D402_TIER", () => {
  it("D402_TIER=m makes d402_get_bundle({ baseUrl }) return the 25-item tier", async () => {
    const s = await seller();
    const m = await mcp({ D402_TIER: "m" });
    const r = await call(m.client, "d402_get_bundle", { baseUrl: s.baseUrl });
    expect(r.isError, r.text).toBe(false);
    expect(r.data.tier).toBe("m");
    expect(r.data.items).toHaveLength(25);
  });

  it("an explicit tier argument overrides D402_TIER", async () => {
    const s = await seller();
    const m = await mcp({ D402_TIER: "m" });
    const r = await call(m.client, "d402_get_bundle", { baseUrl: s.baseUrl, tier: "l" });
    expect(r.isError, r.text).toBe(false);
    expect(r.data.tier).toBe("l");
    expect(r.data.items).toHaveLength(50);
    const viaTaskUrl = await call(m.client, "d402_get_bundle", { taskUrl: s.taskUrl, tier: "s" });
    expect(viaTaskUrl.isError, viaTaskUrl.text).toBe(false);
    expect(viaTaskUrl.data.items).toHaveLength(5);
  });

  it("a tier the seller does not offer is an isError, from env or argument", async () => {
    const s = await seller();
    const m = await mcp({ D402_TIER: "xl" });
    const fromEnv = await call(m.client, "d402_get_bundle", { baseUrl: s.baseUrl });
    expect(fromEnv.isError).toBe(true);
    expect(fromEnv.data.code).toBe("bad_tier");
    expect(fromEnv.data.message).toContain('tier "xl" is not offered');
    expect(fromEnv.data.tiers).toEqual(["s", "m", "l"]);

    const fromArg = await call(m.client, "d402_get_bundle", { taskUrl: s.taskUrl, tier: "xxl" });
    expect(fromArg.isError).toBe(true);
    expect(fromArg.data.code).toBe("bad_tier");
    expect(s.d402.tasks.stats().openBundles).toBe(0);
  });

  it("without a tier or baseUrl d402_get_bundle explains what is missing", async () => {
    const s = await seller();
    const m = await mcp();
    const r = await call(m.client, "d402_get_bundle", { taskUrl: s.taskUrl });
    expect(r.isError).toBe(true);
    expect(r.data.code).toBe("missing_tier");
  });
});

// ---------------------------------------------------------------------------

describe("D402_MODEL", () => {
  it("is recorded by the seller as the agent's model family after a passed submit", async () => {
    const s = await seller();
    const m = await mcp({ D402_MODEL: "gemini" });
    await earnManually(m, s);
    const status = await call(m.client, "d402_status");
    expect(s.d402.agents.get(status.data.publicKey)?.model).toBe("gemini");
  });
});

// ---------------------------------------------------------------------------

describe("persistence across processes", () => {
  it("a voucher earned in process 1 is listed and spent by process 2 with the same D402_HOME", async () => {
    const s = await seller();
    const home = makeHome();

    const p1 = await mcp({}, { home });
    const { submit } = await earnManually(p1, s);
    const key1 = (await call(p1.client, "d402_status")).data.publicKey as string;
    await p1.close();
    expect(await waitForExit(p1.pid, 3000)).toBe(true);
    expect(s.d402.tasks.stats().vouchers).toBe(1);

    const p2 = await mcp({}, { home });
    const status = await call(p2.client, "d402_status");
    expect(status.data.publicKey).toBe(key1);
    expect(status.data.vouchers).toHaveLength(1);
    expect(status.data.vouchers[0]).toMatchObject({ jti: submit.data.jti, calls: 10 });

    const r = await call(p2.client, "d402_fetch", { url: `${s.baseUrl}/search?q=persist` });
    expect(r.isError, r.text).toBe(false);
    expect(r.data.status).toBe(200);
    expect(r.data.headers[CALLS_REMAINING]).toBe("9");
    // Spent, not re-earned.
    expect(s.d402.tasks.stats().vouchers).toBe(1);
    expect(s.d402.agents.get(key1)?.bundles).toBe(1);
    expect((await call(p2.client, "d402_status")).data.vouchers[0].calls).toBe(9);
  });
});

// ---------------------------------------------------------------------------

describe("voucher exhaustion", () => {
  it("10 calls succeed, the 11th gets the offer, and autoEarn re-earns", async () => {
    const s = await seller();
    const home = makeHome();
    const truthPath = writeTruth(s.truth, home);
    const m = await mcp({ D402_SOLVER_CMD: solverCmd(truthPath, home) }, { home });
    const { submit } = await earnManually(m, s);
    const url = `${s.baseUrl}/search?q=x`;

    for (let i = 1; i <= 10; i++) {
      const r = await call(m.client, "d402_fetch", { url });
      expect(r.data.status, `call ${i}: ${r.text}`).toBe(200);
      expect(r.data.headers[CALLS_REMAINING]).toBe(String(10 - i));
    }
    expect(s.d402.vouchers.get(submit.data.jti)?.callsLeft).toBe(0);

    const eleventh = await call(m.client, "d402_fetch", { url, autoEarn: false });
    expect(eleventh.isError, eleventh.text).toBe(false);
    expect(eleventh.data.status).toBe(402);
    expect(eleventh.data.needsVoucher).toBe(true);
    expect(eleventh.data.offer.taskUrl).toBe(s.taskUrl);
    expect(s.d402.tasks.stats().vouchers).toBe(1);

    const twelfth = await call(m.client, "d402_fetch", { url, autoEarn: true });
    expect(twelfth.isError, twelfth.text).toBe(false);
    expect(twelfth.data.status).toBe(200);
    expect(twelfth.data.headers[CALLS_REMAINING]).toBe("9");
    expect(s.d402.tasks.stats().vouchers).toBe(2);

    const status = await call(m.client, "d402_status");
    const usable = status.data.vouchers.filter((v: { calls: number }) => v.calls > 0);
    expect(usable).toHaveLength(1);
    expect(usable[0].jti).not.toBe(submit.data.jti);
  });
});

// ---------------------------------------------------------------------------

describe("bound seller (bindVouchers: true)", () => {
  it("the manual flow works because the client signs every spend", async () => {
    const s = await seller({ bindVouchers: true });
    const m = await mcp();
    const { submit } = await earnManually(m, s);

    const r = await call(m.client, "d402_fetch", { url: `${s.baseUrl}/search?q=bound` });
    expect(r.isError, r.text).toBe(false);
    expect(r.data.status).toBe(200);
    expect(r.data.headers[CALLS_REMAINING]).toBe("9");
    const post = await call(m.client, "d402_fetch", { url: `${s.baseUrl}/search?q=bound`, method: "POST", body: "{}" });
    // POST is signed with its own method; the route only answers GET, but the gate accepted the spend.
    expect(post.data.headers[CALLS_REMAINING]).toBe("8");

    // Proof the seller really is bound: the bare token without a signature is refused.
    const stored = JSON.parse(readFileSync(join(m.home, "vouchers.json"), "utf8")) as { vouchers: { jti: string; token: string }[] };
    const token = stored.vouchers.find((v) => v.jti === submit.data.jti)!.token;
    const raw = await fetch(`${s.baseUrl}/search?q=bound`, { headers: { "D402-Voucher": token } });
    expect(raw.status).toBe(402);
    expect(await raw.json()).toMatchObject({ error: "bad_key" });
    expect(s.d402.vouchers.get(submit.data.jti)?.callsLeft).toBe(8);
  });
});

// ---------------------------------------------------------------------------

describe("stdio hygiene", () => {
  it("writes only JSON-RPC to stdout, logs to stderr, and exits cleanly when stdin closes", async () => {
    const home = makeHome();
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
    env.D402_HOME = home;
    const child = spawn("node", ["--import", "tsx", MCP_BIN_TS], { cwd: REPO_ROOT, env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (c: string) => (stdout += c));
    child.stderr.on("data", (c: string) => (stderr += c));
    const exited = new Promise<number | null>((resolve) => child.on("exit", (code) => resolve(code)));
    try {
      await runRawSession();
    } finally {
      if (child.exitCode === null) child.kill("SIGKILL");
      rmSync(home, { recursive: true, force: true });
    }

    async function runRawSession() {
    const waitForId = async (id: number) => {
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        for (const line of stdout.split("\n")) {
          if (!line.trim()) continue;
          try {
            const msg = JSON.parse(line);
            if (msg.id === id) return msg;
          } catch {
            /* checked below */
          }
        }
        await new Promise((r) => setTimeout(r, 20));
      }
      throw new Error(`no response with id ${id}; stdout so far: ${stdout}`);
    };
    const send = (msg: unknown) => child.stdin.write(JSON.stringify(msg) + "\n");

    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "raw", version: "0" } } });
    const init = await waitForId(1);
    expect(init.result.serverInfo.name).toBe("d402");
    send({ jsonrpc: "2.0", method: "notifications/initialized" });
    send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "d402_status", arguments: {} } });
    const list = await waitForId(2);
    expect(list.result.tools.map((t: { name: string }) => t.name).sort()).toEqual([...TOOL_NAMES].sort());
    const status = await waitForId(3);
    expect(JSON.parse(status.result.content[0].text).publicKey).toMatch(/^[A-Za-z0-9_-]{43,44}$/);

    const lines = stdout.split("\n").filter((l) => l.trim() !== "");
    expect(lines.length).toBeGreaterThanOrEqual(3);
    for (const line of lines) {
      const msg = JSON.parse(line);
      expect(msg.jsonrpc).toBe("2.0");
    }
    expect(stderr).toContain("d402-mcp: listening on stdio");

    const t0 = Date.now();
    child.stdin.end();
    const code = await Promise.race([exited, new Promise<"timeout">((r) => setTimeout(() => r("timeout"), 2000))]);
    const elapsed = Date.now() - t0;
    if (code === "timeout") child.kill("SIGKILL");
    expect(code, `process did not exit within 2s after stdin closed (${elapsed}ms)`).toBe(0);
    }
  });

  it("stays connected across 10 tool calls and the process is gone within 2s of close", async () => {
    const s = await seller();
    const m = await mcp();
    for (let i = 0; i < 10; i++) {
      const r = i % 2 === 0 ? await call(m.client, "d402_status") : await call(m.client, "d402_discover", { baseUrl: s.baseUrl });
      expect(r.isError, `call ${i}: ${r.text}`).toBe(false);
    }
    await expect(m.client.ping()).resolves.toBeDefined();
    expect(processAlive(m.pid)).toBe(true);
    expect(m.stderrText()).toContain("d402-mcp: listening on stdio");

    const t0 = Date.now();
    await m.close();
    const gone = await waitForExit(m.pid, 2000);
    const elapsed = Date.now() - t0;
    expect(gone).toBe(true);
    // The SDK only escalates to SIGTERM after a 2s grace period; a clean exit is faster than that.
    expect(elapsed).toBeLessThan(2000);
  });
});

// ---------------------------------------------------------------------------

describe("d402_fetch body truncation", () => {
  it("truncates a 100KB gated body to 64KB and flags it", async () => {
    const s = await seller();
    const m = await mcp();
    await earnManually(m, s);

    const big = await call(m.client, "d402_fetch", { url: `${s.baseUrl}/search?big=1` });
    expect(big.isError, big.text.slice(0, 200)).toBe(false);
    expect(big.data.status).toBe(200);
    expect(big.data.headers[CALLS_REMAINING]).toBe("9");
    expect(big.data.bodyBytes).toBe(100 * 1024);
    expect(big.data.truncated).toBe(true);
    expect((big.data.body as string).length).toBeLessThanOrEqual(65536);
    expect((big.data.body as string).length).toBe(65536);
    expect(big.data.body).toMatch(/^x+$/);

    const small = await call(m.client, "d402_fetch", { url: `${s.baseUrl}/search?q=small` });
    expect(small.data.truncated).toBe(false);
    expect(small.data.bodyBytes).toBe(Buffer.byteLength(small.data.body, "utf8"));
  });
});
