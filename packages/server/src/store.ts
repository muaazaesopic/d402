import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { TaskFileItem } from "@d402/spec";
import { accuracy, isBlocked } from "./trust.js";

// ---------------------------------------------------------------------------
// Row types
// ---------------------------------------------------------------------------

export interface AgentRow {
  publicKey: string;
  goldenSeen: number;
  goldenCorrect: number;
  bundles: number;
  model: string | null;
}

export interface ItemRow {
  id: string;
  text: string;
  /** Known answer when this is a control item, otherwise null. */
  golden: string | null;
  exposures: number;
  retired: boolean;
  /** Winning answer once resolved (unknown items only). */
  resolved: string | null;
}

export interface BundleItemRef {
  id: string;
  golden: boolean;
}

export interface BundleRow {
  bundleId: string;
  agent: string;
  tier: string;
  ip: string;
  issuedAt: number;
  expiresAt: number;
  submittedAt: number | null;
  /** Items in the order they were handed to the agent. */
  items: BundleItemRef[];
}

export interface VoteRow {
  itemId: string;
  agent: string;
  answer: string;
  weight: number;
  bundleId: string;
  model: string | null;
}

export interface VoucherRow {
  jti: string;
  sub: string;
  scope: string[];
  callsLeft: number;
  exp: number;
}

export interface PoolStats {
  total: number;
  golden: number;
  unknownOpen: number;
  resolved: number;
  retiredGolden: number;
  agents: number;
  blockedAgents: number;
  openBundles: number;
  vouchers: number;
}

export interface ResolvedItem {
  id: string;
  text: string;
  answer: string;
  /** Sum of vote weights on the winning answer. */
  weight: number;
  /** Distinct keys that voted for the winning answer. */
  voters: number;
}

// ---------------------------------------------------------------------------
// Store interface (so another backend, e.g. Postgres, can be added later)
// ---------------------------------------------------------------------------

export interface Store {
  // items / pool
  insertItems(items: TaskFileItem[]): number;
  getItem(id: string): ItemRow | undefined;
  /** Goldens that are not retired (exposures < max). */
  liveGoldens(): ItemRow[];
  /**
   * Unresolved unknown items the agent has not already been handed in a
   * submitted or still-open bundle, fewest votes first.
   */
  unknownCandidates(agent: string, now: number, limit: number): ItemRow[];
  /** Bump exposures; a golden reaching maxExposures is retired. */
  recordGoldenExposures(ids: string[], maxExposures: number): void;
  itemVotes(itemId: string): VoteRow[];
  resolveItem(id: string, answer: string): void;
  exportResolved(): ResolvedItem[];
  stats(now: number): PoolStats;

  // agents
  getAgent(publicKey: string): AgentRow | undefined;
  ensureAgent(publicKey: string, model?: string | null): AgentRow;
  updateAgent(row: AgentRow): void;
  listAgents(): AgentRow[];

  // bundles
  insertBundle(bundle: BundleRow): void;
  getBundle(bundleId: string): BundleRow | undefined;
  markSubmitted(bundleId: string, at: number): void;
  countBundlesByKeySince(publicKey: string, since: number): number;
  countBundlesByIpSince(ip: string, since: number): number;
  oldestBundleByKeySince(publicKey: string, since: number): number | undefined;
  oldestBundleByIpSince(ip: string, since: number): number | undefined;
  countOpenBundles(publicKey: string, now: number): number;
  earliestOpenExpiry(publicKey: string, now: number): number | undefined;

  // votes
  insertVotes(votes: VoteRow[]): void;

  // vouchers
  insertVoucher(v: VoucherRow): void;
  getVoucher(jti: string): VoucherRow | undefined;
  /** Atomic decrement. Returns calls left after the spend, or undefined if none were left. */
  spendVoucher(jti: string): number | undefined;

  transaction<T>(fn: () => T): T;
  close(): void;
}

// ---------------------------------------------------------------------------
// SQLite implementation (node:sqlite, built in to Node 22)
// ---------------------------------------------------------------------------

