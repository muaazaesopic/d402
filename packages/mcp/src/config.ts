import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { createD402Client, FileVoucherCache, loadOrCreateKeypair, type D402Client } from "@d402/client";
import { createMcpServer, type McpServerOptions } from "./server.js";
import { createCommandSolver } from "./solver-cmd.js";

export type Env = Record<string, string | undefined>;

/** Expands a leading `~` and returns an absolute path. */
export function expandHome(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return resolve(p);
}

export interface ResolvedConfig {
  home: string;
  keypairPath: string;
  model?: string;
  tier?: string;
  solverCmd?: string;
}

/** Reads the d402 env variables and resolves paths. Creates the home dir if needed. */
export function resolveConfig(env: Env = process.env): ResolvedConfig {
  const home = expandHome(env.D402_HOME && env.D402_HOME.trim() !== "" ? env.D402_HOME : "~/.d402");
  mkdirSync(home, { recursive: true });
  return {
    home,
    keypairPath: join(home, "keypair.json"),
    model: env.D402_MODEL || undefined,
    tier: env.D402_TIER || undefined,
    solverCmd: env.D402_SOLVER_CMD || undefined,
  };
}

/**
 * Builds a `D402Client` from the environment:
 * - `D402_HOME` (default `~/.d402`): keypair at `$D402_HOME/keypair.json`, vouchers cached in `$D402_HOME`.
 * - `D402_MODEL`: model family sent as `D402-Model`.
 * - `D402_TIER`: default tier id (applied by the MCP server, not the client).
 *
 * The client is created without a solver on purpose: the MCP server decides when
 * to earn (`d402_fetch { autoEarn }` or the agent labelling a bundle itself).
 */
export function createClientFromEnv(env: Env = process.env): D402Client {
  const cfg = resolveConfig(env);
  const keypair = loadOrCreateKeypair(cfg.keypairPath);
  const cache = new FileVoucherCache(cfg.home);
  return createD402Client({ keypair, cache, model: cfg.model });
}

/** Everything `createMcpServer` needs, derived from the environment. */
export function serverOptionsFromEnv(env: Env = process.env): McpServerOptions {
  const cfg = resolveConfig(env);
  return {
    client: createClientFromEnv(env),
    defaultTier: cfg.tier,
    solver: cfg.solverCmd ? createCommandSolver(cfg.solverCmd, { env: env as NodeJS.ProcessEnv }) : undefined,
  };
}

export function createMcpServerFromEnv(env: Env = process.env) {
  return createMcpServer(serverOptionsFromEnv(env));
}
