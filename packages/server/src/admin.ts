import { Hono } from "hono";
import type { Context, MiddlewareHandler } from "hono";
import { WELL_KNOWN_PATH } from "@d402/spec";
import { SqliteStore, type PoolStats, type ResolvedItem, type Store } from "./store.js";
import { isBlocked } from "./trust.js";
import type { AgentRecord } from "./index.js";

/**
 * Seller admin endpoints, mounted under `/.well-known/d402/admin/*` when
 * `adminToken` is set on the server options. Every route needs
 * `Authorization: Bearer <adminToken>`.
 *
 *   GET /.well-known/d402/admin/stats          { stats, agents, resolvedCount, now }
 *   GET /.well-known/d402/admin/export         resolved items as JSONL (application/x-ndjson)
 *   GET /.well-known/d402/admin/agents         AgentRecord[]
 *   GET /.well-known/d402/admin/events?since=  the last 200 events, oldest first
 *
 * Events are not recorded as they happen: they are derived on each request from
 * the store (bundles, vouchers, answers, items, agents), so nothing in the
 * grading path had to change. See `deriveAdminEvents` for what can and cannot
 * be reconstructed that way.
 */

export const ADMIN_PATH = `${WELL_KNOWN_PATH}/admin` as const;
export const ADMIN_EVENT_LIMIT = 200;

export type AdminEventType =
  | "bundle_issued"
  | "bundle_passed"
  | "bundle_failed"
  | "voucher_issued"
  | "item_resolved"
  | "agent_blocked";

export interface AdminEvent {
  /** Unix seconds. */
  t: number;
  type: AdminEventType;
  /** Agent public key. */
  key?: string;
  bundleId?: string;
  itemId?: string;
  tier?: string;
  jti?: string;
  /** Calls left on a freshly issued voucher. */
  calls?: number;
  /** Winning answer of a resolved item. */
  answer?: string;
  /** Distinct keys behind a resolution. */
  voters?: number;
}

export interface AdminStatsBody {
  stats: PoolStats;
  agents: AgentRecord[];
  resolvedCount: number;
  now: number;
}

export interface AdminRouteDeps {
  /** The bearer token every admin request must carry. */
  token: string;
  store: Store;
  now: () => number;
  /** Needed to date vouchers: they only store `exp`, and `iat = exp - voucherTtl`. */
  voucherTtl: number;
  stats: () => PoolStats;
  exportResolved: () => ResolvedItem[];
  listAgents: () => AgentRecord[];
}

// ---------------------------------------------------------------------------
// Event derivation
// ---------------------------------------------------------------------------

/** Sort order for events that share a timestamp, in the order they happen in the protocol. */
const TYPE_ORDER: Record<AdminEventType, number> = {
  bundle_issued: 0,
  bundle_passed: 1,
  bundle_failed: 1,
  voucher_issued: 2,
  item_resolved: 3,
  agent_blocked: 4,
};

type Row = Record<string, unknown>;
const num = (v: unknown): number => (typeof v === "bigint" ? Number(v) : (v as number));

/**
 * Rebuild the recent event stream from the store's tables.
 *
 * What is derived from where (and the limits of doing it after the fact):
 * - `bundle_issued`: `bundles.issued_at`.
 * - `bundle_passed` / `bundle_failed`: `bundles.submitted_at`. A bundle counts
 *   as passed when it has votes in `answers` or a voucher for the same key
 *   whose `exp` equals `submitted_at + voucherTtl`; otherwise failed.
 * - `voucher_issued`: `vouchers`, dated as `exp - voucherTtl`, with the calls
 *   left *now* (spends are not logged, so there is no `voucher_spent` event).
 * - `item_resolved`: dated by the latest submitted bundle that voted for the
 *   winning answer. Items have no resolved_at column, so a vote that landed
 *   after the resolution (from a bundle issued before it) can push the time
 *   later.
 * - `agent_blocked`: agents that are blocked now, dated by their last submission.
 *
 * Only `SqliteStore` is supported for the table-backed events; another Store
 * yields just the `agent_blocked` events.
 */