const SCHEMA = `
CREATE TABLE IF NOT EXISTS agents (
  public_key     TEXT PRIMARY KEY,
  golden_seen    INTEGER NOT NULL DEFAULT 0,
  golden_correct INTEGER NOT NULL DEFAULT 0,
  bundles        INTEGER NOT NULL DEFAULT 0,
  model          TEXT
);
CREATE TABLE IF NOT EXISTS items (
  id        TEXT PRIMARY KEY,
  type      TEXT NOT NULL DEFAULT 'classify',
  text      TEXT NOT NULL,
  golden    TEXT,
  exposures INTEGER NOT NULL DEFAULT 0,
  retired   INTEGER NOT NULL DEFAULT 0,
  resolved  TEXT
);
CREATE INDEX IF NOT EXISTS items_golden_live ON items (golden, retired) WHERE golden IS NOT NULL;
CREATE INDEX IF NOT EXISTS items_unknown_open ON items (resolved) WHERE golden IS NULL;
CREATE TABLE IF NOT EXISTS bundles (
  bundle_id    TEXT PRIMARY KEY,
  agent        TEXT NOT NULL,
  tier         TEXT NOT NULL,
  ip           TEXT NOT NULL,
  issued_at    INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL,
  submitted_at INTEGER
);
CREATE INDEX IF NOT EXISTS bundles_agent_issued ON bundles (agent, issued_at);
CREATE INDEX IF NOT EXISTS bundles_ip_issued ON bundles (ip, issued_at);
CREATE TABLE IF NOT EXISTS bundle_items (
  bundle_id TEXT NOT NULL,
  item_id   TEXT NOT NULL,
  golden    INTEGER NOT NULL,
  position  INTEGER NOT NULL,
  PRIMARY KEY (bundle_id, item_id)
);
CREATE INDEX IF NOT EXISTS bundle_items_item ON bundle_items (item_id);
CREATE TABLE IF NOT EXISTS answers (
  item_id   TEXT NOT NULL,
  agent     TEXT NOT NULL,
  answer    TEXT NOT NULL,
  weight    REAL NOT NULL,
  bundle_id TEXT NOT NULL,
  model     TEXT,
  PRIMARY KEY (item_id, agent)
);
CREATE INDEX IF NOT EXISTS answers_item ON answers (item_id);
CREATE TABLE IF NOT EXISTS vouchers (
  jti        TEXT PRIMARY KEY,
  sub        TEXT NOT NULL,
  scope      TEXT NOT NULL,
  calls_left INTEGER NOT NULL,
  exp        INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS vouchers_sub ON vouchers (sub);
`;

type Row = Record<string, unknown>;

function num(v: unknown): number {
  return typeof v === "bigint" ? Number(v) : (v as number);
}

export class SqliteStore implements Store {
  readonly db: DatabaseSync;

  constructor(path: string = ":memory:") {
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
    this.db.exec(SCHEMA);
  }

  private all(sql: string, ...params: SQLInputValue[]): Row[] {
    return this.db.prepare(sql).all(...params) as Row[];
  }
  private get(sql: string, ...params: SQLInputValue[]): Row | undefined {
    return this.db.prepare(sql).get(...params) as Row | undefined;
  }
  private run(sql: string, ...params: SQLInputValue[]): number {
    return num(this.db.prepare(sql).run(...params).changes);
  }

  // -- items ---------------------------------------------------------------

  insertItems(items: TaskFileItem[]): number {
    const stmt = this.db.prepare(
      "INSERT OR IGNORE INTO items (id, type, text, golden) VALUES (?, ?, ?, ?)",
    );
    return this.transaction(() => {
      let n = 0;
      for (const it of items) {
        const parsed = TaskFileItem.parse(it);
        n += num(stmt.run(parsed.id, parsed.type, parsed.text, parsed.golden ?? null).changes);
      }
      return n;
    });
  }

  getItem(id: string): ItemRow | undefined {
    const r = this.get("SELECT * FROM items WHERE id = ?", id);
    return r ? toItem(r) : undefined;
  }

  liveGoldens(): ItemRow[] {
    return this.all(
      "SELECT * FROM items WHERE golden IS NOT NULL AND retired = 0 ORDER BY id",
    ).map(toItem);
  }

  unknownCandidates(agent: string, now: number, limit: number): ItemRow[] {
    return this.all(
      `SELECT i.*, (SELECT COUNT(*) FROM answers a WHERE a.item_id = i.id) AS votes
         FROM items i
        WHERE i.golden IS NULL AND i.resolved IS NULL
          AND i.id NOT IN (
            SELECT bi.item_id FROM bundle_items bi
              JOIN bundles b ON b.bundle_id = bi.bundle_id
             WHERE b.agent = ? AND (b.submitted_at IS NOT NULL OR b.expires_at > ?)
          )
        ORDER BY votes ASC, i.id ASC
        LIMIT ?`,
      agent,
      now,
      limit,
    ).map(toItem);
  }

  recordGoldenExposures(ids: string[], maxExposures: number): void {
    const stmt = this.db.prepare(
      `UPDATE items SET exposures = exposures + 1,
                        retired = CASE WHEN exposures + 1 >= ? THEN 1 ELSE retired END
        WHERE id = ? AND golden IS NOT NULL`,
    );
    for (const id of ids) stmt.run(maxExposures, id);
  }

