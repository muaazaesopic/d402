import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createD402, type D402Server } from "@d402/server";
import { isValidPublicKey, type Bundle, type D402Accept, type TaskFileItem, type Tier } from "@d402/spec";
import { USAGE, main, type CliIo } from "./cli.js";

// ---------------------------------------------------------------------------
// A real seller behind app.request
// ---------------------------------------------------------------------------

const ORIGIN = "http://seller.test";
const LABELS = ["a", "b", "c"];
const TIERS: Tier[] = [
  { id: "s", items: 5, est_tokens: 500, reward: { calls: 10 } },
  { id: "m", items: 8, est_tokens: 800, reward: { calls: 20 } },
];
const T0 = 1_760_000_000;

function items(): TaskFileItem[] {
  const out: TaskFileItem[] = [];
  for (let i = 1; i <= 10; i++) out.push({ id: `g${i}`, type: "classify", text: `golden ${i}`, golden: LABELS[i % 3]! });
  for (let i = 1; i <= 30; i++) out.push({ id: `u${i}`, type: "classify", text: `unknown ${i}` });
  return out;
}

/** The full answer key: goldens by their label, unknowns "a". */
function answerKey(): Record<string, string> {
  const key: Record<string, string> = {};
  for (const it of items()) key[it.id] = it.golden ?? "a";
  return key;
}

interface Seller {
  app: D402Server["routes"];
  d402: D402Server;
  fetch: typeof fetch;
}

