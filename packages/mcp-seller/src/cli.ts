#!/usr/bin/env node
/**
 * d402-mcp-seller: a complete, hostable paid MCP server.
 *
 *   d402-mcp-seller --tasks ./tasks.jsonl --labels a,b,c --scope /mcp/search --port 8788 --secret X
 *
 * Serves the d402 HTTP routes at /.well-known/d402* and the MCP Streamable
 * HTTP endpoint at /mcp, with a demo gated `search` tool over a built-in
 * corpus. `--tools-module` adds the seller's own gated tools.
 */
import { randomBytes } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { pathToFileURL } from "node:url";
import { serve, type ServerType } from "@hono/node-server";
import { z } from "zod";
import { createD402, type D402Server } from "@d402/server";
import { WELL_KNOWN_TASKS_PATH, type Tier } from "@d402/spec";
import { CORPUS, DEMO_TASKS, LABELS as DEMO_LABELS, search } from "./corpus.js";
import { createStreamableHttpApp, type StreamableHttpApp } from "./http.js";
import { createD402McpServer, type D402McpServer } from "./server.js";

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface SellerOptions {
  /** JSONL task file (SPEC 10). Without it the built-in demo pool is loaded. */
  tasks?: string;
  /** Classify labels (>= 2). Default: derived from the task file's goldens, or the demo labels. */
  labels?: string[];
  /** Voucher scope prefixes. Default ["/mcp/search"]. */
  scope?: string[];
  /** Listen port. Default: env PORT, else 8788. */
  port?: number;
  /** HMAC secret for vouchers. Default: env D402_SECRET, else random with a warning. */
  secret?: string;
  /** sellerId in the offer and `iss` of vouchers. Default "d402-mcp-seller". */
  sellerId?: string;
  /** Public base URL, for taskUrl. Default http://localhost:{port}. */
  publicUrl?: string;
  tiers?: Tier[];
  /** SQLite path, default ":memory:". */
  db?: string;
  bindVouchers?: boolean;
  requireSpendNonce?: boolean;
  requireModelFamilies?: boolean;
  /** Path of the MCP endpoint. Default "/mcp". */
  path?: string;
  /** A module exporting `register(gated, ctx)` that adds gated tools. */
  toolsModule?: string;
  /** Instructions shown in every bundle. */
  instructions?: string;
  /** Disable per-session keypairs: agents must pass `key`. */
  sessionKeys?: boolean;
  /** Do not register the demo `search` tool. */
  noSearch?: boolean;
  /** MCP server name. Default "d402-seller". */
  name?: string;
  warn?: (line: string) => void;
}

export const DEFAULT_PORT = 8788;
export const DEFAULT_SCOPE = ["/mcp/search"];
export const DEFAULT_SELLER_ID = "d402-mcp-seller";

export const DEFAULT_TIERS: Tier[] = [
  { id: "s", items: 5, est_tokens: 1000, reward: { calls: 10 } },
  { id: "m", items: 25, est_tokens: 5000, reward: { calls: 60 } },
  { id: "l", items: 50, est_tokens: 10000, reward: { calls: 150 } },
];

