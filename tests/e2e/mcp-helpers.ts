/**
 * Helpers for the MCP stdio end-to-end tests.
 *
 * Nothing here is mocked: `startSeller` runs the real `@d402/server` behind
 * `@hono/node-server` on an ephemeral port, and `startMcp` spawns the real
 * `packages/mcp/src/bin.ts` as a child process and talks to it over stdio with
 * the MCP SDK's `StdioClientTransport`.
 *
 * Dependency resolution: the repo root `node_modules` only holds tooling
 * (tsx, vitest, typescript). `hono`, `@hono/node-server` and the MCP SDK live
 * in workspace package `node_modules`, so they are resolved from there with
 * `createRequire` and loaded with dynamic `import()`.
 */
import { createRequire } from "node:module";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createD402, type D402Server } from "@d402/server";
import type { Bundle, TaskFileItem, Tier } from "@d402/spec";

// ---------------------------------------------------------------------------
// Paths and dependency resolution
// ---------------------------------------------------------------------------

export const REPO_ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));
export const MCP_DIR = join(REPO_ROOT, "packages", "mcp");
export const MCP_BIN_TS = join(MCP_DIR, "src", "bin.ts");

function resolveFrom(dirs: string[], specifier: string): string {
  const errors: string[] = [];
  for (const dir of dirs) {
    try {
      return createRequire(join(dir, "package.json")).resolve(specifier);
    } catch (err) {
      errors.push(`${dir}: ${(err as Error).message.split("\n")[0]}`);
    }
  }
  throw new Error(`cannot resolve ${specifier} from any of the workspace packages:\n${errors.join("\n")}`);
}

const SDK_DIRS = [MCP_DIR];
const HONO_DIRS = [join(REPO_ROOT, "packages", "server"), join(REPO_ROOT, "examples", "search-proxy"), join(REPO_ROOT, "bench")];
const NODE_SERVER_DIRS = [join(REPO_ROOT, "examples", "search-proxy"), join(REPO_ROOT, "bench")];

type HonoCtor = new () => any;
type ServeFn = (opts: { fetch: (req: Request, env?: unknown) => Response | Promise<Response>; port: number; hostname?: string }, cb?: (info: { port: number; address: string }) => void) => any;

const honoMod = (await import(/* @vite-ignore */ resolveFrom(HONO_DIRS, "hono"))) as { Hono: HonoCtor };
const nodeServerMod = (await import(/* @vite-ignore */ resolveFrom(NODE_SERVER_DIRS, "@hono/node-server"))) as { serve: ServeFn };
const sdkClientMod = (await import(/* @vite-ignore */ resolveFrom(SDK_DIRS, "@modelcontextprotocol/sdk/client/index.js"))) as {
  Client: new (info: { name: string; version: string }, opts?: unknown) => McpClient;
};
const sdkStdioMod = (await import(/* @vite-ignore */ resolveFrom(SDK_DIRS, "@modelcontextprotocol/sdk/client/stdio.js"))) as {
  StdioClientTransport: new (params: {
    command: string;
    args?: string[];
    env?: Record<string, string>;
    cwd?: string;
    stderr?: "pipe" | "inherit" | "ignore";
  }) => StdioTransport;
};

export const Hono = honoMod.Hono;
export const serve = nodeServerMod.serve;
export const Client = sdkClientMod.Client;
export const StdioClientTransport = sdkStdioMod.StdioClientTransport;

// ---------------------------------------------------------------------------
// Minimal structural types for the parts of the SDK we use
// ---------------------------------------------------------------------------

export interface ToolContent {
  type: string;
  text?: string;
}

