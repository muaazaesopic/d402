#!/usr/bin/env node
/**
 * `d402`: a small agent CLI over @d402/client.
 *
 *   d402 keygen                                  create $D402_HOME/keypair.json, print the public key
 *   d402 discover <baseUrl>                      print the seller's d402 accept as JSON
 *   d402 bundle <baseUrl> [--tier s]             fetch a bundle, print it, keep it in $D402_HOME/pending/
 *   d402 submit <bundleId> --answers a.json      sign and submit a pending bundle, print the voucher
 *   d402 earn <baseUrl> [--tier s] (--answers key.json | --solver-cmd "cmd")
 *   d402 fetch <url> [-X M] [-d body] [-H "K: V"]... [--auto-earn (--answers key.json | --solver-cmd "cmd")]
 *   d402 status                                  public key and cached vouchers
 *
 * Exit codes: 0 ok, 1 protocol error (`error: <code> <message>` on stderr), 2 usage.
 * Env: D402_HOME (default ~/.d402), D402_MODEL, D402_TIER.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  Answers as AnswersSchema,
  Bundle as BundleSchema,
  D402Accept as D402AcceptSchema,
  HEADERS,
  findD402Accept,
  signSpend,
  type Answers,
  type Bundle,
  type D402Accept,
  type Keypair,
} from "@d402/spec";
import { FileVoucherCache, type StoredVoucher } from "./cache.js";
import { createD402Client, smallestTier } from "./client.js";
import { D402Error } from "./errors.js";
import { loadOrCreateKeypair } from "./keypair.js";
import { createLookupSolver, type Solver } from "./solvers.js";

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

export interface CliIo {
  stdout: { write(chunk: string): unknown };
  stderr: { write(chunk: string): unknown };
  env: Record<string, string | undefined>;
  /** Transport for every HTTP request. Default: globalThis.fetch. */
  fetch?: typeof fetch;
  /** Unix seconds; injectable for tests. */
  now?: () => number;
}

export const USAGE = `usage: d402 <command> [options]

  keygen                                  create $D402_HOME/keypair.json and print the public key
  discover <baseUrl>                      print the seller's d402 accept as JSON
  bundle <baseUrl> [--tier <id>]          fetch a bundle; prints it and stores it under $D402_HOME/pending/
  submit <bundleId> --answers <file>      sign and submit a pending bundle; prints the voucher summary
  earn <baseUrl> [--tier <id>] (--answers <file> | --solver-cmd <cmd>)
                                          bundle -> solve -> submit in one go
  fetch <url> [-X <method>] [-d <body>] [-H "K: V"]...
        [--auto-earn (--answers <file> | --solver-cmd <cmd>)]
                                          spend a cached voucher (earn one first with --auto-earn)
  status                                  public key and cached vouchers

options
  --tier <id>          tier id (env D402_TIER; default: the smallest tier)
  --model <name>       model family sent as D402-Model (env D402_MODEL)
  --answers <file>     JSON { "<itemId>": "<label>" }; a missing id is an error
  --solver-cmd <cmd>   shell command: bundle JSON on stdin, { "<itemId>": "<label>" } JSON on stdout
  --home <dir>         state directory (env D402_HOME; default ~/.d402)

exit codes: 0 ok, 1 protocol error, 2 usage`;

/** Thrown for bad invocations; main() prints usage and returns 2. */
export class UsageError extends Error {}

/** Shape of `$D402_HOME/pending/<bundleId>.json`. */
export interface PendingBundle {
  version: 1;
  taskUrl: string;
  accept: D402Accept;
  bundle: Bundle;
  savedAt: number;
}

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

interface Parsed {
  positional: string[];
  flags: Record<string, string | boolean | string[]>;
}

const VALUE_FLAGS = new Set(["--tier", "--model", "--answers", "--solver-cmd", "--home", "-X", "-d", "-H"]);
const BOOL_FLAGS = new Set(["--auto-earn", "--help", "-h"]);
const REPEAT_FLAGS = new Set(["-H"]);

