/**
 * Persistence: a seller db on disk across restarts, the file-backed voucher
 * cache across client instances, and the d402-tasks CLI against a db file.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HEADERS, findD402Accept, generateKeypair, type TaskFileItem } from "@d402/spec";
import { FileVoucherCache } from "@d402/client";
import { LABELS, newAgent, perfectSolver, rawSpend, startSeller, type Pool, type Seller } from "./helpers.js";

const sellers: Seller[] = [];
const dirs: string[] = [];
async function seller(over: Parameters<typeof startSeller>[0] = {}): Promise<Seller> {
  const s = await startSeller(over);
  sellers.push(s);
  return s;
}
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "d402-e2e-"));
  dirs.push(d);
  return d;
}
afterEach(async () => {
  while (sellers.length) await sellers.pop()!.close();
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

const ROOT = join(import.meta.dirname, "..", "..");
const CLI = join(ROOT, "packages", "server", "src", "cli.ts");
function cli(...args: string[]) {
  const r = spawnSync(process.execPath, ["--import", "tsx", CLI, ...args], { cwd: ROOT, encoding: "utf8" });
  return { status: r.status, out: r.stdout, err: r.stderr };
}

describe("seller db on disk", () => {
  it("a voucher earned before close() still spends after re-creating the seller on the same db and secret", async () => {
    const db = join(tmp(), "seller.db");
    const first = await seller({ db });
    const agent = newAgent(first.baseUrl, { solver: perfectSolver(first.truth) });
    const accept = findD402Accept(await agent.discover(first.baseUrl))!;
    const v = await agent.earn(accept, "m");
    expect((await agent.fetch(`${first.baseUrl}/search?q=x`)).headers.get(HEADERS.callsRemaining)).toBe("59");
    const statsBefore = first.d402.tasks.stats();
    const agentBefore = first.d402.agents.get(agent.keypair.publicKey)!;
    await sellers.pop()!.close();

    const second = await seller({ db, pool: { items: [], truth: new Map(), goldenIds: new Set() } });
    expect(second.d402.vouchers.get(v.jti)).toMatchObject({ callsLeft: 59, sub: agent.keypair.publicKey });
    expect(second.d402.agents.get(agent.keypair.publicKey)).toEqual(agentBefore);
    expect(second.d402.tasks.stats()).toEqual({ ...statsBefore, openBundles: 0 });
    expect(second.d402.tasks.stats().total).toBe(400);

    const res = await rawSpend(second, v.token);
    expect(res.status).toBe(200);
    expect(res.headers.get(HEADERS.callsRemaining)).toBe("58");

    // the client keeps using its cached voucher against the restarted seller
    // (it is on a new port, i.e. a new origin, so discover() first so the
    // client knows which sellerId that origin maps to)
    await agent.discover(second.baseUrl);
    const viaClient = await agent.fetch(`${second.baseUrl}/search?q=y`);
    expect(viaClient.status).toBe(200);
    expect(viaClient.headers.get(HEADERS.callsRemaining)).toBe("57");
    expect(second.d402.agents.get(agent.keypair.publicKey)!.bundles).toBe(1);
  });

  it("the same db with a different secret rejects the old voucher as voucher_invalid", async () => {
    const db = join(tmp(), "seller.db");
    const first = await seller({ db });
    const agent = newAgent(first.baseUrl, { solver: perfectSolver(first.truth) });
    const v = await agent.earn(findD402Accept(await agent.discover(first.baseUrl))!);
    await sellers.pop()!.close();

    const second = await seller({ db, secret: "rotated", pool: { items: [], truth: new Map(), goldenIds: new Set() } });
    // the row is still there, but the HMAC no longer verifies
    expect(second.d402.vouchers.get(v.jti)?.callsLeft).toBe(10);
    const res = await rawSpend(second, v.token);
    expect(res.status).toBe(402);
    expect(res.body.error).toBe("voucher_invalid");
    expect(second.d402.vouchers.get(v.jti)?.callsLeft).toBe(10);
  });

  it("items loaded into a db are not duplicated when the seller restarts and loads again", async () => {
    const db = join(tmp(), "seller.db");
    const first = await seller({ db });
    expect(first.d402.tasks.stats().total).toBe(400);
    await sellers.pop()!.close();
    const second = await seller({ db });
    expect(second.d402.tasks.stats().total).toBe(400);
    expect(second.d402.tasks.load(second.pool.items)).toBe(0);
  });

  it("trust state survives a restart: a blocked key stays blocked", async () => {
    const db = join(tmp(), "seller.db");
    const first = await seller({ db });
    const kp = generateKeypair();
    const wrong = newAgent(first.baseUrl, {
      solver: async (b) => Object.fromEntries(b.items.map((i) => [i.id, LABELS.find((l) => l !== first.truth.get(i.id))!])),
      keypair: kp,
      maxEarnAttempts: 5,
    });
    await wrong.earn(findD402Accept(await wrong.discover(first.baseUrl))!).catch(() => undefined);
    expect(first.d402.agents.get(kp.publicKey)?.blocked).toBe(true);
    await sellers.pop()!.close();

    const second = await seller({ db, pool: { items: [], truth: new Map(), goldenIds: new Set() } });
    expect(second.d402.agents.get(kp.publicKey)).toMatchObject({ bundles: 5, blocked: true });
    const fresh = newAgent(second.baseUrl, { solver: perfectSolver(first.truth), keypair: kp });
    await expect(fresh.earn(findD402Accept(await fresh.discover(second.baseUrl))!)).rejects.toMatchObject({ code: "blocked", status: 403 });
  });
});

describe("FileVoucherCache", () => {
  it("a second client with the same keypair and cache dir spends the cached voucher without a solver", async () => {
    const s = await seller();
    const dir = tmp();
    const kp = generateKeypair();
    const a = newAgent(s.baseUrl, { solver: perfectSolver(s.truth), keypair: kp, cache: new FileVoucherCache(dir) });
    const first = await a.fetch(`${s.baseUrl}/search?q=a`);
    expect(first.status).toBe(200);
    const onDisk = JSON.parse(readFileSync(join(dir, "vouchers.json"), "utf8")) as { version: number; vouchers: Array<{ jti: string; calls: number }> };
    expect(onDisk.version).toBe(1);
    expect(onDisk.vouchers).toHaveLength(1);
    expect(onDisk.vouchers[0]!.calls).toBe(9);

    // no solver: any earn would throw no_solver, so a 200 proves the cached voucher was used
    const b = newAgent(s.baseUrl, { keypair: kp, cache: new FileVoucherCache(dir) });
    expect((await b.status()).map((v) => v.jti)).toEqual([onDisk.vouchers[0]!.jti]);
    await b.discover(s.baseUrl);
    const res = await b.fetch(`${s.baseUrl}/search?q=b`);
    expect(res.status).toBe(200);
    expect(res.headers.get(HEADERS.callsRemaining)).toBe("8");
    expect(s.d402.agents.get(kp.publicKey)!.bundles).toBe(1);
    expect(s.d402.tasks.stats().vouchers).toBe(1);

    // and client A sees the decrement B caused, through the shared file
    expect((await a.status())[0]!.calls).toBe(8);
  });

  it("without discover() a solver-less client cannot know the seller and fails with no_solver", async () => {
    const s = await seller();
    const dir = tmp();
    const kp = generateKeypair();
    const a = newAgent(s.baseUrl, { solver: perfectSolver(s.truth), keypair: kp, cache: new FileVoucherCache(dir) });
    await a.fetch(`${s.baseUrl}/search?q=a`);
    const b = newAgent(s.baseUrl, { keypair: kp, cache: new FileVoucherCache(dir) });
    // NOTE: the client only consults the cache for origins it has seen (via
    // discover() or an earlier 402), so the first request goes out bare, gets
    // a 402, and the client tries to earn. The cached voucher is not used.
    await expect(b.fetch(`${s.baseUrl}/search?q=b`)).rejects.toMatchObject({ code: "no_solver" });
  });

  it("a voucher the seller reports as expired is removed from the file", async () => {
    const s = await seller();
    const dir = tmp();
    const cache = new FileVoucherCache(dir);
    const a = newAgent(s.baseUrl, { solver: perfectSolver(s.truth), cache });
    await a.fetch(`${s.baseUrl}/search?q=a`);
    const jti = (await cache.list())[0]!.jti;
    s.clock.t += 86_401;
    const res = await a.fetch(`${s.baseUrl}/search?q=b`);
    expect(res.status).toBe(200);
    const left = await cache.list();
    expect(left).toHaveLength(1);
    expect(left[0]!.jti).not.toBe(jti);
  });
});

describe("d402-tasks CLI", () => {
  function writeTasks(dir: string): { file: string; pool: Pool } {
    const items: TaskFileItem[] = [];
    const truth = new Map<string, (typeof LABELS)[number]>();
    const goldenIds = new Set<string>();
    for (let i = 0; i < 10; i++) {
      const label = LABELS[i % 4]!;
      items.push({ id: `g${i}`, type: "classify", text: `golden ${i}`, golden: label });
      truth.set(`g${i}`, label);
      goldenIds.add(`g${i}`);
    }
    for (let i = 0; i < 3; i++) {
      const label = LABELS[(i + 1) % 4]!;
      items.push({ id: `u${i}`, text: `unknown ${i}` } as TaskFileItem); // type defaults to classify
      truth.set(`u${i}`, label);
    }
    const file = join(dir, "tasks.jsonl");
    writeFileSync(file, items.map((i) => JSON.stringify(i)).join("\n") + "\n\n");
    return { file, pool: { items, truth, goldenIds } };
  }

  it("load then stats: parses the JSONL, ignores duplicates, reports the pool", () => {
    const dir = tmp();
    const db = join(dir, "cli.db");
    const { file } = writeTasks(dir);
    const load = cli("load", db, file);
    expect(load.status, load.err).toBe(0);
    expect(load.out).toMatch(/loaded 13 item\(s\)/);
    expect(cli("load", db, file).out).toMatch(/loaded 0 item/);
    const stats = cli("stats", db);
    expect(stats.status).toBe(0);
    expect(JSON.parse(stats.out)).toMatchObject({
      total: 13,
      golden: 10,
      unknownOpen: 3,
      resolved: 0,
      retiredGolden: 0,
      agents: 0,
      vouchers: 0,
    });
    expect(cli("export", db).out).toBe("");
  });

  it("a malformed task file fails with exit code 1 and a line number", () => {
    const dir = tmp();
    const db = join(dir, "cli.db");
    const file = join(dir, "bad.jsonl");
    writeFileSync(file, '{"id":"ok","text":"fine"}\n{"id":"","text":"empty id"}\n');
    const r = cli("load", db, file);
    expect(r.status).toBe(1);
    expect(r.err).toMatch(/line 2/);
    expect(JSON.parse(cli("stats", db).out).total).toBe(0);
  });

  it("usage errors exit 2", () => {
    expect(cli().status).toBe(2);
    expect(cli("bogus", join(tmp(), "x.db")).status).toBe(2);
    expect(cli("load", join(tmp(), "x.db")).status).toBe(2);
  });

  it("a seller on the CLI-loaded db resolves items that the CLI then exports", async () => {
    const dir = tmp();
    const db = join(dir, "cli.db");
    const { file, pool } = writeTasks(dir);
    expect(cli("load", db, file).status).toBe(0);

    const s = await seller({
      db,
      pool: { items: [], truth: pool.truth, goldenIds: pool.goldenIds },
      tiers: [
        { id: "one", items: 1, est_tokens: 100, reward: { calls: 1 } },
        { id: "s", items: 5, est_tokens: 1000, reward: { calls: 10 } },
      ],
    });
    expect(s.d402.tasks.stats()).toMatchObject({ total: 13, unknownOpen: 3 });

    // Each agent warms up on two single-golden bundles (accuracy 3/4) so that
    // three agreeing votes weigh 2.25 >= 2.0, then labels the three unknowns.
    for (const model of ["claude", "gpt", "gemini"]) {
      const agent = newAgent(s.baseUrl, { solver: perfectSolver(pool.truth), model });
      const accept = findD402Accept(await agent.discover(s.baseUrl))!;
      await agent.earn(accept, "one");
      await agent.earn(accept, "one");
      const v = await agent.earn(accept, "s");
      expect(v.calls).toBe(10);
    }
    expect(s.d402.tasks.stats()).toMatchObject({ resolved: 3, unknownOpen: 0, agents: 3, vouchers: 9 });
    const inProcess = s.d402.tasks.exportResolved();
    await sellers.pop()!.close();

    const stats = cli("stats", db);
    expect(JSON.parse(stats.out)).toMatchObject({ resolved: 3, unknownOpen: 0, agents: 3, vouchers: 9 });
    const exp = cli("export", db);
    expect(exp.status).toBe(0);
    const lines = exp.out.trim().split("\n").map((l) => JSON.parse(l) as { id: string; text: string; answer: string; weight: number; voters: number });
    expect(lines).toHaveLength(3);
    expect(lines).toEqual(inProcess);
    for (const line of lines) {
      expect(line.answer).toBe(pool.truth.get(line.id));
      expect(line.voters).toBe(3);
      expect(line.weight).toBeCloseTo(2.25);
      expect(line.text).toBe(`unknown ${line.id.slice(1)}`);
    }
  });
});