export interface CallToolResult {
  content: ToolContent[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

export interface ToolInfo {
  name: string;
  description?: string;
  inputSchema: { type: string; properties?: Record<string, unknown>; required?: string[] };
}

export interface McpClient {
  connect(transport: StdioTransport): Promise<void>;
  close(): Promise<void>;
  listTools(): Promise<{ tools: ToolInfo[] }>;
  callTool(params: { name: string; arguments?: Record<string, unknown> }): Promise<CallToolResult>;
  ping(): Promise<unknown>;
  getServerVersion(): { name: string; version: string } | undefined;
  getInstructions(): string | undefined;
}

export interface StdioTransport {
  readonly pid: number | null;
  readonly stderr: NodeJS.ReadableStream | null;
  start(): Promise<void>;
  close(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Seeded pool generator
// ---------------------------------------------------------------------------

export const LABELS = ["sports", "business", "tech", "world"] as const;
export type Label = (typeof LABELS)[number];

export const TIERS: Tier[] = [
  { id: "s", items: 5, est_tokens: 1000, reward: { calls: 10 } },
  { id: "m", items: 25, est_tokens: 5000, reward: { calls: 60 } },
  { id: "l", items: 50, est_tokens: 10000, reward: { calls: 150 } },
];

export const SELLER_ID = "mcp-seller";
export const SELLER_SECRET = "mcp-secret";
export const SCOPE = ["/search"];

/** mulberry32: a tiny deterministic PRNG so every run sees the same pool. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const PHRASES: Record<Label, string[]> = {
  sports: [
    "The striker scored twice in the final minutes to win the cup",
    "The marathon record fell by eleven seconds on a cold morning",
    "The goalkeeper saved three penalties in the shootout",
    "The home team clinched the title with a late touchdown",
    "The tennis champion retired after a fourth straight loss",
  ],
  business: [
    "The retailer raised its quarterly guidance after strong holiday sales",
    "Shares fell six percent after the merger talks collapsed",
    "The central bank held interest rates steady for a third meeting",
    "The startup closed a funding round led by two pension funds",
    "The airline reported its first annual profit since the pandemic",
  ],
  tech: [
    "The chipmaker unveiled a smaller process node for mobile GPUs",
    "A new open-source database claims ten times faster writes",
    "The browser update ships a built-in password manager",
    "Researchers trained a compact language model on a single laptop",
    "The cloud outage took down thousands of websites for an hour",
  ],
  world: [
    "Flooding displaced thousands of residents along the river delta",
    "The two countries signed a ceasefire after months of talks",
    "Election officials began counting votes in the capital",
    "An earthquake shook the coastal province overnight",
    "The summit ended with a joint statement on climate aid",
  ],
};

export interface GeneratedPool {
  items: TaskFileItem[];
  truth: Map<string, Label>;
}

/**
 * Generates `count` classify items. `goldenRatio` of them carry a `golden`
 * answer; the truth map knows the label of every item, golden or not.
 */
export function generatePool(count = 200, goldenRatio = 0.3, seed = 42): GeneratedPool {
  const rand = seededRandom(seed);
  const items: TaskFileItem[] = [];
  const truth = new Map<string, Label>();
  // Goldens are the first `goldenRatio * 10` of every 10 items, so 200 items
  // at 0.3 give exactly 60 goldens.
  const goldenPerTen = Math.round(goldenRatio * 10);
  for (let i = 1; i <= count; i++) {
    const label = LABELS[Math.floor(rand() * LABELS.length)]!;
    const phrases = PHRASES[label];
    const text = `${phrases[Math.floor(rand() * phrases.length)]} (#${i})`;
    const id = `i_${i}`;
    const golden = (i - 1) % 10 < goldenPerTen;
    const item: TaskFileItem = { id, type: "classify", text };
    if (golden) item.golden = label;
    items.push(item);
    truth.set(id, label);
  }
  return { items, truth };
}

/** Correct answers for every item of a bundle, from the truth map. */
export function answerBundle(bundle: Pick<Bundle, "items">, truth: Map<string, string>): Record<string, string> {
  const answers: Record<string, string> = {};
  for (const it of bundle.items) {
    const label = truth.get(it.id);
    if (!label) throw new Error(`no truth for item ${it.id}`);
    answers[it.id] = label;
  }
  return answers;
}

/** A deliberately wrong label for every item of a bundle. */
export function wrongAnswers(bundle: Pick<Bundle, "items" | "labels">, truth: Map<string, string>): Record<string, string> {
  const answers: Record<string, string> = {};
  for (const it of bundle.items) {
    const right = truth.get(it.id);
    const wrong = bundle.labels.find((l) => l !== right);
    if (!wrong) throw new Error(`no wrong label available for ${it.id}`);
    answers[it.id] = wrong;
  }
  return answers;
}

// ---------------------------------------------------------------------------
// Seller
// ---------------------------------------------------------------------------

export interface SellerHandle {
  baseUrl: string;
  taskUrl: string;
  d402: D402Server;
  truth: Map<string, Label>;
  port: number;
  close(): Promise<void>;
}

export interface SellerOptions {
  bindVouchers?: boolean;
  poolSize?: number;
  goldenRatio?: number;
  seed?: number;
  tiers?: Tier[];
}

function listen(fetchHandler: (req: Request, env?: unknown) => Response | Promise<Response>): Promise<{ server: any; port: number }> {
  return new Promise((resolvePromise, reject) => {
    try {
      const server = serve({ fetch: fetchHandler, port: 0, hostname: "127.0.0.1" }, (info) => {
        resolvePromise({ server, port: info.port });
      });
    } catch (err) {
      reject(err);
    }
  });
}

/**
 * A real seller: `@d402/server` mounted in a Hono app behind `@hono/node-server`
 * on port 0. `/search` is gated and returns a small JSON hit list, or a 100KB
 * text body when `?big=1`. `/health` is open.
 */
export async function startSeller(opts: SellerOptions = {}): Promise<SellerHandle> {
  // The task URL must be absolute, so the port has to be known before
  // createD402 runs. Listen first with a handler that forwards to the app
  // built afterwards; no request can arrive before it exists.
  let app: any;
  const { server, port } = await listen((req, env) => app.fetch(req, env));
  const baseUrl = `http://127.0.0.1:${port}`;
  const taskUrl = `${baseUrl}/.well-known/d402/tasks`;

  const d402 = createD402({
    sellerId: SELLER_ID,
    taskUrl,
    scope: SCOPE,
    tiers: opts.tiers ?? TIERS,
    secret: SELLER_SECRET,
    labels: [...LABELS],
    instructions: "Label each news snippet with exactly one of: sports, business, tech, world.",
    bindVouchers: opts.bindVouchers ?? false,
  });
  const pool = generatePool(opts.poolSize ?? 200, opts.goldenRatio ?? 0.3, opts.seed ?? 42);
  d402.tasks.load(pool.items);

  app = new Hono();
  app.route("/", d402.routes);
  app.get("/health", (c: any) => c.json({ ok: true }));
  app.use("/search", d402.gate);
  app.use("/search/*", d402.gate);
  app.get("/search", (c: any) => {
    if (c.req.query("big") === "1") {
      return c.text("x".repeat(100 * 1024));
    }
    const q = c.req.query("q") ?? "";
    return c.json({ q, hits: [{ id: "h_1", title: `result for ${q}` }] });
  });

  return {
    baseUrl,
    taskUrl,
    d402,
    truth: pool.truth,
    port,
    close: () =>
      new Promise<void>((resolvePromise) => {
        try {
          server.closeAllConnections?.();
        } catch {
          /* ignore */
        }
        server.close(() => {
          d402.close();
          resolvePromise();
        });
      }),
  };
}

/** A Hono server with only `/health`: an origin that does not offer d402. */
export async function startBareServer(): Promise<{ baseUrl: string; close(): Promise<void> }> {
  const app = new Hono();
  app.get("/health", (c: any) => c.json({ ok: true }));
  const { server, port } = await listen((req, env) => app.fetch(req, env));
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolvePromise) => {
        try {
          server.closeAllConnections?.();
        } catch {
          /* ignore */
        }
        server.close(() => resolvePromise());
      }),
  };
}

// ---------------------------------------------------------------------------
// MCP process
// ---------------------------------------------------------------------------

export interface McpHandle {
  client: McpClient;
  transport: StdioTransport;
  home: string;
  pid: number;
  /** Everything the child wrote to stderr so far. */
  stderrText(): string;
  /** Close the client; the child's stdin ends and it should exit on its own. */
  close(): Promise<void>;
  /** Close and remove the temp home. */
  destroy(): Promise<void>;
}

export interface McpOptions {
  /** Reuse an existing home (for persistence tests). Default: a fresh temp dir. */
  home?: string;
  /** Spawn `dist/bin.js` instead of `src/bin.ts` via tsx. */
  useDist?: boolean;
}

export function makeHome(prefix = "d402-mcp-e2e-"): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

/**
 * Spawns the MCP server (`node --import tsx packages/mcp/src/bin.ts`) over
 * stdio and connects an MCP client to it. `env` is merged over process.env.
 */
export async function startMcp(env: Record<string, string> = {}, opts: McpOptions = {}): Promise<McpHandle> {
  const home = opts.home ?? makeHome();
  const args = opts.useDist ? [join(MCP_DIR, "dist", "bin.js")] : ["--import", "tsx", MCP_BIN_TS];
  const childEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) childEnv[k] = v;
  // Make sure nothing from the developer's shell leaks into the child.
  delete childEnv.D402_MODEL;
  delete childEnv.D402_TIER;
  delete childEnv.D402_SOLVER_CMD;
  Object.assign(childEnv, { D402_HOME: home }, env);

