/**
 * Example seller: a tiny search API gated by d402.
 *
 *   GET /health               open
 *   GET /search?q=...         gated: needs a D402-Voucher (earn one by labelling)
 *   GET /.well-known/d402     the offer (same body as the 402)
 *   GET /.well-known/d402/tasks?tier=s|m|l   get a bundle
 *   POST /.well-known/d402/tasks/:bundleId   submit answers, get a voucher
 *
 * Run: `pnpm --filter d402-example-search-proxy run start` (port 8787, env PORT).
 */
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { createD402, type D402Server } from "@d402/server";
import type { Tier } from "@d402/spec";
import { LABELS, search } from "./corpus.js";

/** Tiers from SPEC section 3. */
export const TIERS: Tier[] = [
  { id: "s", items: 5, est_tokens: 1000, reward: { calls: 10 } },
  { id: "m", items: 25, est_tokens: 5000, reward: { calls: 60 } },
  { id: "l", items: 50, est_tokens: 10000, reward: { calls: 150 } },
];

export const DEFAULT_PORT = 8787;
const DEV_SECRET = "dev-secret-do-not-use-in-production";

/** The classify task file that ships with the example (300 items, 20% golden). */
export const TASKS_PATH = join(dirname(fileURLToPath(import.meta.url)), "..", "tasks.jsonl");

export interface AppOptions {
  /** sqlite path; default in-memory. */
  db?: string;
  /** Voucher HMAC secret; default env D402_SECRET or a dev default (with a warning). */
  secret?: string;
  /** Port used to build the absolute taskUrl; default env PORT or 8787. */
  port?: number;
  /** Public base URL for taskUrl; default http://localhost:{port}. */
  baseUrl?: string;
  /** Unix seconds; injectable for tests. */
  now?: () => number;
  /** Task file to load at boot; default ./tasks.jsonl next to the example. */
  tasksPath?: string;
  requireModelFamilies?: boolean;
}

export function createApp(opts: AppOptions = {}): { app: Hono; d402: D402Server; port: number } {
  const port = opts.port ?? Number(process.env.PORT ?? DEFAULT_PORT);
  const baseUrl = (opts.baseUrl ?? `http://localhost:${port}`).replace(/\/+$/, "");
  let secret = opts.secret ?? process.env.D402_SECRET;
  if (!secret) {
    console.warn("[search-proxy] D402_SECRET is not set; using an insecure dev default. Set D402_SECRET in production.");
    secret = DEV_SECRET;
  }

  const d402 = createD402({
    sellerId: "d402-example-search-proxy",
    taskUrl: `${baseUrl}/.well-known/d402/tasks`,
    scope: ["/search"],
    tiers: TIERS,
    secret,
    labels: [...LABELS],
    instructions: "Label each news snippet with exactly one of: sports, business, tech, world.",
    db: opts.db,
    now: opts.now,
    requireModelFamilies: opts.requireModelFamilies,
  });
  d402.tasks.loadFile(opts.tasksPath ?? TASKS_PATH);

  const app = new Hono();
  app.get("/health", (c) => c.json({ ok: true, ...d402.tasks.stats() }));
  app.route("/", d402.routes);
  app.use("/search", d402.gate);
  app.get("/search", (c) => {
    const q = c.req.query("q") ?? "";
    if (!q.trim()) return c.json({ error: "bad_request", message: "q is required" }, 400);
    return c.json({ hits: search(q) });
  });

  return { app, d402, port };
}

const isMain = (() => {
  try {
    return process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1];
  } catch {
    return false;
  }
})();

if (isMain) {
  const { app, d402, port } = createApp();
  serve({ fetch: app.fetch, port }, (info) => {
    const stats = d402.tasks.stats();
    console.log(`search-proxy listening on http://localhost:${info.port}`);
    console.log(`  pool: ${stats.total} items (${stats.golden} golden)`);
    console.log(`  offer: curl -s http://localhost:${info.port}/.well-known/d402`);
    console.log(`  gated: curl -i "http://localhost:${info.port}/search?q=ceasefire"`);
  });
}