function seller(): Seller {
  const d402 = createD402({
    sellerId: "seller.test",
    taskUrl: `${ORIGIN}/.well-known/d402/tasks`,
    scope: ["/search"],
    tiers: TIERS,
    secret: "cli-test-secret",
    labels: LABELS,
    now: () => T0,
    bundlesPerKeyPerHour: 10_000,
    bundlesPerIpPerHour: 10_000,
    maxOpenBundlesPerKey: 10_000,
  });
  d402.tasks.load(items());
  // hono is not a dependency of this package, so the seller's own router doubles as the app.
  const app = d402.routes;
  app.use("/search", d402.gate);
  app.get("/search", (c) => c.json({ hits: [c.req.query("q")] }));
  app.post("/search", async (c) => c.json({ posted: await c.req.json(), echo: c.req.header("x-demo") ?? null }));
  app.get("/plain", (c) => c.text("not d402"));
  const fetchViaApp: typeof fetch = (input, init) => app.request(input as string | Request, init);
  return { app, d402, fetch: fetchViaApp };
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

class Sink {
  text = "";
  write(chunk: string) {
    this.text += chunk;
    return true;
  }
}

let home: string;
let s: Seller;
const dirs: string[] = [];

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "d402-cli-"));
  dirs.push(home);
  s = seller();
});
afterEach(() => {
  s.d402.close();
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

async function run(argv: string[], over: Partial<CliIo> = {}) {
  const stdout = new Sink();
  const stderr = new Sink();
  const code = await main(argv, {
    stdout,
    stderr,
    env: { D402_HOME: home, ...(over.env ?? {}) },
    fetch: s.fetch,
    now: () => T0,
    ...over,
  });
  return { code, stdout: stdout.text, stderr: stderr.text, json: () => JSON.parse(stdout.text) as any };
}

function writeJson(name: string, value: unknown): string {
  const p = join(home, name);
  writeFileSync(p, JSON.stringify(value));
  return p;
}

const pendingIds = () => (existsSync(join(home, "pending")) ? readdirSync(join(home, "pending")).map((f) => f.replace(/\.json$/, "")) : []);

/** A node script usable as --solver-cmd; receives the bundle on stdin. */
function solverScript(body: string): string {
  const p = join(home, "solver.cjs");
  writeFileSync(p, `let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const b=JSON.parse(d);${body}});`);
  return `node ${JSON.stringify(p)}`;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("d402 cli: usage", () => {
  it("prints usage and exits 2 with no command", async () => {
    const r = await run([]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("usage: d402");
    expect(r.stdout).toBe("");
  });

  it("prints usage on stdout and exits 0 for --help", async () => {
    const r = await run(["--help"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toBe(USAGE + "\n");
  });

  it("exits 2 for an unknown command, an unknown option and a missing argument", async () => {
    expect((await run(["frobnicate"])).code).toBe(2);
    expect((await run(["discover", "--bogus"])).code).toBe(2);
    const r = await run(["discover"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/^error: discover needs <baseUrl>/);
  });
});

describe("d402 cli: keygen and status", () => {
  it("keygen writes $D402_HOME/keypair.json and prints the public key; a second run reuses it", async () => {
    const r1 = await run(["keygen"]);
    expect(r1.code).toBe(0);
    const pub = r1.stdout.trim();
    expect(isValidPublicKey(pub)).toBe(true);
    const file = JSON.parse(readFileSync(join(home, "keypair.json"), "utf8"));
    expect(file.publicKey).toBe(pub);
    expect(r1.stderr).toContain("wrote keypair");

    const r2 = await run(["keygen"]);
    expect(r2.code).toBe(0);
    expect(r2.stdout.trim()).toBe(pub);
    expect(r2.stderr).toContain("already exists");
  });

  it("status reports no key and no vouchers on a fresh home", async () => {
    const r = await run(["status"]);
    expect(r.code).toBe(0);
    expect(r.json()).toEqual({ home, publicKey: null, vouchers: [], pending: [] });
  });

  it("honours --home over D402_HOME", async () => {
    const other = mkdtempSync(join(tmpdir(), "d402-cli-other-"));
    dirs.push(other);
    const r = await run(["keygen", "--home", other]);
    expect(r.code).toBe(0);
    expect(existsSync(join(other, "keypair.json"))).toBe(true);
    expect(existsSync(join(home, "keypair.json"))).toBe(false);
  });
});

describe("d402 cli: discover and bundle", () => {
  it("discover prints the d402 accept as JSON", async () => {
    const r = await run(["discover", ORIGIN]);
    expect(r.code).toBe(0);
    const accept = r.json() as D402Accept;
    expect(accept).toMatchObject({ scheme: "d402", sellerId: "seller.test", taskUrl: `${ORIGIN}/.well-known/d402/tasks` });
    expect(accept.tiers.map((t) => t.id)).toEqual(["s", "m"]);
  });

  it("discover exits 1 with error: bad_offer when the origin is not a d402 seller", async () => {
    // app.request ignores the host, so point at a path with no offer under it
    const r = await run(["discover", `${ORIGIN}/plain`]);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/^error: bad_offer /);
    expect(r.stdout).toBe("");
  });

  it("bundle prints the bundle and stores it under pending/<bundleId>.json", async () => {
    const r = await run(["bundle", ORIGIN, "--tier", "m"]);
    expect(r.code).toBe(0);
    const bundle = r.json() as Bundle;
    expect(bundle.tier).toBe("m");
    expect(bundle.items).toHaveLength(8);
    expect(pendingIds()).toEqual([bundle.bundleId]);
    const saved = JSON.parse(readFileSync(join(home, "pending", `${bundle.bundleId}.json`), "utf8"));
    expect(saved.bundle).toEqual(bundle);
    expect(saved.taskUrl).toBe(`${ORIGIN}/.well-known/d402/tasks`);
    expect(saved.accept.sellerId).toBe("seller.test");
    // the keypair was created on demand
    expect(existsSync(join(home, "keypair.json"))).toBe(true);
    expect(s.d402.agents.list()).toHaveLength(1);
  });

  it("bundle defaults to the smallest tier, then D402_TIER, then --tier", async () => {
    expect((await run(["bundle", ORIGIN])).json().tier).toBe("s");
    expect((await run(["bundle", ORIGIN], { env: { D402_HOME: home, D402_TIER: "m" } })).json().tier).toBe("m");
    expect((await run(["bundle", ORIGIN, "--tier=s"], { env: { D402_HOME: home, D402_TIER: "m" } })).json().tier).toBe("s");
  });

  it("bundle exits 1 with error: bad_tier for an unknown tier", async () => {
    const r = await run(["bundle", ORIGIN, "--tier", "xl"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/^error: bad_tier /);
    expect(pendingIds()).toEqual([]);
  });

  it("sends D402_MODEL as the model family", async () => {
    await run(["bundle", ORIGIN], { env: { D402_HOME: home, D402_MODEL: "claude" } });
    expect(s.d402.agents.list()[0]!.model).toBe("claude");
  });
});

describe("d402 cli: submit (pending-bundle flow)", () => {
  it("submits a pending bundle with --answers, prints the voucher summary and clears the pending file", async () => {
    const bundle = (await run(["bundle", ORIGIN])).json() as Bundle;
    const key = answerKey();
    const answers = Object.fromEntries(bundle.items.map((it) => [it.id, key[it.id]!]));
    const r = await run(["submit", bundle.bundleId, "--answers", writeJson("answers.json", answers)]);
    expect(r.code).toBe(0, r.stderr);
    const v = r.json();
    expect(v).toMatchObject({ sellerId: "seller.test", calls: 10, scope: ["/search"] });
    expect(s.d402.vouchers.get(v.jti)?.callsLeft).toBe(10);
    expect(pendingIds()).toEqual([]);

    const st = (await run(["status"])).json();
    expect(st.publicKey).toBe(s.d402.agents.list()[0]!.publicKey);
    expect(st.vouchers).toHaveLength(1);
    expect(st.vouchers[0]).toMatchObject({ jti: v.jti, calls: 10, expired: false });
  });

  it("accepts a full answer key (extra ids are ignored)", async () => {
    const bundle = (await run(["bundle", ORIGIN])).json() as Bundle;
    const r = await run(["submit", bundle.bundleId, "--answers", writeJson("key.json", answerKey())]);
    expect(r.code).toBe(0, r.stderr);
  });

  it("exits 1 with solver_missing_answer when an item id is missing, keeping the pending file", async () => {
    const bundle = (await run(["bundle", ORIGIN])).json() as Bundle;
    const key = answerKey();
    const partial = Object.fromEntries(bundle.items.slice(1).map((it) => [it.id, key[it.id]!]));
    const r = await run(["submit", bundle.bundleId, "--answers", writeJson("partial.json", partial)]);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/^error: solver_missing_answer .*no answer for item/);
    expect(pendingIds()).toEqual([bundle.bundleId]);
    expect(s.d402.agents.list()[0]!.bundles).toBe(0);
  });

  it("exits 1 with quality on wrong answers and 1 with already_submitted on a replay", async () => {
    const bundle = (await run(["bundle", ORIGIN])).json() as Bundle;
    const wrong = Object.fromEntries(bundle.items.map((it) => [it.id, LABELS[(LABELS.indexOf(answerKey()[it.id]!) + 1) % 3]!]));
    const r = await run(["submit", bundle.bundleId, "--answers", writeJson("wrong.json", wrong)]);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/^error: quality /);
    // the server has consumed the bundle; the file is kept, a retry says so
    const again = await run(["submit", bundle.bundleId, "--answers", writeJson("wrong.json", wrong)]);
    expect(again.code).toBe(1);
    expect(again.stderr).toMatch(/^error: already_submitted /);
  });

  it("exits 1 with unknown_bundle for an id that is not pending, and 2 without --answers", async () => {
    const r = await run(["submit", "b_nope", "--answers", writeJson("a.json", {})]);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/^error: unknown_bundle /);
    expect((await run(["submit", "b_nope"])).code).toBe(2);
  });

  it("exits 1 with bad_file for an unreadable or malformed answers file", async () => {
    const bundle = (await run(["bundle", ORIGIN])).json() as Bundle;
    const r = await run(["submit", bundle.bundleId, "--answers", join(home, "missing.json")]);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/^error: bad_file /);
    const r2 = await run(["submit", bundle.bundleId, "--answers", writeJson("list.json", [1, 2])]);
    expect(r2.code).toBe(1);
    expect(r2.stderr).toMatch(/^error: bad_file /);
  });
});

describe("d402 cli: earn", () => {
  it("earn --answers does bundle -> solve -> submit and prints the voucher", async () => {
    const r = await run(["earn", ORIGIN, "--tier", "m", "--answers", writeJson("key.json", answerKey())]);
    expect(r.code).toBe(0, r.stderr);
    expect(r.json()).toMatchObject({ sellerId: "seller.test", calls: 20, scope: ["/search"] });
    expect(pendingIds()).toEqual([]);
    expect((await run(["status"])).json().vouchers).toHaveLength(1);
  });

  it("earn --solver-cmd pipes the bundle to the command and reads answers from stdout", async () => {
    const keyPath = writeJson("key.json", answerKey());
    const cmd = solverScript(
      `const key=JSON.parse(require("fs").readFileSync(${JSON.stringify(keyPath)},"utf8"));` +
        `const a={};for(const i of b.items)a[i.id]=key[i.id];console.log(JSON.stringify({answers:a}));`,
    );
    const r = await run(["earn", ORIGIN, "--solver-cmd", cmd]);
    expect(r.code).toBe(0, r.stderr);
    expect(r.json()).toMatchObject({ calls: 10 });
  });

  it("earn --solver-cmd exits 1 when the command fails or prints garbage", async () => {
    const r = await run(["earn", ORIGIN, "--solver-cmd", solverScript("process.exit(3)")]);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/^error: solver_failed .*exited with code 3/);
    const r2 = await run(["earn", ORIGIN, "--solver-cmd", solverScript('console.log("nope")')]);
    expect(r2.code).toBe(1);
    expect(r2.stderr).toMatch(/^error: solver_bad_output /);
    const r3 = await run(["earn", ORIGIN, "--solver-cmd", solverScript('console.log("{}")')]);
    expect(r3.code).toBe(1);
    expect(r3.stderr).toMatch(/^error: solver_missing_answer /);
  });

  it("earn exits 1 with earn_failed after repeated quality failures", async () => {
    const wrong = Object.fromEntries(Object.entries(answerKey()).map(([id, l]) => [id, LABELS[(LABELS.indexOf(l) + 1) % 3]!]));
    const r = await run(["earn", ORIGIN, "--answers", writeJson("wrong.json", wrong)]);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/^error: earn_failed /);
    expect(s.d402.agents.list()[0]!.bundles).toBe(3);
  });

  it("earn exits 2 without a solver flag or with both", async () => {
    expect((await run(["earn", ORIGIN])).code).toBe(2);
    expect((await run(["earn", ORIGIN, "--answers", "a.json", "--solver-cmd", "x"])).code).toBe(2);
  });
});

describe("d402 cli: fetch", () => {
  it("prints the 402 when there is no voucher and no --auto-earn", async () => {
    const r = await run(["fetch", `${ORIGIN}/search?q=x`]);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/^HTTP 402/);
    expect(r.stdout).toContain("content-type: application/json");
    expect(JSON.parse(r.stdout.slice(r.stdout.indexOf("\n\n") + 2))).toMatchObject({ d402: "1", error: "missing_voucher" });
    expect(r.stderr).toContain("no cached voucher");
  });

  it("spends a cached voucher with signed headers and tracks calls remaining", async () => {
    expect((await run(["earn", ORIGIN, "--answers", writeJson("key.json", answerKey())])).code).toBe(0);
    const r = await run(["fetch", `${ORIGIN}/search?q=hello`]);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/^HTTP 200/);
    expect(r.stdout).toContain("d402-calls-remaining: 9");
    expect(r.stdout.trimEnd().endsWith('{"hits":["hello"]}')).toBe(true);
    expect(r.stderr).toBe("");
    const st = (await run(["status"])).json();
    expect(st.vouchers[0].calls).toBe(9);
    const r2 = await run(["fetch", `${ORIGIN}/search?q=again`]);
    expect(r2.stdout).toContain("d402-calls-remaining: 8");
  });

  it("--auto-earn earns a voucher on 402 and retries", async () => {
    const r = await run(["fetch", `${ORIGIN}/search?q=auto`, "--auto-earn", "--answers", writeJson("key.json", answerKey())]);
    expect(r.code).toBe(0, r.stderr);
    expect(r.stdout).toMatch(/^HTTP 200/);
    expect(r.stdout).toContain("d402-calls-remaining: 9");
    expect((await run(["status"])).json().vouchers).toHaveLength(1);
    // the next call reuses the cached voucher instead of earning again
    const r2 = await run(["fetch", `${ORIGIN}/search?q=auto2`, "--auto-earn", "--answers", writeJson("key.json", answerKey())]);
    expect(r2.stdout).toContain("d402-calls-remaining: 8");
    expect(s.d402.agents.list()[0]!.bundles).toBe(1);
  });

  it("--auto-earn with --solver-cmd and a POST body and headers", async () => {
    const keyPath = writeJson("key.json", answerKey());
    const cmd = solverScript(
      `const key=JSON.parse(require("fs").readFileSync(${JSON.stringify(keyPath)},"utf8"));` +
        `const a={};for(const i of b.items)a[i.id]=key[i.id];console.log(JSON.stringify(a));`,
    );
    const r = await run([
      "fetch", `${ORIGIN}/search`, "-X", "POST", "-d", '{"n":1}', "-H", "X-Demo: yes", "--auto-earn", "--solver-cmd", cmd,
    ]);
    expect(r.code).toBe(0, r.stderr);
    expect(r.stdout).toMatch(/^HTTP 200/);
    const body = JSON.parse(r.stdout.slice(r.stdout.indexOf("\n\n") + 2));
    expect(body).toEqual({ posted: { n: 1 }, echo: "yes" });
  });

  it("exits 2 for a relative url, a bad -H and solver flags without --auto-earn", async () => {
    expect((await run(["fetch", "/search"])).code).toBe(2);
    expect((await run(["fetch", `${ORIGIN}/search`, "-H", "nocolon"])).code).toBe(2);
    expect((await run(["fetch", `${ORIGIN}/search`, "--answers", "k.json"])).code).toBe(2);
  });

  it("fetches a route that is not d402-gated as a plain request", async () => {
    const r = await run(["fetch", `${ORIGIN}/plain`]);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/^HTTP 200/);
    expect(r.stdout.trimEnd().endsWith("not d402")).toBe(true);
  });
});

describe("d402 cli: real bin", () => {
  it("node --import tsx src/cli.ts keygen writes a keypair into a temp D402_HOME", () => {
    const pkg = join(dirname(fileURLToPath(import.meta.url)), "..");
    const res = spawnSync(process.execPath, ["--import", "tsx", "src/cli.ts", "keygen"], {
      cwd: pkg,
      env: { ...process.env, D402_HOME: home },
      encoding: "utf8",
    });
    expect(res.status, res.stderr).toBe(0);
    const pub = res.stdout.trim();
    expect(isValidPublicKey(pub)).toBe(true);
    expect(JSON.parse(readFileSync(join(home, "keypair.json"), "utf8")).publicKey).toBe(pub);
    expect(res.stderr).toContain("wrote keypair");

    const usage = spawnSync(process.execPath, ["--import", "tsx", "src/cli.ts"], { cwd: pkg, env: { ...process.env, D402_HOME: home }, encoding: "utf8" });
    expect(usage.status).toBe(2);
    expect(usage.stderr).toContain("usage: d402");
  });
});
