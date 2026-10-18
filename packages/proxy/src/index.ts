/**
 * @d402/proxy: put a d402 gate in front of any existing HTTP API.
 *
 *   d402-proxy --upstream https://api.example.com --tasks ./tasks.jsonl
 *
 * The proxy mounts the d402 routes at /.well-known/d402*, runs `d402.gate` on
 * every request whose path is inside `scope` (minus `open` paths), and
 * forwards everything else, gated or not, to the upstream unchanged.
 */
import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { Hono } from "hono";
import type { Context, MiddlewareHandler } from "hono";
import type { StatusCode } from "hono/utils/http-status";
import { createD402, type D402Server } from "@d402/server";
import { HEADERS, WELL_KNOWN_PATH, WELL_KNOWN_TASKS_PATH, type Tier } from "@d402/spec";

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface ProxyOptions {
  /** Base URL of the API being gated, e.g. https://api.example.com. Required. */
  upstream: string;
  /** JSONL task file loaded at boot (SPEC 10). */
  tasks?: string;
  /** Path prefixes to gate. Default ["/"] (everything except /.well-known and `open`). */
  scope?: string[];
  /** Classify labels (>= 2). Derived from the task file's goldens when absent. */
  labels?: string[];
  /** `sellerId` in the offer and `iss` of vouchers. Default: the upstream host. */
  sellerId?: string;
  /** Public base URL of this proxy, used to build `taskUrl`. Default http://localhost:{port}. */
  publicUrl?: string;
  /** HMAC secret for vouchers. Generated (with a warning) when absent. */
  secret?: string;
  /** Listen port for the CLI, and the default publicUrl. Default 8787. */
  port?: number;
  tiers?: Tier[];
  /** SQLite path, default ":memory:". */
  db?: string;
  bindVouchers?: boolean;
  requireModelFamilies?: boolean;
  /** Enables GET /.well-known/d402/admin/{stats,export} behind `Authorization: Bearer <token>`. */
  adminToken?: string;
  /** Path prefixes that are never gated (e.g. /health). */
  open?: string[];
  /** Instructions shown in every bundle. */
  instructions?: string;
  /** Request log sink (one line per request). Default: stderr. */
  log?: (line: string) => void;
  /** Warning sink. Default: stderr. */
  warn?: (line: string) => void;
  /** Transport to the upstream. Default: globalThis.fetch. */
  fetch?: typeof fetch;
}

export const DEFAULT_PORT = 8787;

export const DEFAULT_TIERS: Tier[] = [
  { id: "s", items: 5, est_tokens: 1000, reward: { calls: 10 } },
  { id: "m", items: 25, est_tokens: 5000, reward: { calls: 60 } },
  { id: "l", items: 50, est_tokens: 10000, reward: { calls: 150 } },
];

export const ADMIN_STATS_PATH = `${WELL_KNOWN_PATH}/admin/stats`;
export const ADMIN_EXPORT_PATH = `${WELL_KNOWN_PATH}/admin/export`;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** RFC 7230 6.1 hop-by-hop headers, never forwarded in either direction. */
const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

function stripTrailingSlash(s: string): string {
  return s.replace(/\/+$/, "");
}

function pathMatches(prefixes: string[], path: string): boolean {
  return prefixes.some((p) => {
    const prefix = p === "/" ? "/" : stripTrailingSlash(p);
    if (prefix === "/") return true;
    // Same rule as the server's voucher scope check: prefix match.
    return path === prefix || path.startsWith(prefix);
  });
}

function clientIp(c: Context): string | undefined {
  const env = c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined;
  return env?.incoming?.socket?.remoteAddress || undefined;
}

function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
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
// createProxyApp
// ---------------------------------------------------------------------------