function parseArgs(argv: string[]): Parsed {
  const positional: string[] = [];
  const flags: Parsed["flags"] = {};
  for (let i = 0; i < argv.length; i++) {
    const raw = argv[i]!;
    if (raw === "--") {
      positional.push(...argv.slice(i + 1));
      break;
    }
    if (!raw.startsWith("-") || raw === "-") {
      positional.push(raw);
      continue;
    }
    let name = raw;
    let value: string | undefined;
    const eq = raw.indexOf("=");
    if (raw.startsWith("--") && eq !== -1) {
      name = raw.slice(0, eq);
      value = raw.slice(eq + 1);
    }
    if (BOOL_FLAGS.has(name)) {
      if (value !== undefined) throw new UsageError(`${name} takes no value`);
      flags[name] = true;
      continue;
    }
    if (!VALUE_FLAGS.has(name)) throw new UsageError(`unknown option ${name}`);
    if (value === undefined) {
      if (i + 1 >= argv.length) throw new UsageError(`${name} needs a value`);
      value = argv[++i]!;
    }
    if (REPEAT_FLAGS.has(name)) {
      const list = (flags[name] as string[] | undefined) ?? [];
      list.push(value);
      flags[name] = list;
    } else {
      flags[name] = value;
    }
  }
  return { positional, flags };
}

function str(flags: Parsed["flags"], name: string): string | undefined {
  const v = flags[name];
  return typeof v === "string" ? v : undefined;
}

// ---------------------------------------------------------------------------
// Solvers
// ---------------------------------------------------------------------------

function readJsonFile(path: string, what: string): unknown {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    throw new D402Error("bad_file", `could not read ${what} ${path}: ${(err as Error).message}`, { cause: err });
  }
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new D402Error("bad_file", `${what} ${path} is not valid JSON`, { cause: err });
  }
}

/** `--answers key.json`: `{ "<itemId>": "<label>" }`, every bundle item must be present. */
export function createAnswersFileSolver(path: string): Solver {
  const parsed = AnswersSchema.safeParse(readJsonFile(path, "answers file"));
  if (!parsed.success) {
    throw new D402Error("bad_file", `answers file ${path} must be a JSON object of { "<itemId>": "<label>" }`);
  }
  return createLookupSolver(parsed.data);
}

/**
 * `--solver-cmd "cmd"`: the bundle JSON goes to the command's stdin; the
 * command prints `{ "<itemId>": "<label>" }` (or `{ "answers": {...} }`) on
 * stdout. Same contract as the MCP package's D402_SOLVER_CMD.
 */
export function createCommandSolver(
  command: string,
  opts: { env?: Record<string, string | undefined>; timeoutMs?: number; stderr?: CliIo["stderr"] } = {},
): Solver {
  const timeoutMs = opts.timeoutMs ?? 120_000;
  return (bundle) =>
    new Promise<Answers>((resolve, reject) => {
      const child = spawn(command, {
        shell: true,
        stdio: ["pipe", "pipe", "pipe"],
        env: (opts.env ?? process.env) as NodeJS.ProcessEnv,
      });
      const out: Buffer[] = [];
      let settled = false;
      const fail = (code: string, message: string) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(new D402Error(code, message));
      };
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        fail("solver_timeout", `solver command timed out after ${timeoutMs}ms: ${command}`);
      }, timeoutMs);
      child.stdout.on("data", (c: Buffer) => out.push(c));
      child.stderr.on("data", (c: Buffer) => opts.stderr?.write(c.toString("utf8")));
      child.on("error", (err) => fail("solver_failed", `solver command failed to start: ${err.message}`));
      child.on("close", (code) => {
        if (settled) return;
        if (code !== 0) return fail("solver_failed", `solver command exited with code ${code}: ${command}`);
        const text = Buffer.concat(out).toString("utf8");
        let parsed: unknown;
        try {
          parsed = JSON.parse(text);
        } catch {
          return fail("solver_bad_output", `solver command did not print JSON answers on stdout: ${text.slice(0, 200)}`);
        }
        const candidate =
          parsed && typeof parsed === "object" && "answers" in (parsed as Record<string, unknown>)
            ? (parsed as { answers: unknown }).answers
            : parsed;
        const res = AnswersSchema.safeParse(candidate);
        if (!res.success) return fail("solver_bad_output", "solver command printed JSON that is not a { itemId: label } object");
        const missing = bundle.items.filter((it) => res.data[it.id] === undefined).map((it) => it.id);
        if (missing.length) return fail("solver_missing_answer", `solver command gave no answer for: ${missing.join(", ")}`);
        settled = true;
        clearTimeout(timer);
        resolve(res.data);
      });
      child.stdin.on("error", () => {
        /* the close handler reports the exit code */
      });
      child.stdin.end(JSON.stringify(bundle));
    });
}