  const transport = new StdioClientTransport({ command: "node", args, env: childEnv, cwd: REPO_ROOT, stderr: "pipe" });
  const chunks: Buffer[] = [];
  transport.stderr?.on("data", (c: Buffer) => chunks.push(Buffer.from(c)));
  const client = new Client({ name: "d402-e2e", version: "0.0.0" });
  await client.connect(transport);
  const pid = transport.pid;
  if (pid === null) throw new Error("MCP child has no pid after connect");

  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await client.close();
  };
  return {
    client,
    transport,
    home,
    pid,
    stderrText: () => Buffer.concat(chunks).toString("utf8"),
    close,
    destroy: async () => {
      await close();
      rmSync(home, { recursive: true, force: true });
    },
  };
}

/** True while a process with this pid exists. */
export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

export async function waitForExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!processAlive(pid)) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return !processAlive(pid);
}

// ---------------------------------------------------------------------------
// Tool call helper
// ---------------------------------------------------------------------------

export interface ToolCall {
  isError: boolean;
  /** The JSON printed in the first text content block. */
  data: Record<string, any>;
  text: string;
  structured: Record<string, any> | undefined;
  raw: CallToolResult;
}

export async function call(client: McpClient, name: string, args: Record<string, unknown> = {}): Promise<ToolCall> {
  const raw = await client.callTool({ name, arguments: args });
  const first = raw.content.find((c) => c.type === "text");
  const text = first?.text ?? "";
  let data: Record<string, any> = {};
  try {
    data = JSON.parse(text);
  } catch {
    data = { message: text };
  }
  return { isError: raw.isError === true, data, text, structured: raw.structuredContent as Record<string, any> | undefined, raw };
}