  itemVotes(itemId: string): VoteRow[] {
    return this.all("SELECT * FROM answers WHERE item_id = ?", itemId).map(toVote);
  }

  resolveItem(id: string, answer: string): void {
    this.run("UPDATE items SET resolved = ? WHERE id = ? AND golden IS NULL", answer, id);
  }

  exportResolved(): ResolvedItem[] {
    return this.all(
      `SELECT i.id, i.text, i.resolved AS answer,
              COALESCE((SELECT SUM(weight) FROM answers a WHERE a.item_id = i.id AND a.answer = i.resolved), 0) AS weight,
              (SELECT COUNT(DISTINCT agent) FROM answers a WHERE a.item_id = i.id AND a.answer = i.resolved) AS voters
         FROM items i
        WHERE i.golden IS NULL AND i.resolved IS NOT NULL
        ORDER BY i.id`,
    ).map((r) => ({
      id: r.id as string,
      text: r.text as string,
      answer: r.answer as string,
      weight: num(r.weight),
      voters: num(r.voters),
    }));
  }

  stats(now: number): PoolStats {
    const c = (sql: string, ...p: SQLInputValue[]) => num(this.get(sql, ...p)!.n);
    const agents = this.listAgents();
    return {
      total: c("SELECT COUNT(*) AS n FROM items"),
      golden: c("SELECT COUNT(*) AS n FROM items WHERE golden IS NOT NULL"),
      unknownOpen: c("SELECT COUNT(*) AS n FROM items WHERE golden IS NULL AND resolved IS NULL"),
      resolved: c("SELECT COUNT(*) AS n FROM items WHERE golden IS NULL AND resolved IS NOT NULL"),
      retiredGolden: c("SELECT COUNT(*) AS n FROM items WHERE golden IS NOT NULL AND retired = 1"),
      agents: agents.length,
      blockedAgents: agents.filter(isBlocked).length,
      openBundles: c(
        "SELECT COUNT(*) AS n FROM bundles WHERE submitted_at IS NULL AND expires_at > ?",
        now,
      ),
      vouchers: c("SELECT COUNT(*) AS n FROM vouchers"),
    };
  }

  // -- agents --------------------------------------------------------------

  getAgent(publicKey: string): AgentRow | undefined {
    const r = this.get("SELECT * FROM agents WHERE public_key = ?", publicKey);
    return r ? toAgent(r) : undefined;
  }

  ensureAgent(publicKey: string, model?: string | null): AgentRow {
    this.run(
      `INSERT INTO agents (public_key, model) VALUES (?, ?)
       ON CONFLICT(public_key) DO UPDATE SET model = COALESCE(excluded.model, agents.model)`,
      publicKey,
      model ?? null,
    );
    return this.getAgent(publicKey)!;
  }

  updateAgent(row: AgentRow): void {
    this.run(
      `UPDATE agents SET golden_seen = ?, golden_correct = ?, bundles = ?, model = ?
        WHERE public_key = ?`,
      row.goldenSeen,
      row.goldenCorrect,
      row.bundles,
      row.model,
      row.publicKey,
    );
  }

  listAgents(): AgentRow[] {
    return this.all("SELECT * FROM agents ORDER BY public_key").map(toAgent);
  }

  // -- bundles -------------------------------------------------------------