function solverFromFlags(flags: Parsed["flags"], io: CliIo, required: boolean): Solver | undefined {
  const answers = str(flags, "--answers");
  const cmd = str(flags, "--solver-cmd");
  if (answers && cmd) throw new UsageError("use either --answers or --solver-cmd, not both");
  if (answers) return createAnswersFileSolver(answers);
  if (cmd) return createCommandSolver(cmd, { env: io.env, stderr: io.stderr });
  if (required) throw new UsageError("--answers <file> or --solver-cmd <cmd> is required");
  return undefined;
}

// ---------------------------------------------------------------------------
// State ($D402_HOME)
// ---------------------------------------------------------------------------

interface Ctx {
  io: CliIo;
  home: string;
  flags: Parsed["flags"];
  fetch: typeof fetch;
  now: () => number;
  model?: string;
  tier?: string;
}

function keypairPath(home: string): string {
  return join(home, "keypair.json");
}
function pendingDir(home: string): string {
  return join(home, "pending");
}
function pendingPath(home: string, bundleId: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(bundleId)) throw new D402Error("bad_bundle_id", `bundle id ${JSON.stringify(bundleId)} is not safe for a file name`);
  return join(pendingDir(home), `${bundleId}.json`);
}

function savePending(home: string, p: PendingBundle): string {
  const path = pendingPath(home, p.bundle.bundleId);
  mkdirSync(pendingDir(home), { recursive: true });
  writeFileSync(path, JSON.stringify(p, null, 2) + "\n", { mode: 0o600 });
  return path;
}

function loadPending(home: string, bundleId: string): PendingBundle {
  const path = pendingPath(home, bundleId);
  if (!existsSync(path)) {
    const known = existsSync(pendingDir(home)) ? readdirSync(pendingDir(home)).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5)) : [];
    throw new D402Error(
      "unknown_bundle",
      `no pending bundle ${bundleId} in ${pendingDir(home)}` + (known.length ? ` (pending: ${known.join(", ")})` : " (run d402 bundle first)"),
    );
  }
  const raw = readJsonFile(path, "pending bundle") as Partial<PendingBundle>;
  const bundle = BundleSchema.safeParse(raw?.bundle);
  const accept = D402AcceptSchema.safeParse(raw?.accept);
  if (!bundle.success || !accept.success || typeof raw.taskUrl !== "string") {
    throw new D402Error("bad_file", `pending bundle file ${path} is corrupt`);
  }
  return { version: 1, taskUrl: raw.taskUrl, accept: accept.data, bundle: bundle.data, savedAt: raw.savedAt ?? 0 };
}

function client(ctx: Ctx, solver?: Solver) {
  const keypair: Keypair = loadOrCreateKeypair(keypairPath(ctx.home));
  const c = createD402Client({
    keypair,
    solver,
    cache: new FileVoucherCache(ctx.home),
    model: ctx.model,
    tier: ctx.tier,
    fetch: ctx.fetch,
    now: ctx.now,
  });
  return c;
}

async function acceptFor(ctx: Ctx, baseUrl: string): Promise<D402Accept> {
  const c = client(ctx);
  const offer = await c.discover(baseUrl);
  const accept = findD402Accept(offer);
  if (!accept) throw new D402Error("bad_offer", `${baseUrl} offers no d402 scheme`, { body: offer });
  return accept;
}

function tierFor(ctx: Ctx, accept: D402Accept): string {
  const id = ctx.tier ?? smallestTier(accept);
  if (!accept.tiers.some((t) => t.id === id)) {
    throw new D402Error("bad_tier", `tier "${id}" is not offered by ${accept.sellerId} (tiers: ${accept.tiers.map((t) => t.id).join(", ")})`);
  }
  return id;
}

