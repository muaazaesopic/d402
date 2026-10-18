import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Bundle } from "@d402/spec";
import { DEMO_TASKS, search } from "./corpus.js";
import { HelpRequested, parseArgs, parseTier, USAGE } from "./cli.js";

const pkgDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const truth: Record<string, string> = { g1: "a", g2: "b", g3: "c", g4: "d" };

let tmp: string;
let tasksPath: string;
let toolsPath: string;

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), "d402-mcp-seller-"));
  tasksPath = join(tmp, "tasks.jsonl");
  writeFileSync(
    tasksPath,
    Object.entries(truth)
      .map(([id, golden]) => JSON.stringify({ id, type: "classify", text: `item ${id}`, golden }))
      .join("\n") + "\n",
  );
  toolsPath = join(tmp, "my-tools.mjs");
  writeFileSync(
    toolsPath,
    `import { createRequire } from "node:module";
const { z } = createRequire(${JSON.stringify(join(pkgDir, "package.json"))})("zod");
export function register(gated, { d402 }) {
  gated("echo", { description: "echoes", inputSchema: { msg: z.string() }, scope: "/mcp/echo" }, async ({ msg }) => ({
    content: [{ type: "text", text: msg }],
    structuredContent: { msg, sellerId: d402.offer().accepts[0].sellerId },
  }));
}
`,
  );
});

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function answersFor(bundle: Pick<Bundle, "items">): Record<string, string> {
  const out: Record<string, string> = {};
  for (const it of bundle.items) out[it.id] = truth[it.id]!;
  return out;
}

interface Running {
  child: ChildProcess;
  port: number;
  stderr: () => string;
}

function start(args: string[], env: Record<string, string> = {}): Promise<Running> {
  const child = spawn(process.execPath, ["--import", "tsx", "src/cli.ts", ...args], {
    cwd: pkgDir,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`CLI did not start:\n${stderr}`)), 25_000);
    child.stderr!.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
      const m = /listening on http:\/\/localhost:(\d+)/.exec(stderr);
      if (m) {
        clearTimeout(timer);
        resolve({ child, port: Number(m[1]), stderr: () => stderr });
      }
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`CLI exited with ${code}:\n${stderr}`));
    });
  });
}