/** What a `--tools-module` exports. */
export interface ToolsModule {
  register(gated: D402McpServer["gated"], ctx: { d402: D402Server; server: D402McpServer["server"] }): void | Promise<void>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function stripTrailingSlash(s: string): string {
  return s.replace(/\/+$/, "");
}

/** Collect the distinct `golden` values of a JSONL task file, in first-seen order. */
export function labelsFromTaskFile(path: string): string[] {
  const seen = new Set<string>();
  for (const raw of readFileSync(path, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    let row: unknown;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    const golden = (row as { golden?: unknown } | null)?.golden;
    if (typeof golden === "string" && golden) seen.add(golden);
  }
  return [...seen];
}

/** Parse "id:items:est_tokens:calls" (SPEC 3). */
export function parseTier(spec: string): Tier {
  const parts = spec.split(":");
  if (parts.length !== 4) throw new Error(`--tier must be id:items:est_tokens:calls, got ${JSON.stringify(spec)}`);
  const [id, items, estTokens, calls] = parts as [string, string, string, string];
  const nums = [items, estTokens, calls].map((n) => Number(n));
  if (!id || nums.some((n) => !Number.isInteger(n) || n <= 0)) {
    throw new Error(`--tier must be id:items:est_tokens:calls with positive integers, got ${JSON.stringify(spec)}`);
  }
  return { id, items: nums[0]!, est_tokens: nums[1]!, reward: { calls: nums[2]! } };
}

// ---------------------------------------------------------------------------
// buildSeller: d402 + MCP factory + Hono app
// ---------------------------------------------------------------------------

export interface BuiltSeller extends StreamableHttpApp {
  d402: D402Server;
  /** Tool names registered on every session's McpServer. */
  tools: string[];
  publicUrl: string;
}

export async function buildSeller(opts: SellerOptions): Promise<BuiltSeller> {
  const warn = opts.warn ?? ((line: string) => process.stderr.write(line + "\n"));
  const port = opts.port ?? DEFAULT_PORT;
  const publicUrl = stripTrailingSlash(opts.publicUrl ?? `http://localhost:${port}`);
  const scope = opts.scope && opts.scope.length > 0 ? opts.scope.map((s) => (s === "/" ? "/" : stripTrailingSlash(s))) : DEFAULT_SCOPE;

  let secret = opts.secret;
  if (!secret) {
    secret = randomBytes(32).toString("base64url");
    warn("d402-mcp-seller: no secret given (--secret or D402_SECRET); generated a random one. Vouchers will not survive a restart.");
  }

  let labels = opts.labels;
  if (!labels || labels.length === 0) {
    if (opts.tasks) {
      labels = labelsFromTaskFile(opts.tasks);
      if (labels.length < 2) {
        throw new Error(`d402-mcp-seller: --labels is required; only ${labels.length} distinct golden label(s) found in ${opts.tasks}`);
      }
      warn(`d402-mcp-seller: --labels not given; derived ${JSON.stringify(labels)} from the goldens in ${opts.tasks}`);
    } else {
      labels = [...DEMO_LABELS];
    }
  }
  if (labels.length < 2) throw new Error("d402-mcp-seller: --labels needs at least 2 labels");

  const d402 = createD402({
    sellerId: opts.sellerId ?? DEFAULT_SELLER_ID,
    taskUrl: `${publicUrl}${WELL_KNOWN_TASKS_PATH}`,
    scope,
    tiers: opts.tiers && opts.tiers.length > 0 ? opts.tiers : DEFAULT_TIERS,
    secret,
    labels,
    instructions: opts.instructions,
    db: opts.db,
    bindVouchers: opts.bindVouchers,
    requireSpendNonce: opts.requireSpendNonce,
    requireModelFamilies: opts.requireModelFamilies,
  });
  if (opts.tasks) d402.tasks.loadFile(opts.tasks);
  else {
    d402.tasks.load(DEMO_TASKS);
    warn("d402-mcp-seller: no --tasks file; loaded the built-in demo pool (20 items, 10 golden)");
  }

  let toolsModule: ToolsModule | undefined;
  if (opts.toolsModule) {
    const href = pathToFileURL(resolvePath(opts.toolsModule)).href;
    const mod = (await import(href)) as Partial<ToolsModule> & { default?: Partial<ToolsModule> };
    const register = mod.register ?? mod.default?.register;
    if (typeof register !== "function") {
      throw new Error(`d402-mcp-seller: --tools-module ${opts.toolsModule} must export register(gated, ctx)`);
    }
    toolsModule = { register };
  }

  const tools: string[] = ["d402_offer", "d402_get_bundle", "d402_submit", "d402_status"];
  const makeServer = async (record: boolean) => {
    const mcp = createD402McpServer({ d402, name: opts.name, sessionKeys: opts.sessionKeys });
    const gated: D402McpServer["gated"] = (name, config, handler) => {
      if (record) tools.push(name);
      mcp.gated(name, config, handler);
    };
    if (!opts.noSearch) {
      gated(
        "search",
        {
          title: "Search the demo corpus",
          description: `Keyword search over a ${CORPUS.length}-document demo corpus (sports, business, tech, world). Returns hits with title, url, topic and snippet.`,
          inputSchema: {
            q: z.string().min(1).describe("Search terms."),
            limit: z.number().int().min(1).max(10).optional().describe("Max hits, default 5."),
          },
          scope: "/mcp/search",
          annotations: { readOnlyHint: true },
        },
        async ({ q, limit }) => {
          const hits = search(q, limit ?? 5);
          return { content: [{ type: "text", text: JSON.stringify({ q, hits }, null, 2) }], structuredContent: { q, hits } };
        },
      );
    }
    if (toolsModule) await toolsModule.register(gated, { d402, server: mcp.server });
    return mcp.server;
  };

  // Build one server up front so a broken tools module fails at boot, not on the first session.
  await (await makeServer(true)).close().catch(() => {});

  const built = createStreamableHttpApp({ d402, path: opts.path, mcp: () => makeServer(false) });

  return { ...built, d402, tools, publicUrl };
}

// ---------------------------------------------------------------------------
// parseArgs
// ---------------------------------------------------------------------------

export const USAGE = `usage: d402-mcp-seller [options]

  --tasks <file.jsonl>        classify task file (SPEC 10); default: a built-in 20-item demo pool
  --labels <a,b,...>          classify labels, at least 2 (default: derived from the task file's goldens)
  --scope <prefix,...>        voucher scope prefixes (default: /mcp/search); list /search too to share vouchers with HTTP routes
  --port <n>                  listen port (default: env PORT, else 8788; 0 picks a free port)
  --secret <s>                voucher HMAC secret (default: env D402_SECRET, else random with a warning)
  --seller-id <id>            sellerId in the offer (default: d402-mcp-seller)
  --public-url <url>          public base URL, for taskUrl (default: http://localhost:<port>)
  --tier <id:items:tokens:calls>  a tier; repeatable (default: s:5:1000:10 m:25:5000:60 l:50:10000:150)
  --db <path>                 SQLite path (default: in memory)
  --path <p>                  MCP endpoint path (default: /mcp)
  --tools-module <file.js>    module exporting register(gated, { d402, server }) that adds your gated tools
  --no-search                 do not register the demo search tool
  --no-session-keys           agents must pass key (and sign); no per-session keypairs
  --bind-vouchers             SPEC 7.1: spends must be signed by the agent key (the server signs in session mode)
  --require-spend-nonce       SPEC 7.2: bound spends must carry a nonce
  --require-model-families    resolution needs votes from 2 model families
  --instructions <text>       instructions shown in every bundle
  --name <s>                  MCP server name (default: d402-seller)
  -h, --help                  show this help`;

const VALUE_FLAGS: Record<string, keyof SellerOptions> = {
  "--tasks": "tasks",
  "--labels": "labels",
  "--scope": "scope",
  "--port": "port",
  "--secret": "secret",
  "--seller-id": "sellerId",
  "--public-url": "publicUrl",
  "--tier": "tiers",
  "--db": "db",
  "--path": "path",
  "--tools-module": "toolsModule",
  "--instructions": "instructions",
  "--name": "name",
};

const BOOL_FLAGS: Record<string, { key: keyof SellerOptions; value: boolean }> = {
  "--bind-vouchers": { key: "bindVouchers", value: true },
  "--require-spend-nonce": { key: "requireSpendNonce", value: true },
  "--require-model-families": { key: "requireModelFamilies", value: true },
  "--no-search": { key: "noSearch", value: true },
  "--no-session-keys": { key: "sessionKeys", value: false },
};

export class HelpRequested extends Error {
  constructor() {
    super(USAGE);
  }
}

function list(v: string): string[] | undefined {
  const out = v
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return out.length ? out : undefined;
}

export function parseArgs(argv: string[], env: NodeJS.ProcessEnv = process.env): SellerOptions {
  const out: SellerOptions = {};
  const tiers: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "-h" || arg === "--help") throw new HelpRequested();
    let name = arg;
    let inlineValue: string | undefined;
    const eq = arg.indexOf("=");
    if (arg.startsWith("--") && eq !== -1) {
      name = arg.slice(0, eq);
      inlineValue = arg.slice(eq + 1);
    }
    const b = BOOL_FLAGS[name];
    if (b) {
      const on = inlineValue === undefined ? true : inlineValue !== "false";
      (out as Record<string, unknown>)[b.key] = on ? b.value : !b.value;
      continue;
    }
    const key = VALUE_FLAGS[name];
    if (!key) throw new Error(`d402-mcp-seller: unknown flag ${JSON.stringify(arg)}\n\n${USAGE}`);
    const value = inlineValue ?? argv[++i];
    if (value === undefined) throw new Error(`d402-mcp-seller: ${name} needs a value`);
    switch (key) {
      case "tiers":
        tiers.push(value);
        break;
      case "labels":
      case "scope": {
        const l = list(value);
        if (l) out[key] = l;
        break;
      }
      case "port": {
        const port = Number(value);
        if (!Number.isInteger(port) || port < 0 || port > 65535) {
          throw new Error(`d402-mcp-seller: --port must be an integer in 0..65535, got ${JSON.stringify(value)}`);
        }
        out.port = port;
        break;
      }
      default:
        (out as Record<string, unknown>)[key] = value;
    }
  }
  if (tiers.length) out.tiers = tiers.map(parseTier);
  if (out.secret === undefined && env.D402_SECRET) out.secret = env.D402_SECRET;
  if (out.port === undefined && env.PORT) {
    const port = Number(env.PORT);
    if (Number.isInteger(port) && port >= 0 && port <= 65535) out.port = port;
  }
  return out;
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

export async function main(argv: string[]): Promise<void> {
  let opts: SellerOptions;
  try {
    opts = parseArgs(argv);
  } catch (e) {
    if (e instanceof HelpRequested) {
      process.stdout.write(USAGE + "\n");
      process.exitCode = 0;
      return;
    }
    process.stderr.write(`${(e as Error).message}\n`);
    process.exitCode = 2;
    return;
  }

  const port = opts.port ?? DEFAULT_PORT;
  let built: BuiltSeller;
  try {
    built = await buildSeller({ ...opts, port });
  } catch (e) {
    process.stderr.write(`${(e as Error).message}\n`);
    process.exitCode = 2;
    return;
  }
  const { app, d402, path } = built;

  const server: ServerType = serve({ fetch: app.fetch, port, hostname: process.env.HOST }, (info) => {
    const stats = d402.tasks.stats();
    const publicUrl = (opts.publicUrl ?? `http://localhost:${info.port}`).replace(/\/+$/, "");
    const lines = [
      `d402-mcp-seller listening on http://localhost:${info.port}`,
      `  mcp:      ${publicUrl}${path}  (Streamable HTTP)`,
      `  offer:    ${publicUrl}/.well-known/d402`,
      `  scope:    ${(opts.scope ?? DEFAULT_SCOPE).join(", ")}`,
      `  pool:     ${stats.total} items (${stats.golden} golden)`,
      `  tools:    ${built.tools.join(", ")}`,
    ];
    process.stderr.write(lines.join("\n") + "\n");
  });

  const shutdown = () => {
    void built.close();
    server.close(() => {
      d402.close();
      process.exit(0);
    });
    const s = server as ServerType & { closeAllConnections?: () => void };
    s.closeAllConnections?.();
    setTimeout(() => process.exit(0), 1000).unref();
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

const isMain = (() => {
  try {
    const entry = process.argv[1];
    return !!entry && import.meta.url === pathToFileURL(realpathSync(entry)).href;
  } catch {
    return false;
  }
})();

if (isMain) {
  main(process.argv.slice(2)).catch((err) => {
    process.stderr.write(`d402-mcp-seller: fatal: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
    process.exit(1);
  });
}