// ---------------------------------------------------------------------------
// Solver command
// ---------------------------------------------------------------------------

const SOLVER_SCRIPT = `"use strict";
// d402 e2e solver: bundle JSON on stdin, { itemId: label } on stdout.
// The answer key is a JSON object { itemId: label } at process.argv[2]
// (or env D402_TRUTH). Items missing from the key get the first bundle label.
const fs = require("node:fs");
const truthPath = process.argv[2] || process.env.D402_TRUTH;
if (!truthPath) {
  process.stderr.write("solver: no truth path\\n");
  process.exit(2);
}
const truth = JSON.parse(fs.readFileSync(truthPath, "utf8"));
const input = fs.readFileSync(0, "utf8");
const bundle = JSON.parse(input);
const answers = {};
for (const it of bundle.items) {
  answers[it.id] = truth[it.id] ?? bundle.labels[0];
}
process.stdout.write(JSON.stringify(answers));
`;

/** Writes the truth map to `<dir>/truth.json` and returns the path. */
export function writeTruth(truth: Map<string, string>, dir: string): string {
  const path = join(dir, "truth.json");
  writeFileSync(path, JSON.stringify(Object.fromEntries(truth)), { mode: 0o600 });
  return path;
}

/**
 * Writes a small node script that answers bundles from a truth file and
 * returns the shell command to use as `D402_SOLVER_CMD`.
 */
export function solverCmd(truthPath: string, dir?: string): string {
  const scriptDir = dir ?? makeHome("d402-solver-");
  const script = join(scriptDir, "solver.cjs");
  writeFileSync(script, SOLVER_SCRIPT, { mode: 0o700 });
  const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
  return `${q(process.execPath)} ${q(script)} ${q(truthPath)}`;
}