async function connect(port: number) {
  const client = new Client({ name: "cli-test-client", version: "0.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`));
  await client.connect(transport);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const res = await client.callTool({ name, arguments: args });
    return { isError: res.isError === true, structured: (res.structuredContent ?? {}) as Record<string, any> };
  };
  return { client, call };
}

async function stop(r: Running): Promise<number | null> {
  const exited = new Promise<number | null>((resolve) => r.child.once("exit", (code) => resolve(code)));
  r.child.kill("SIGTERM");
  return exited;
}

describe("d402-mcp-seller CLI", () => {
  let running: Running | undefined;
  afterEach(async () => {
    if (running) {
      running.child.kill("SIGKILL");
      running = undefined;
    }
  });

  it("boots, lists search plus the four d402 tools, runs the flow over Streamable HTTP, and exits 0 on SIGTERM", async () => {
    running = await start([
      "--tasks", tasksPath,
      "--tier", "s:2:100:3",
      "--scope", "/search,/mcp/search",
      "--secret", "cli-secret",
      "--seller-id", "cli.example.test",
      "--public-url", "https://cli.example.test",
      "--port", "0",
    ]);
    expect(running.port).toBeGreaterThan(0);
    const err = running.stderr();
    expect(err).toContain("pool:     4 items (4 golden)");
    expect(err).toContain('derived ["a","b","c","d"]');
    expect(err).toContain("tools:    d402_offer, d402_get_bundle, d402_submit, d402_status, search");

    const offer = await fetch(`http://127.0.0.1:${running.port}/.well-known/d402`);
    expect(offer.status).toBe(200);
    const body = (await offer.json()) as { accepts: { sellerId: string; taskUrl: string; scope: string[] }[] };
    expect(body.accepts[0]!.sellerId).toBe("cli.example.test");
    expect(body.accepts[0]!.taskUrl).toBe("https://cli.example.test/.well-known/d402/tasks");
    expect(body.accepts[0]!.scope).toEqual(["/search", "/mcp/search"]);

    const c = await connect(running.port);
    const { tools } = await c.client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(["d402_get_bundle", "d402_offer", "d402_status", "d402_submit", "search"]);

    const unpaid = await c.call("search", { q: "marathon" });
    expect(unpaid.structured.paymentRequired).toBe(true);

    const b = await c.call("d402_get_bundle");
    expect(b.isError).toBe(false);
    const sub = await c.call("d402_submit", { bundleId: b.structured.bundleId, answers: answersFor(b.structured as Bundle) });
    expect(sub.isError).toBe(false);
    expect(sub.structured.calls).toBe(3);

    const hits = await c.call("search", { q: "marathon record", d402_voucher: sub.structured.voucher, limit: 2 });
    expect(hits.isError).toBe(false);
    expect(hits.structured.hits[0].id).toBe("sports/marathon-record");
    expect(hits.structured.d402_calls_remaining).toBe(2);
    await c.client.close();

    const code = await stop(running);
    running = undefined;
    expect(code).toBe(0);
  });

  it("--tools-module adds the seller's own gated tools; --no-search drops the demo; no --tasks loads the demo pool", async () => {
    running = await start(["--tools-module", toolsPath, "--no-search", "--port", "0", "--tier", "s:2:100:2"], { D402_SECRET: "env-secret" });
    expect(running.stderr()).toContain("loaded the built-in demo pool (20 items, 10 golden)");
    expect(running.stderr()).not.toContain("generated a random one");
    const c = await connect(running.port);
    const { tools } = await c.client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(["d402_get_bundle", "d402_offer", "d402_status", "d402_submit", "echo"]);
    const unpaid = await c.call("echo", { msg: "hi" });
    expect(unpaid.structured.paymentRequired).toBe(true);
    // The demo pool's goldens are the corpus docs labelled by topic; the echo scope is outside the default scope.
    expect(unpaid.structured.d402.accepts[0].scope).toEqual(["/mcp/search"]);
    await c.client.close();
    const code = await stop(running);
    running = undefined;
    expect(code).toBe(0);
  });

  it("prints usage on --help and exits 2 on an unknown flag", async () => {
    const run = (args: string[]) =>
      new Promise<{ code: number | null; out: string; err: string }>((resolve) => {
        const p = spawn(process.execPath, ["--import", "tsx", "src/cli.ts", ...args], { cwd: pkgDir, stdio: ["ignore", "pipe", "pipe"] });
        let out = "";
        let err = "";
        p.stdout!.on("data", (c: Buffer) => (out += c.toString()));
        p.stderr!.on("data", (c: Buffer) => (err += c.toString()));
        p.once("exit", (code) => resolve({ code, out, err }));
      });
    const help = await run(["--help"]);
    expect(help.code).toBe(0);
    expect(help.out).toContain("usage: d402-mcp-seller");
    const bad = await run(["--nope"]);
    expect(bad.code).toBe(2);
    expect(bad.err).toContain('unknown flag "--nope"');
  });
});

describe("parseArgs", () => {
  const env = {} as NodeJS.ProcessEnv;

  it("parses every flag", () => {
    const o = parseArgs(
      [
        "--tasks", "t.jsonl",
        "--labels", "a, b ,c",
        "--scope", "/mcp,/search",
        "--port", "0",
        "--secret", "x",
        "--seller-id", "me",
        "--public-url", "https://me.test/",
        "--tier", "s:2:100:3",
        "--tier=l:50:10000:150",
        "--db", "d.sqlite",
        "--path", "/rpc",
        "--tools-module", "./t.js",
        "--instructions", "label it",
        "--name", "n",
        "--bind-vouchers",
        "--require-spend-nonce",
        "--require-model-families",
        "--no-search",
        "--no-session-keys",
      ],
      env,
    );
    expect(o).toEqual({
      tasks: "t.jsonl",
      labels: ["a", "b", "c"],
      scope: ["/mcp", "/search"],
      port: 0,
      secret: "x",
      sellerId: "me",
      publicUrl: "https://me.test/",
      tiers: [
        { id: "s", items: 2, est_tokens: 100, reward: { calls: 3 } },
        { id: "l", items: 50, est_tokens: 10000, reward: { calls: 150 } },
      ],
      db: "d.sqlite",
      path: "/rpc",
      toolsModule: "./t.js",
      instructions: "label it",
      name: "n",
      bindVouchers: true,
      requireSpendNonce: true,
      requireModelFamilies: true,
      noSearch: true,
      sessionKeys: false,
    });
  });

  it("falls back to env PORT and D402_SECRET, rejects bad ports and tiers, throws HelpRequested", () => {
    expect(parseArgs([], { PORT: "9001", D402_SECRET: "s" } as NodeJS.ProcessEnv)).toEqual({ port: 9001, secret: "s" });
    expect(parseArgs(["--port", "1"], { PORT: "9001" } as NodeJS.ProcessEnv)).toEqual({ port: 1 });
    expect(() => parseArgs(["--port", "abc"], env)).toThrow(/--port/);
    expect(() => parseArgs(["--tier", "s:2"], env)).toThrow(/--tier/);
    expect(() => parseTier("s:0:1:1")).toThrow(/positive/);
    expect(() => parseArgs(["--tasks"], env)).toThrow(/needs a value/);
    expect(() => parseArgs(["-h"], env)).toThrow(HelpRequested);
    expect(USAGE).toContain("--tools-module");
  });
});

describe("corpus", () => {
  it("search ranks title matches first and the demo pool has 10 goldens over 4 labels", () => {
    const hits = search("marathon");
    expect(hits[0]!.id).toBe("sports/marathon-record");
    expect(search("zzzz")).toEqual([]);
    expect(search("the", 3)).toHaveLength(3);
    const goldens = DEMO_TASKS.filter((t) => t.golden);
    expect(goldens).toHaveLength(10);
    expect(new Set(goldens.map((t) => t.golden)).size).toBe(4);
    expect(DEMO_TASKS).toHaveLength(20);
  });
});