export function createProxyApp(opts: ProxyOptions): { app: Hono; d402: D402Server } {
  if (!opts.upstream) throw new Error("d402-proxy: --upstream is required");
  let upstreamUrl: URL;
  try {
    upstreamUrl = new URL(opts.upstream);
  } catch {
    throw new Error(`d402-proxy: --upstream is not a valid URL: ${JSON.stringify(opts.upstream)}`);
  }
  if (upstreamUrl.protocol !== "http:" && upstreamUrl.protocol !== "https:") {
    throw new Error(`d402-proxy: --upstream must be http(s), got ${upstreamUrl.protocol}`);
  }
  const upstreamBase = stripTrailingSlash(upstreamUrl.origin + upstreamUrl.pathname);

  const warn = opts.warn ?? ((line: string) => process.stderr.write(line + "\n"));
  const log = opts.log ?? ((line: string) => process.stderr.write(line + "\n"));
  const upstreamFetch = opts.fetch ?? globalThis.fetch;

  const port = opts.port ?? DEFAULT_PORT;
  const publicUrl = stripTrailingSlash(opts.publicUrl ?? `http://localhost:${port}`);
  const scope = opts.scope && opts.scope.length > 0 ? opts.scope.map((s) => (s === "/" ? "/" : stripTrailingSlash(s))) : ["/"];
  const open = (opts.open ?? []).map((p) => (p === "/" ? "/" : stripTrailingSlash(p)));

  let secret = opts.secret;
  if (!secret) {
    secret = randomBytes(32).toString("base64url");
    warn(
      "d402-proxy: no secret given (--secret or D402_SECRET); generated a random one. " +
        "Vouchers will not survive a restart. Set D402_SECRET in production.",
    );
  }

  let labels = opts.labels;
  if (!labels || labels.length === 0) {
    if (!opts.tasks) throw new Error("d402-proxy: --labels is required when there is no --tasks file to derive them from");
    labels = labelsFromTaskFile(opts.tasks);
    if (labels.length < 2) {
      throw new Error(
        `d402-proxy: --labels is required; only ${labels.length} distinct golden label(s) found in ${opts.tasks}`,
      );
    }
    warn(`d402-proxy: --labels not given; derived ${JSON.stringify(labels)} from the goldens in ${opts.tasks}`);
  }
  if (labels.length < 2) throw new Error("d402-proxy: --labels needs at least 2 labels");

  const d402 = createD402({
    sellerId: opts.sellerId ?? upstreamUrl.host,
    taskUrl: `${publicUrl}${WELL_KNOWN_TASKS_PATH}`,
    scope,
    tiers: opts.tiers && opts.tiers.length > 0 ? opts.tiers : DEFAULT_TIERS,
    secret,
    labels,
    instructions: opts.instructions,
    db: opts.db,
    bindVouchers: opts.bindVouchers,
    requireModelFamilies: opts.requireModelFamilies,
  });
  if (opts.tasks) d402.tasks.loadFile(opts.tasks);

  const isGated = (path: string): boolean => {
    if (path === WELL_KNOWN_PATH || path.startsWith(WELL_KNOWN_PATH + "/")) return false;
    if (path.startsWith("/.well-known/")) return false;
    if (open.length > 0 && pathMatches(open, path)) return false;
    return pathMatches(scope, path);
  };

  const app = new Hono();

  // -- request log ----------------------------------------------------------
  app.use("*", async (c, next) => {
    const start = performance.now();
    await next();
    const ms = Math.round(performance.now() - start);
    const path = c.req.path;
    const status = c.res.status;
    const kind = !isGated(path) ? "open" : status === 402 ? "402" : "paid";
    log(`${c.req.method} ${path} ${status} ${ms}ms ${kind}`);
  });

  // -- admin (proxy-only; the server package knows nothing about it) --------
  if (opts.adminToken) {
    const token = opts.adminToken;
    const requireAdmin: MiddlewareHandler = async (c, next) => {
      const auth = c.req.header("authorization") ?? "";
      const m = /^Bearer\s+(.+)$/i.exec(auth);
      if (!m || !safeEqual(m[1]!.trim(), token)) {
        return c.json({ error: "unauthorized", message: "Authorization: Bearer <admin token> is required" }, 401);
      }
      await next();
    };
    app.get(ADMIN_STATS_PATH, requireAdmin, (c) =>
      c.json({
        stats: d402.tasks.stats(),
        agents: d402.agents.list(),
        resolved: d402.tasks.exportResolved().length,
      }),
    );
    app.get(ADMIN_EXPORT_PATH, requireAdmin, (c) => {
      const lines = d402.tasks.exportResolved().map((item) => JSON.stringify(item));
      return c.body(lines.length ? lines.join("\n") + "\n" : "", 200, { "Content-Type": "application/x-ndjson" });
    });
  }

  // -- d402 offer + task routes --------------------------------------------
  app.route("/", d402.routes);

  // -- gate -----------------------------------------------------------------
  app.use("*", async (c, next) => {
    if (!isGated(c.req.path)) return next();
    return d402.gate(c, next);
  });

  // -- forward ----------------------------------------------------------------
  app.all("*", async (c) => {
    const incoming = new URL(c.req.url);
    const target = `${upstreamBase}${incoming.pathname}${incoming.search}`;

    const headers = new Headers();
    c.req.raw.headers.forEach((value, name) => {
      const n = name.toLowerCase();
      if (HOP_BY_HOP.has(n) || n === "host") return;
      headers.set(name, value);
    });
    // Drop headers that only mean something to this hop.
    headers.delete(HEADERS.voucher.toLowerCase());
    const ip = clientIp(c);
    const priorFor = headers.get("x-forwarded-for");
    if (ip) headers.set("x-forwarded-for", priorFor ? `${priorFor}, ${ip}` : ip);
    if (!headers.has("x-forwarded-proto")) headers.set("x-forwarded-proto", incoming.protocol.replace(/:$/, ""));
    if (!headers.has("x-forwarded-host")) headers.set("x-forwarded-host", c.req.header("host") ?? incoming.host);
    headers.set("via", "1.1 d402-proxy");

    const method = c.req.method;
    const hasBody = method !== "GET" && method !== "HEAD" && c.req.raw.body !== null;
    const init: RequestInit & { duplex?: "half" } = { method, headers, redirect: "manual" };
    if (hasBody) {
      init.body = c.req.raw.body;
      init.duplex = "half";
    }

    let upstream: Response;
    try {
      upstream = await upstreamFetch(target, init);
    } catch (e) {
      return c.json({ error: "bad_gateway", message: `upstream unreachable: ${(e as Error).message}` }, 502);
    }

    const out = new Headers();
    upstream.headers.forEach((value, name) => {
      if (HOP_BY_HOP.has(name.toLowerCase())) return;
      out.append(name, value);
    });
    // fetch() already decoded the body, so the encoding headers no longer describe it.
    if (out.has("content-encoding")) {
      out.delete("content-encoding");
      out.delete("content-length");
    }
    return c.newResponse(upstream.body, { status: upstream.status as StatusCode, headers: out });
  });

  return { app, d402 };
}

