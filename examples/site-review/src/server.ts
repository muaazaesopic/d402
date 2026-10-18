/**
 * Example seller: a product API paid for with agent work, through a job marketplace.
 * Inference can pay for anything; website review is one job on the board, next
 * to dataset labelling and document extraction, and posters can add more.
 *
 *   GET  /, /products, /cart, ...          the website under review (Acme Home)
 *   GET  /r/:sessionId                      starts a review session (cookie), then redirects to /
 *   GET  /api/products?q=...                gated: needs a D402-Voucher (earn one with any job)
 *   GET  /.well-known/d402                  the offer (same body as the 402): one tier per job
 *   GET  /.well-known/d402/tasks?tier=<job> take a job (D402-Key header)
 *   POST /.well-known/d402/tasks/:id        submit the signed result, get a voucher
 *   GET  /market                            the marketplace page
 *   GET  /market/jobs                       job listings as JSON (for agents)
 *   POST /market/jobs                       post a dataset job (Authorization: Bearer <admin token>)
 *   GET  /market/jobs/:id/results           a job's output so far (Authorization: Bearer <admin token>)
 *   GET  /dashboard?token=<admin token>     seller dashboard
 *   GET  /admin/state                       dashboard data (Authorization: Bearer <admin token>)
 *
 * Run: `pnpm --filter d402-example-site-review run start` (port 8788, env PORT).
 */
import { timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import type { Context } from "hono";
import { PRODUCTS, SessionStore, createSite } from "./site.js";
import { createReviewJob, type ReviewJob } from "./review.js";
import { createMarket, MarketError, MARKET_JOBS_PATH, MARKET_PATH, type Market } from "./market.js";
import { DatasetJobSpec, createDatasetJob } from "./dataset.js";
import { seedJobs } from "./catalog.js";
import { dashboardHtml } from "./dashboard.js";
import { marketHtml } from "./market-page.js";

export const DEFAULT_PORT = 8788;
export const SELLER_ID = "d402-example-site-review";
const DEV_SECRET = "dev-secret-do-not-use-in-production";
const DEMO_ADMIN_TOKEN = "demo";

export interface AppOptions {
  port?: number;
  /** Public base URL; default http://localhost:{port}. */
  baseUrl?: string;
  secret?: string;
  adminToken?: string;
  /** Delay of the planted slow page in ms (default 1500). */
  slowMs?: number;
  now?: () => number;
  random?: () => number;
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export function createApp(opts: AppOptions = {}): { app: Hono; market: Market; review: ReviewJob; sessions: SessionStore; port: number; baseUrl: string } {
  const port = opts.port ?? Number(process.env.PORT ?? DEFAULT_PORT);
  const baseUrl = (opts.baseUrl ?? `http://localhost:${port}`).replace(/\/+$/, "");
  let secret = opts.secret ?? process.env.D402_SECRET;
  if (!secret) {
    console.warn("[site-review] D402_SECRET is not set; using an insecure dev default.");
    secret = DEV_SECRET;
  }
  const adminToken = opts.adminToken ?? process.env.D402_ADMIN_TOKEN ?? DEMO_ADMIN_TOKEN;

  const sessions = new SessionStore(secret, opts.now);
  const app = new Hono();
  const market = createMarket({ sellerId: SELLER_ID, baseUrl, secret, now: opts.now, random: opts.random });
  const review = createReviewJob({ baseUrl, sessions, probe: async (path) => (await app.request(path)).status, now: opts.now });
  market.add(review.job);
  for (const spec of seedJobs()) market.add(createDatasetJob(spec));

  const authorized = (c: Context) => {
    const m = /^Bearer\s+(.+)$/i.exec(c.req.header("authorization") ?? "");
    return !!m && safeEqual(m[1]!.trim(), adminToken);
  };
  const unauthorized = (c: Context) => c.json({ error: "unauthorized" }, 401);

  app.get("/dashboard", (c) => c.html(dashboardHtml()));
  app.get("/admin/state", (c) => {
    if (!authorized(c)) return unauthorized(c);
    const r = review.state();
    const agents = market.agents();
    return c.json({
      sellerId: SELLER_ID,
      ...r,
      stats: { ...r.stats, agents: agents.length, blocked: agents.filter((a) => a.blocked).length },
      agents,
      jobs: market.listing(),
    });
  });

  app.get(MARKET_PATH, (c) => c.html(marketHtml()));
  app.post(MARKET_JOBS_PATH, async (c) => {
    if (!authorized(c)) return unauthorized(c);
    const spec = DatasetJobSpec.safeParse(await c.req.json().catch(() => null));
    if (!spec.success) return c.json({ error: "bad_request", message: spec.error.issues.map((i) => i.message).join("; ") }, 400);
    try {
      market.add(createDatasetJob(spec.data));
    } catch (e) {
      if (e instanceof MarketError) return c.json({ error: e.code, message: e.message }, e.status);
      throw e;
    }
    return c.json(market.listing().find((j) => j.id === spec.data.id), 201);
  });
  app.get(`${MARKET_JOBS_PATH}/:id/results`, (c) => {
    if (!authorized(c)) return unauthorized(c);
    const job = market.job(c.req.param("id"));
    if (!job) return c.json({ error: "not_found" }, 404);
    return c.json({ job: job.id, progress: job.progress(), results: job.results?.() ?? null });
  });

  app.route("/", market.routes);
  app.use("/api/*", market.gate);
  app.get("/api/products", (c) => {
    const q = (c.req.query("q") ?? "").toLowerCase();
    return c.json({ products: PRODUCTS.filter((p) => p.name.toLowerCase().includes(q) || p.blurb.toLowerCase().includes(q)) });
  });

  // The website goes last: it ends in a catch-all 404 page.
  app.route("/", createSite({ sessions, slowMs: opts.slowMs }));

  return { app, market, review, sessions, port, baseUrl };
}

const isMain = (() => {
  try {
    return process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1];
  } catch {
    return false;
  }
})();

if (isMain) {
  const { app, port } = createApp();
  serve({ fetch: app.fetch, port }, (info) => {
    console.log(`site-review listening on http://localhost:${info.port}`);
    console.log(`  website:   http://localhost:${info.port}/            (preview mode, no planted bugs)`);
    console.log(`  gated API: curl -i "http://localhost:${info.port}/api/products?q=lamp"`);
    console.log(`  market:    http://localhost:${info.port}/market            (every job that pays for the API)`);
    console.log(`  dashboard: http://localhost:${info.port}/dashboard?token=${process.env.D402_ADMIN_TOKEN ? "<D402_ADMIN_TOKEN>" : DEMO_ADMIN_TOKEN}`);
    console.log(`  agents:    pnpm --filter d402-example-site-review run demo`);
  });
}