  insertBundle(b: BundleRow): void {
    this.transaction(() => {
      this.run(
        `INSERT INTO bundles (bundle_id, agent, tier, ip, issued_at, expires_at, submitted_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        b.bundleId,
        b.agent,
        b.tier,
        b.ip,
        b.issuedAt,
        b.expiresAt,
        b.submittedAt,
      );
      const stmt = this.db.prepare(
        "INSERT INTO bundle_items (bundle_id, item_id, golden, position) VALUES (?, ?, ?, ?)",
      );
      b.items.forEach((it, i) => stmt.run(b.bundleId, it.id, it.golden ? 1 : 0, i));
    });
  }

  getBundle(bundleId: string): BundleRow | undefined {
    const r = this.get("SELECT * FROM bundles WHERE bundle_id = ?", bundleId);
    if (!r) return undefined;
    const items = this.all(
      "SELECT item_id, golden FROM bundle_items WHERE bundle_id = ? ORDER BY position",
      bundleId,
    ).map((x) => ({ id: x.item_id as string, golden: num(x.golden) === 1 }));
    return {
      bundleId: r.bundle_id as string,
      agent: r.agent as string,
      tier: r.tier as string,
      ip: r.ip as string,
      issuedAt: num(r.issued_at),
      expiresAt: num(r.expires_at),
      submittedAt: r.submitted_at == null ? null : num(r.submitted_at),
      items,
    };
  }

  markSubmitted(bundleId: string, at: number): void {
    this.run("UPDATE bundles SET submitted_at = ? WHERE bundle_id = ?", at, bundleId);
  }

  countBundlesByKeySince(publicKey: string, since: number): number {
    return num(
      this.get("SELECT COUNT(*) AS n FROM bundles WHERE agent = ? AND issued_at > ?", publicKey, since)!.n,
    );
  }
  countBundlesByIpSince(ip: string, since: number): number {
    return num(this.get("SELECT COUNT(*) AS n FROM bundles WHERE ip = ? AND issued_at > ?", ip, since)!.n);
  }
  oldestBundleByKeySince(publicKey: string, since: number): number | undefined {
    const r = this.get(
      "SELECT MIN(issued_at) AS t FROM bundles WHERE agent = ? AND issued_at > ?",
      publicKey,
      since,
    );
    return r?.t == null ? undefined : num(r.t);
  }
  oldestBundleByIpSince(ip: string, since: number): number | undefined {
    const r = this.get("SELECT MIN(issued_at) AS t FROM bundles WHERE ip = ? AND issued_at > ?", ip, since);
    return r?.t == null ? undefined : num(r.t);
  }
  countOpenBundles(publicKey: string, now: number): number {
    return num(
      this.get(
        "SELECT COUNT(*) AS n FROM bundles WHERE agent = ? AND submitted_at IS NULL AND expires_at > ?",
        publicKey,
        now,
      )!.n,
    );
  }
  earliestOpenExpiry(publicKey: string, now: number): number | undefined {
    const r = this.get(
      "SELECT MIN(expires_at) AS t FROM bundles WHERE agent = ? AND submitted_at IS NULL AND expires_at > ?",
      publicKey,
      now,
    );
    return r?.t == null ? undefined : num(r.t);
  }

  // -- votes ---------------------------------------------------------------

  insertVotes(votes: VoteRow[]): void {
    const stmt = this.db.prepare(
      `INSERT OR REPLACE INTO answers (item_id, agent, answer, weight, bundle_id, model)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    for (const v of votes) stmt.run(v.itemId, v.agent, v.answer, v.weight, v.bundleId, v.model);
  }

  // -- vouchers ------------------------------------------------------------

  insertVoucher(v: VoucherRow): void {
    this.run(
      "INSERT INTO vouchers (jti, sub, scope, calls_left, exp) VALUES (?, ?, ?, ?, ?)",
      v.jti,
      v.sub,
      JSON.stringify(v.scope),
      v.callsLeft,
      v.exp,
    );
  }

  getVoucher(jti: string): VoucherRow | undefined {
    const r = this.get("SELECT * FROM vouchers WHERE jti = ?", jti);
    if (!r) return undefined;
    return {
      jti: r.jti as string,
      sub: r.sub as string,
      scope: JSON.parse(r.scope as string) as string[],
      callsLeft: num(r.calls_left),
      exp: num(r.exp),
    };
  }

  spendVoucher(jti: string): number | undefined {
    const r = this.get(
      "UPDATE vouchers SET calls_left = calls_left - 1 WHERE jti = ? AND calls_left > 0 RETURNING calls_left",
      jti,
    );
    return r ? num(r.calls_left) : undefined;
  }

  // -- misc ----------------------------------------------------------------

  transaction<T>(fn: () => T): T {
    if (this.db.isTransaction) return fn();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const out = fn();
      this.db.exec("COMMIT");
      return out;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  close(): void {
    if (this.db.isOpen) this.db.close();
  }
}

function toItem(r: Row): ItemRow {
  return {
    id: r.id as string,
    text: r.text as string,
    golden: (r.golden as string | null) ?? null,
    exposures: num(r.exposures),
    retired: num(r.retired) === 1,
    resolved: (r.resolved as string | null) ?? null,
  };
}

function toAgent(r: Row): AgentRow {
  return {
    publicKey: r.public_key as string,
    goldenSeen: num(r.golden_seen),
    goldenCorrect: num(r.golden_correct),
    bundles: num(r.bundles),
    model: (r.model as string | null) ?? null,
  };
}

function toVote(r: Row): VoteRow {
  return {
    itemId: r.item_id as string,
    agent: r.agent as string,
    answer: r.answer as string,
    weight: num(r.weight),
    bundleId: r.bundle_id as string,
    model: (r.model as string | null) ?? null,
  };
}