function voucherSummary(v: StoredVoucher): string {
  return JSON.stringify(
    { jti: v.jti, sellerId: v.sellerId, calls: v.calls, scope: v.scope, expiresAt: v.expiresAt, taskUrl: v.taskUrl },
    null,
    2,
  );
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

async function cmdKeygen(ctx: Ctx): Promise<number> {
  const path = keypairPath(ctx.home);
  const existed = existsSync(path);
  const kp = loadOrCreateKeypair(path);
  ctx.io.stderr.write(`${existed ? "keypair already exists at" : "wrote keypair to"} ${path}\n`);
  ctx.io.stdout.write(kp.publicKey + "\n");
  return 0;
}

async function cmdDiscover(ctx: Ctx, baseUrl: string): Promise<number> {
  const accept = await acceptFor(ctx, baseUrl);
  ctx.io.stdout.write(JSON.stringify(accept, null, 2) + "\n");
  return 0;
}

async function cmdBundle(ctx: Ctx, baseUrl: string): Promise<number> {
  const accept = await acceptFor(ctx, baseUrl);
  const tier = tierFor(ctx, accept);
  const bundle = await client(ctx).getBundle(accept.taskUrl, tier);
  const path = savePending(ctx.home, { version: 1, taskUrl: accept.taskUrl, accept, bundle, savedAt: ctx.now() });
  ctx.io.stderr.write(`saved pending bundle to ${path}\n`);
  ctx.io.stdout.write(JSON.stringify(bundle, null, 2) + "\n");
  return 0;
}

async function cmdSubmit(ctx: Ctx, bundleId: string): Promise<number> {
  const answersPath = str(ctx.flags, "--answers");
  if (!answersPath) throw new UsageError("submit needs --answers <file>");
  const pending = loadPending(ctx.home, bundleId);
  const answers = await createAnswersFileSolver(answersPath)(pending.bundle);
  const voucher = await client(ctx).submit(pending.taskUrl, pending.bundle, answers, pending.accept);
  try {
    unlinkSync(pendingPath(ctx.home, bundleId));
  } catch {
    // best effort
  }
  ctx.io.stdout.write(voucherSummary(voucher) + "\n");
  return 0;
}

async function cmdEarn(ctx: Ctx, baseUrl: string): Promise<number> {
  const solver = solverFromFlags(ctx.flags, ctx.io, true)!;
  const accept = await acceptFor(ctx, baseUrl);
  const tier = tierFor(ctx, accept);
  const voucher = await client(ctx, solver).earn(accept, tier);
  ctx.io.stdout.write(voucherSummary(voucher) + "\n");
  return 0;
}

const SHOWN_HEADERS = ["content-type", "content-length", HEADERS.callsRemaining.toLowerCase(), "retry-after"];

async function cmdFetch(ctx: Ctx, url: string): Promise<number> {
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    throw new UsageError(`not an absolute URL: ${url}`);
  }
  const method = (str(ctx.flags, "-X") ?? (str(ctx.flags, "-d") !== undefined ? "POST" : "GET")).toUpperCase();
  const body = str(ctx.flags, "-d");
  const headers = new Headers();
  for (const h of (ctx.flags["-H"] as string[] | undefined) ?? []) {
    const idx = h.indexOf(":");
    if (idx <= 0) throw new UsageError(`bad header ${JSON.stringify(h)}; expected "Name: value"`);
    headers.set(h.slice(0, idx).trim(), h.slice(idx + 1).trim());
  }
  if (body !== undefined && !headers.has("content-type")) headers.set("content-type", "application/json");
  const init: RequestInit = { method, headers, body };

  const autoEarn = ctx.flags["--auto-earn"] === true;
  if (!autoEarn && (str(ctx.flags, "--answers") || str(ctx.flags, "--solver-cmd"))) {
    throw new UsageError("--answers/--solver-cmd only apply with --auto-earn");
  }
  const solver = solverFromFlags(ctx.flags, ctx.io, autoEarn);

  let res: Response;
  if (autoEarn) {
    const c = client(ctx, solver);
    // discover() first so a cached voucher for this seller is attached on the first try
    await c.discover(target.origin).catch(() => undefined);
    res = await c.fetch(target.toString(), init);
  } else {
    // Spend only: attach the best cached voucher (if any) and send once.
    const keypair = loadOrCreateKeypair(keypairPath(ctx.home));
    const cache = new FileVoucherCache(ctx.home);
    let accept: D402Accept | undefined;
    try {
      accept = await acceptFor(ctx, target.origin);
    } catch {
      accept = undefined;
    }
    const voucher = accept ? await cache.find(accept.sellerId, target.pathname, ctx.now()) : undefined;
    if (voucher) {
      const ts = ctx.now();
      headers.set(HEADERS.voucher, voucher.token);
      headers.set(HEADERS.key, keypair.publicKey);
      headers.set(HEADERS.timestamp, String(ts));
      headers.set(HEADERS.sig, signSpend(keypair.privateKey, method, target.pathname, voucher.jti, ts));
    } else {
      ctx.io.stderr.write(`no cached voucher for ${target.origin}${target.pathname}; sending without one (use --auto-earn or d402 earn)\n`);
    }
    res = await ctx.fetch(target.toString(), init);
    const remaining = res.headers.get(HEADERS.callsRemaining);
    if (voucher && remaining !== null && Number.isFinite(Number(remaining))) await cache.setCalls(voucher.jti, Number(remaining));
  }

  const out = ctx.io.stdout;
  out.write(`HTTP ${res.status}${res.statusText ? " " + res.statusText : ""}\n`);
  for (const name of SHOWN_HEADERS) {
    const v = res.headers.get(name);
    if (v !== null) out.write(`${name}: ${v}\n`);
  }
  out.write("\n");
  const text = await res.text();
  out.write(text);
  if (text && !text.endsWith("\n")) out.write("\n");
  return 0;
}