// ---------------------------------------------------------------------------
// parseArgs
// ---------------------------------------------------------------------------

export const USAGE = `usage: d402-proxy --upstream <url> [options]

  --upstream <url>            base URL of the API to gate (required)
  --tasks <file.jsonl>        classify task file loaded at boot (SPEC 10)
  --scope <prefix,...>        path prefixes to gate (default: everything except /.well-known and --open)
  --labels <a,b,...>          classify labels, at least 2 (default: derived from the task file's goldens)
  --seller-id <id>            sellerId in the offer (default: the upstream host)
  --public-url <url>          public base URL of this proxy, for taskUrl (default: http://localhost:<port>)
  --secret <s>                voucher HMAC secret (default: env D402_SECRET, else random with a warning)
  --port <n>                  listen port (default: 8787)
  --tier <id:items:tokens:calls>  a tier; repeatable (default: s:5:1000:10 m:25:5000:60 l:50:10000:150)
  --db <path>                 SQLite path (default: in memory)
  --bind-vouchers             SPEC 7.1: spends must be signed by the agent key
  --require-model-families    resolution needs votes from 2 model families
  --admin-token <t>           enable /.well-known/d402/admin/{stats,export} behind a bearer token
  --open <prefix,...>         path prefixes that are never gated, e.g. /health,/docs
  --instructions <text>       instructions shown in every bundle
  --config <file.json>        JSON file with the same keys in camelCase; flags override it
  -h, --help                  show this help`;

type ConfigFile = Partial<
  Omit<ProxyOptions, "tiers" | "scope" | "labels" | "open" | "log" | "warn" | "fetch"> & {
    tiers: Array<Tier | string>;
    scope: string[] | string;
    labels: string[] | string;
    open: string[] | string;
  }
>;

function list(v: string[] | string | undefined): string[] | undefined {
  if (v === undefined) return undefined;
  const arr = Array.isArray(v) ? v : v.split(",");
  const out = arr.map((s) => s.trim()).filter(Boolean);
  return out.length ? out : undefined;
}