export function deriveAdminEvents(
  store: Store,
  opts: { voucherTtl: number; since?: number; limit?: number },
): AdminEvent[] {
  const limit = opts.limit ?? ADMIN_EVENT_LIMIT;
  const since = opts.since ?? 0;
  const events: AdminEvent[] = [];

  if (store instanceof SqliteStore) {
    const db = store.db;
    const all = (sql: string, ...params: Array<string | number>) => db.prepare(sql).all(...params) as Row[];

    for (const r of all(
      `SELECT bundle_id, agent, tier, issued_at FROM bundles
        WHERE issued_at >= ? ORDER BY issued_at DESC LIMIT ?`,
      since,
      limit,
    )) {
      events.push({
        t: num(r.issued_at),
        type: "bundle_issued",
        key: r.agent as string,
        bundleId: r.bundle_id as string,
        tier: r.tier as string,
      });
    }

    for (const r of all(
      `SELECT b.bundle_id, b.agent, b.tier, b.submitted_at,
              (SELECT COUNT(*) FROM answers a WHERE a.bundle_id = b.bundle_id) AS votes,
              EXISTS(SELECT 1 FROM vouchers v WHERE v.sub = b.agent AND v.exp = b.submitted_at + ?) AS voucher
         FROM bundles b
        WHERE b.submitted_at IS NOT NULL AND b.submitted_at >= ?
        ORDER BY b.submitted_at DESC LIMIT ?`,
      opts.voucherTtl,
      since,
      limit,
    )) {
      const passed = num(r.votes) > 0 || num(r.voucher) === 1;
      events.push({
        t: num(r.submitted_at),
        type: passed ? "bundle_passed" : "bundle_failed",
        key: r.agent as string,
        bundleId: r.bundle_id as string,
        tier: r.tier as string,
      });
    }

    for (const r of all(
      `SELECT jti, sub, calls_left, exp FROM vouchers WHERE exp - ? >= ? ORDER BY exp DESC LIMIT ?`,
      opts.voucherTtl,
      since,
      limit,
    )) {
      events.push({
        t: num(r.exp) - opts.voucherTtl,
        type: "voucher_issued",
        key: r.sub as string,
        jti: r.jti as string,
        calls: num(r.calls_left),
      });
    }

    for (const r of all(
      `SELECT i.id, i.resolved, MAX(b.submitted_at) AS t, COUNT(DISTINCT a.agent) AS voters
         FROM items i
         JOIN answers a ON a.item_id = i.id AND a.answer = i.resolved
         JOIN bundles b ON b.bundle_id = a.bundle_id
        WHERE i.golden IS NULL AND i.resolved IS NOT NULL
        GROUP BY i.id
       HAVING t >= ?
        ORDER BY t DESC LIMIT ?`,
      since,
      limit,
    )) {
      events.push({
        t: num(r.t),
        type: "item_resolved",
        itemId: r.id as string,
        answer: r.resolved as string,
        voters: num(r.voters),
      });
    }
  }

  for (const a of store.listAgents()) {
    if (!isBlocked(a)) continue;
    let t = 0;
    if (store instanceof SqliteStore) {
      const r = store.db
        .prepare("SELECT MAX(submitted_at) AS t FROM bundles WHERE agent = ? AND submitted_at IS NOT NULL")
        .get(a.publicKey) as Row | undefined;
      if (r?.t != null) t = num(r.t);
    }
    if (t < since) continue;
    events.push({ t, type: "agent_blocked", key: a.publicKey });
  }

  events.sort(
    (x, y) =>
      x.t - y.t ||
      TYPE_ORDER[x.type] - TYPE_ORDER[y.type] ||
      (x.bundleId ?? x.jti ?? x.itemId ?? x.key ?? "").localeCompare(y.bundleId ?? y.jti ?? y.itemId ?? y.key ?? ""),
  );
  return events.length > limit ? events.slice(events.length - limit) : events;
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

function bearer(c: Context): string | undefined {
  const h = c.req.header("authorization");
  if (!h) return undefined;
  const m = /^Bearer\s+(.+)$/i.exec(h.trim());
  return m ? m[1]!.trim() : undefined;
}

/** Constant-time string compare so the token cannot be guessed byte by byte. */
function tokenMatches(given: string | undefined, expected: string): boolean {
  if (given === undefined) return false;
  const a = Buffer.from(given, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

export function createAdminRoutes(deps: AdminRouteDeps): Hono {
  if (!deps.token) throw new Error("d402: adminToken must be a non-empty string");
  const admin = new Hono();

  const auth: MiddlewareHandler = async (c, next) => {
    if (!tokenMatches(bearer(c), deps.token)) {
      c.header("WWW-Authenticate", 'Bearer realm="d402 admin"');
      return c.json({ error: "unauthorized" }, 401);
    }
    c.header("Cache-Control", "no-store");
    await next();
  };
  admin.use(`${ADMIN_PATH}/*`, auth);

  admin.get(`${ADMIN_PATH}/stats`, (c) => {
    const stats = deps.stats();
    const body: AdminStatsBody = {
      stats,
      agents: deps.listAgents(),
      resolvedCount: stats.resolved,
      now: deps.now(),
    };
    return c.json(body);
  });

  admin.get(`${ADMIN_PATH}/export`, (c) => {
    const lines = deps.exportResolved().map((item) => JSON.stringify(item));
    const body = lines.length ? lines.join("\n") + "\n" : "";
    return c.body(body, 200, { "Content-Type": "application/x-ndjson; charset=utf-8" });
  });

  admin.get(`${ADMIN_PATH}/agents`, (c) => c.json(deps.listAgents()));

  admin.get(`${ADMIN_PATH}/events`, (c) => {
    const raw = c.req.query("since");
    let since = 0;
    if (raw !== undefined && raw !== "") {
      since = Number(raw);
      if (!Number.isFinite(since) || since < 0) {
        return c.json({ error: "bad_request", message: "since must be a unix timestamp" }, 400);
      }
    }
    const events = deriveAdminEvents(deps.store, { voucherTtl: deps.voucherTtl, since, limit: ADMIN_EVENT_LIMIT });
    return c.json({ events, now: deps.now() });
  });

  return admin;
}