async function cmdStatus(ctx: Ctx): Promise<number> {
  const path = keypairPath(ctx.home);
  const publicKey = existsSync(path) ? loadOrCreateKeypair(path).publicKey : null;
  const vouchers = await new FileVoucherCache(ctx.home).list();
  const now = ctx.now();
  const pending = existsSync(pendingDir(ctx.home))
    ? readdirSync(pendingDir(ctx.home)).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5))
    : [];
  ctx.io.stdout.write(
    JSON.stringify(
      {
        home: ctx.home,
        publicKey,
        vouchers: vouchers.map((v) => ({
          jti: v.jti,
          sellerId: v.sellerId,
          calls: v.calls,
          scope: v.scope,
          expiresAt: v.expiresAt,
          expired: v.expiresAt <= now,
        })),
        pending,
      },
      null,
      2,
    ) + "\n",
  );
  return 0;
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

export async function main(argv: string[], io: CliIo): Promise<number> {
  let parsed: Parsed;
  try {
    parsed = parseArgs(argv);
  } catch (err) {
    if (err instanceof UsageError) {
      io.stderr.write(`error: ${err.message}\n${USAGE}\n`);
      return 2;
    }
    throw err;
  }
  const { positional, flags } = parsed;
  const [command, ...rest] = positional;
  if (flags["--help"] === true || flags["-h"] === true) {
    io.stdout.write(USAGE + "\n");
    return 0;
  }
  if (!command) {
    io.stderr.write(USAGE + "\n");
    return 2;
  }

  const home = str(flags, "--home") ?? io.env.D402_HOME ?? join(io.env.HOME ?? homedir(), ".d402");
  const ctx: Ctx = {
    io,
    home,
    flags,
    fetch: io.fetch ?? ((input, init) => globalThis.fetch(input, init)),
    now: io.now ?? (() => Math.floor(Date.now() / 1000)),
    model: str(flags, "--model") ?? io.env.D402_MODEL,
    tier: str(flags, "--tier") ?? io.env.D402_TIER,
  };

  const need = (n: number, what: string): string[] => {
    if (rest.length < n) throw new UsageError(`${command} needs ${what}`);
    return rest;
  };

  try {
    switch (command) {
      case "keygen":
        return await cmdKeygen(ctx);
      case "discover":
        return await cmdDiscover(ctx, need(1, "<baseUrl>")[0]!);
      case "bundle":
        return await cmdBundle(ctx, need(1, "<baseUrl>")[0]!);
      case "submit":
        return await cmdSubmit(ctx, need(1, "<bundleId>")[0]!);
      case "earn":
        return await cmdEarn(ctx, need(1, "<baseUrl>")[0]!);
      case "fetch":
        return await cmdFetch(ctx, need(1, "<url>")[0]!);
      case "status":
        return await cmdStatus(ctx);
      default:
        throw new UsageError(`unknown command ${command}`);
    }
  } catch (err) {
    if (err instanceof UsageError) {
      io.stderr.write(`error: ${err.message}\n${USAGE}\n`);
      return 2;
    }
    if (err instanceof D402Error) {
      io.stderr.write(`error: ${err.code} ${err.message}\n`);
      return 1;
    }
    const e = err as Error;
    io.stderr.write(`error: internal ${e?.message ?? String(err)}\n`);
    return 1;
  }
}

// ---------------------------------------------------------------------------
// bin
// ---------------------------------------------------------------------------

const isMain = (() => {
  try {
    const entry = process.argv[1];
    return !!entry && import.meta.url === pathToFileURL(realpathSync(entry)).href;
  } catch {
    return false;
  }
})();

if (isMain) {
  // `d402 fetch ... | head` closes stdout early; that is not an error.
  process.stdout.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EPIPE") process.exit(0);
    throw err;
  });
  main(process.argv.slice(2), { stdout: process.stdout, stderr: process.stderr, env: process.env }).then(
    (code) => {
      process.exitCode = code;
    },
    (err) => {
      process.stderr.write(`error: internal ${(err as Error)?.message ?? String(err)}\n`);
      process.exitCode = 1;
    },
  );
}