const VALUE_FLAGS: Record<string, keyof ProxyOptions | "config"> = {
  "--upstream": "upstream",
  "--tasks": "tasks",
  "--scope": "scope",
  "--labels": "labels",
  "--seller-id": "sellerId",
  "--public-url": "publicUrl",
  "--secret": "secret",
  "--port": "port",
  "--tier": "tiers",
  "--db": "db",
  "--admin-token": "adminToken",
  "--open": "open",
  "--instructions": "instructions",
  "--config": "config",
};

const BOOL_FLAGS: Record<string, keyof ProxyOptions> = {
  "--bind-vouchers": "bindVouchers",
  "--require-model-families": "requireModelFamilies",
};

export class HelpRequested extends Error {
  constructor() {
    super(USAGE);
  }
}

/**
 * Parse CLI flags into ProxyOptions. `--config` is read first and flags
 * override it. Throws on an unknown flag, a missing value or a missing
 * --upstream. The secret falls back to env D402_SECRET.
 */
export function parseArgs(argv: string[], env: NodeJS.ProcessEnv = process.env): ProxyOptions {
  const flags: Record<string, string | string[] | boolean> = {};
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
    if (name in BOOL_FLAGS) {
      flags[BOOL_FLAGS[name]!] = inlineValue === undefined ? true : inlineValue !== "false";
      continue;
    }
    const key = VALUE_FLAGS[name];
    if (!key) throw new Error(`d402-proxy: unknown flag ${JSON.stringify(arg)}\n\n${USAGE}`);
    const value = inlineValue ?? argv[++i];
    if (value === undefined) throw new Error(`d402-proxy: ${name} needs a value`);
    if (key === "tiers") tiers.push(value);
    else flags[key] = value;
  }

  let config: ConfigFile = {};
  const configPath = flags["config"] as string | undefined;
  if (configPath) {
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(configPath, "utf8"));
    } catch (e) {
      throw new Error(`d402-proxy: could not read --config ${configPath}: ${(e as Error).message}`);
    }
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error(`d402-proxy: --config ${configPath} must contain a JSON object`);
    }
    config = raw as ConfigFile;
  }

  const str = (k: keyof ProxyOptions): string | undefined => {
    const v = flags[k];
    if (typeof v === "string") return v;
    const cv = (config as Record<string, unknown>)[k];
    return typeof cv === "string" ? cv : undefined;
  };
  const strList = (k: "scope" | "labels" | "open"): string[] | undefined => {
    const v = flags[k];
    if (typeof v === "string") return list(v);
    return list(config[k]);
  };
  const bool = (k: "bindVouchers" | "requireModelFamilies"): boolean | undefined => {
    const v = flags[k];
    if (typeof v === "boolean") return v;
    const cv = config[k];
    return typeof cv === "boolean" ? cv : undefined;
  };

  const upstream = str("upstream");
  if (!upstream) throw new Error(`d402-proxy: --upstream is required\n\n${USAGE}`);

  let port: number | undefined;
  const portRaw = flags["port"] ?? config.port;
  if (portRaw !== undefined) {
    port = Number(portRaw);
    if (!Number.isInteger(port) || port < 0 || port > 65535) {
      throw new Error(`d402-proxy: --port must be an integer in 0..65535, got ${JSON.stringify(portRaw)}`);
    }
  }

  let tierList: Tier[] | undefined;
  if (tiers.length) tierList = tiers.map(parseTier);
  else if (Array.isArray(config.tiers) && config.tiers.length) {
    tierList = config.tiers.map((t) => (typeof t === "string" ? parseTier(t) : t));
  }

  const out: ProxyOptions = { upstream };
  const set = <K extends keyof ProxyOptions>(k: K, v: ProxyOptions[K] | undefined) => {
    if (v !== undefined) out[k] = v;
  };
  set("tasks", str("tasks"));
  set("scope", strList("scope"));
  set("labels", strList("labels"));
  set("sellerId", str("sellerId"));
  set("publicUrl", str("publicUrl"));
  set("secret", str("secret") ?? (env.D402_SECRET || undefined));
  set("port", port);
  set("tiers", tierList);
  set("db", str("db"));
  set("bindVouchers", bool("bindVouchers"));
  set("requireModelFamilies", bool("requireModelFamilies"));
  set("adminToken", str("adminToken"));
  set("open", strList("open"));
  set("instructions", str("instructions"));
  return out;
}
