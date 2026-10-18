import { randomBytes } from "node:crypto";
import { Hono } from "hono";
import type { Context, MiddlewareHandler } from "hono";
import { SignJWT, jwtVerify, errors as joseErrors } from "jose";
import {
  D402Accept,
  D402_VERSION,
  DEFAULTS,
  HEADERS,
  SCHEME,
  SubmitBody,
  VoucherClaims,
  WELL_KNOWN_PATH,
  WELL_KNOWN_TASKS_PATH,
  isValidPublicKey,
  verifySpend,
  verifySubmit,
  type Bundle,
  type ErrorCode,
  type Offer,
  type SubmitResult,
  type TaskFileItem,
  type Tier,
} from "@d402/spec";
import {
  SqliteStore,
  type AgentRow,
  type BundleItemRef,
  type BundleRow,
  type ItemRow,
  type PoolStats,
  type ResolvedItem,
  type Store,
  type VoteRow,
} from "./store.js";
import { accuracy, goldenCount, isBlocked, passes } from "./trust.js";
import * as pool from "./pool.js";
import { createAdminRoutes } from "./admin.js";

export * from "./store.js";
export * from "./admin.js";
export * from "./trust.js";
export type { PoolStats, ResolvedItem };

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface D402ServerOptions {
  sellerId: string;
  /** Absolute URL where the task routes are mounted. */
  taskUrl: string;
  /** Path prefixes vouchers are valid for. */
  scope: string[];
  tiers: Tier[];
  /** HMAC secret for HS256 vouchers. */
  secret: string;
  /** Classify labels for the pool (>= 2). */
  labels: string[];
  instructions?: string;
  /** sqlite path, default ":memory:". */
  db?: string;
  voucherTtl?: number;
  bundleTtl?: number;
  goldenMaxExposures?: number;
  bundlesPerKeyPerHour?: number;
  bundlesPerIpPerHour?: number;
  maxOpenBundlesPerKey?: number;
  requireModelFamilies?: boolean;
  /** SPEC 7.1: bind spends to the agent key. Default false. */
  bindVouchers?: boolean;
  /** With bindVouchers: reject bound spends that carry no D402-Nonce (SPEC 7.2). Default false. */
  requireSpendNonce?: boolean;
  /** Unix seconds; injectable for tests. */
  now?: () => number;
  /** RNG in [0, 1) used for golden sampling and shuffling. */
  random?: () => number;
  /** Extra schemes appended to offer.accepts (e.g. an x402 "exact" entry). */
  otherAccepts?: unknown[];
  /** When set, mounts GET /.well-known/d402/admin/{stats,export,agents,events} behind `Authorization: Bearer <adminToken>`. */
  adminToken?: string;
}

export interface AgentRecord {
  publicKey: string;
  goldenSeen: number;
  goldenCorrect: number;
  bundles: number;
  accuracy: number;
  blocked: boolean;
  model?: string;
}

export interface VoucherRecord {
  jti: string;
  sub: string;
  scope: string[];
  callsLeft: number;
  exp: number;
}

export interface D402Server {
  /** Hono middleware for gated routes (SPEC 7). */
  gate: MiddlewareHandler;
  /** GET /.well-known/d402 ; GET /.well-known/d402/tasks ; POST /.well-known/d402/tasks/:bundleId */
  routes: Hono;
  offer(error?: ErrorCode, message?: string): Offer;
  tasks: {
    load(items: TaskFileItem[]): number;
    loadFile(path: string): number;
    exportResolved(): ResolvedItem[];
    stats(): PoolStats;
  };
  agents: { get(publicKey: string): AgentRecord | undefined; list(): AgentRecord[] };
  vouchers: { get(jti: string): VoucherRecord | undefined };
  close(): void;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const DEFAULT_INSTRUCTIONS = "Label each item with exactly one of the labels.";

const ERROR_STATUS: Partial<Record<ErrorCode, number>> = {
  bad_tier: 400,
  no_tasks: 409,
  rate_limited: 429,
  blocked: 403,
  missing_key: 400,
  bad_key: 400,
  unknown_bundle: 404,
  expired_bundle: 410,
  bad_signature: 401,
  already_submitted: 409,
  incomplete: 400,
  bad_label: 400,
  quality: 422,
  bad_request: 400,
};

class TaskError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly headers: Record<string, string> = {},
  ) {
    super(message);
  }
}

function randomId(prefix: string): string {
  return prefix + randomBytes(12).toString("base64url");
}

/** Fisher-Yates with an injectable RNG. */
function shuffle<T>(arr: T[], random: () => number): T[] {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

function clientIp(c: Context): string {
  const xff = c.req.header("x-forwarded-for");
  if (xff) {
    const first = xff.split(",")[0]!.trim();
    if (first) return first;
  }
  // @hono/node-server exposes the raw IncomingMessage on c.env.incoming.
  const env = c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined;
  const addr = env?.incoming?.socket?.remoteAddress;
  return addr || "unknown";
}

function toAgentRecord(a: AgentRow): AgentRecord {
  const rec: AgentRecord = {
    publicKey: a.publicKey,
    goldenSeen: a.goldenSeen,
    goldenCorrect: a.goldenCorrect,
    bundles: a.bundles,
    accuracy: accuracy(a),
    blocked: isBlocked(a),
  };
  if (a.model) rec.model = a.model;
  return rec;
}

function scopeMatches(scope: string[], path: string): boolean {
  return scope.some((prefix) => path === prefix || path.startsWith(prefix));
}

// ---------------------------------------------------------------------------
// createD402
// ---------------------------------------------------------------------------

export function createD402(opts: D402ServerOptions): D402Server {
  if (!Array.isArray(opts.labels) || opts.labels.length < 2) {
    throw new Error("d402: labels must contain at least 2 entries");
  }
  if (!opts.secret) throw new Error("d402: secret is required");

  const now = opts.now ?? (() => Math.floor(Date.now() / 1000));
  const random = opts.random ?? Math.random;
  const voucherTtl = opts.voucherTtl ?? DEFAULTS.voucherTtl;
  const bundleTtl = opts.bundleTtl ?? DEFAULTS.bundleTtl;
  const goldenMaxExposures = opts.goldenMaxExposures ?? DEFAULTS.goldenMaxExposures;
  const bundlesPerKeyPerHour = opts.bundlesPerKeyPerHour ?? DEFAULTS.bundlesPerKeyPerHour;
  const bundlesPerIpPerHour = opts.bundlesPerIpPerHour ?? DEFAULTS.bundlesPerIpPerHour;
  const maxOpenBundlesPerKey = opts.maxOpenBundlesPerKey ?? DEFAULTS.maxOpenBundlesPerKey;
  const requireModelFamilies = opts.requireModelFamilies ?? false;
  const bindVouchers = opts.bindVouchers ?? false;
  const requireSpendNonce = opts.requireSpendNonce ?? false;
  let lastNoncePurge = 0;
  const instructions = opts.instructions ?? DEFAULT_INSTRUCTIONS;
  const labels = opts.labels.slice();
  const labelSet = new Set(labels);
  const scope = opts.scope.slice();
  const secretKey = new TextEncoder().encode(opts.secret);

  const accept = D402Accept.parse({
    scheme: SCHEME,
    sellerId: opts.sellerId,
    taskUrl: opts.taskUrl,
    taskTypes: ["classify"],
    scope,
    voucherTtl,
    tiers: opts.tiers,
  });
  const tiersById = new Map(accept.tiers.map((t) => [t.id, t]));

  const store: Store = new SqliteStore(opts.db ?? ":memory:");

  // -- offer ----------------------------------------------------------------

  function offer(error?: ErrorCode, message?: string): Offer {
    const body: Offer = {
      d402: D402_VERSION,
      accepts: [structuredClone(accept), ...((opts.otherAccepts ?? []) as Offer["accepts"])],
    };
    if (error) body.error = error;
    if (message) body.message = message;
    return body;
  }

  // -- shared request helpers ----------------------------------------------

  function requireKey(c: Context): string {
    const key = c.req.header(HEADERS.key);
    if (!key) throw new TaskError("missing_key", `${HEADERS.key} header is required`);
    if (!isValidPublicKey(key)) throw new TaskError("bad_key", `${HEADERS.key} is not a valid Ed25519 public key`);
    return key;
  }

  function taskErrorResponse(c: Context, e: TaskError) {
    for (const [k, v] of Object.entries(e.headers)) c.header(k, v);
    return c.json({ error: e.code, message: e.message }, (ERROR_STATUS[e.code] ?? 400) as 400);
  }

  // -- bundle issuing (SPEC 4, 5.2, 5.4, 9) --------------------------------

  function checkRateLimits(key: string, ip: string, t: number): void {
    const since = t - 3600;
    const retry = (at: number | undefined) => String(Math.max(1, (at ?? t) - t));
    if (store.countBundlesByKeySince(key, since) >= bundlesPerKeyPerHour) {
      const oldest = store.oldestBundleByKeySince(key, since);
      throw new TaskError("rate_limited", "too many bundles for this key in the last hour", {
        "Retry-After": retry(oldest === undefined ? undefined : oldest + 3600),
      });
    }
    if (store.countBundlesByIpSince(ip, since) >= bundlesPerIpPerHour) {
      const oldest = store.oldestBundleByIpSince(ip, since);
      throw new TaskError("rate_limited", "too many bundles for this IP in the last hour", {
        "Retry-After": retry(oldest === undefined ? undefined : oldest + 3600),
      });
    }
    if (store.countOpenBundles(key, t) >= maxOpenBundlesPerKey) {
      throw new TaskError("rate_limited", "too many open bundles for this key", {
        "Retry-After": retry(store.earliestOpenExpiry(key, t)),
      });
    }
  }

  function buildBundle(agent: AgentRow, tier: Tier, ip: string, t: number): Bundle {
    const wantGolden = Math.min(tier.items, goldenCount(tier.items, agent));
    const liveGoldens = shuffle(store.liveGoldens(), random);
    if (liveGoldens.length < wantGolden) {
      throw new TaskError("no_tasks", "not enough golden items in the pool");
    }
    const unknowns = store.unknownCandidates(agent.publicKey, t, tier.items - wantGolden);
    const needGolden = tier.items - unknowns.length;
    if (liveGoldens.length < needGolden) {
      throw new TaskError("no_tasks", "the pool has nothing to hand out");
    }
    const goldens = liveGoldens.slice(0, needGolden);

    const refs: Array<BundleItemRef & { text: string }> = shuffle(
      [
        ...goldens.map((i: ItemRow) => ({ id: i.id, golden: true, text: i.text })),
        ...unknowns.map((i: ItemRow) => ({ id: i.id, golden: false, text: i.text })),
      ],
      random,
    );

    const bundleId = randomId("b_");
    const expiresAt = t + bundleTtl;
    store.transaction(() => {
      store.insertBundle({
        bundleId,
        agent: agent.publicKey,
        tier: tier.id,
        ip,
        issuedAt: t,
        expiresAt,
        submittedAt: null,
        items: refs.map(({ id, golden }) => ({ id, golden })),
      });
      store.recordGoldenExposures(
        goldens.map((g) => g.id),
        goldenMaxExposures,
      );
    });

    return {
      bundleId,
      tier: tier.id,
      type: "classify",
      instructions,
      labels,
      items: refs.map(({ id, text }) => ({ id, text })),
      expiresAt,
    };
  }

  // -- grading (SPEC 5.1, 5.3, 6) ------------------------------------------

  interface GradeOutcome {
    passed: boolean;
    result?: SubmitResult;
  }

  async function grade(
    key: string,
    bundle: BundleRow,
    answers: Record<string, string>,
    model: string | null,
    t: number,
  ): Promise<GradeOutcome> {
    const bundleId = bundle.bundleId;
    for (const it of bundle.items) {
      const a = answers[it.id];
      if (a === undefined) throw new TaskError("incomplete", `no answer for item ${it.id}`);
      if (!labelSet.has(a)) throw new TaskError("bad_label", `answer for item ${it.id} is not one of the labels`);
    }

    let g = 0;
    let c = 0;
    for (const it of bundle.items) {
      if (!it.golden) continue;
      g++;
      const item = store.getItem(it.id);
      if (item && item.golden !== null && item.golden === answers[it.id]) c++;
    }
    const passed = passes(g, c);

    // Vote weight is the agent's accuracy estimate BEFORE this bundle's counters
    // are folded in. SPEC 5.1 says "the agent's current accuracy estimate"; using
    // the pre-update value means a bundle cannot raise its own weight with the
    // goldens it just answered, and it keeps the weight for the very first
    // bundle at the prior (0.5) regardless of the outcome.
    const agent = store.ensureAgent(key, model);
    const weight = accuracy(agent);

    const voucherExp = t + voucherTtl;
    const jti = randomId("v_");
    let voucher: string | undefined;
    if (passed) {
      voucher = await new SignJWT({ scope })
        .setProtectedHeader({ alg: "HS256", typ: "JWT" })
        .setIssuer(opts.sellerId)
        .setSubject(key)
        .setJti(jti)
        .setIssuedAt(t)
        .setExpirationTime(voucherExp)
        .sign(secretKey);
    }

    const tier = tiersById.get(bundle.tier);
    const calls = tier?.reward.calls ?? 1;

    store.transaction(() => {
      store.markSubmitted(bundleId, t);
      agent.goldenSeen += g;
      agent.goldenCorrect += c;
      agent.bundles += 1;
      if (model) agent.model = model;
      store.updateAgent(agent);

      if (!passed) return;

      const votes: VoteRow[] = bundle.items
        .filter((it) => !it.golden)
        .map((it) => ({
          itemId: it.id,
          agent: key,
          answer: answers[it.id]!,
          weight,
          bundleId,
          model: model ?? agent.model ?? null,
        }));
      store.insertVotes(votes);
      for (const v of votes) tryResolve(v.itemId);

      store.insertVoucher({ jti, sub: key, scope, callsLeft: calls, exp: voucherExp });
    });

    if (!passed) return { passed: false };
    return {
      passed: true,
      result: { voucher: voucher!, calls, scope: scope.slice(), expiresAt: voucherExp },
    };
  }

  /** SPEC 5.3: resolve an unknown item when its top answer has enough weight and voters. */
  function tryResolve(itemId: string): void {
    const item = store.getItem(itemId);
    if (!item || item.golden !== null || item.resolved !== null) return;
    const votes = store.itemVotes(itemId);
    const byAnswer = new Map<string, { weight: number; keys: Set<string>; models: Set<string> }>();
    for (const v of votes) {
      let agg = byAnswer.get(v.answer);
      if (!agg) {
        agg = { weight: 0, keys: new Set(), models: new Set() };
        byAnswer.set(v.answer, agg);
      }
      agg.weight += v.weight;
      agg.keys.add(v.agent);
      if (v.model) agg.models.add(v.model);
    }
    let top: [string, { weight: number; keys: Set<string>; models: Set<string> }] | undefined;
    for (const entry of byAnswer) {
      if (!top || entry[1].weight > top[1].weight) top = entry;
    }
    if (!top) return;
    const [answer, agg] = top;
    if (agg.weight < DEFAULTS.resolveWeight) return;
    if (agg.keys.size < DEFAULTS.resolveMinKeys) return;
    if (requireModelFamilies && agg.models.size < 2) return;
    store.resolveItem(itemId, answer);
  }

  // -- routes ---------------------------------------------------------------

  const routes = new Hono();

  routes.get(WELL_KNOWN_PATH, (c) => c.json(offer()));

  routes.get(WELL_KNOWN_TASKS_PATH, (c) => {
    try {
      const t = now();
      const key = requireKey(c);
      const model = c.req.header(HEADERS.model) ?? null;
      const agent = store.ensureAgent(key, model);
      if (isBlocked(agent)) throw new TaskError("blocked", "this key is blocked");

      const tierId = c.req.query("tier");
      const tier = tierId === undefined ? accept.tiers[0]! : tiersById.get(tierId);
      if (!tier) throw new TaskError("bad_tier", `unknown tier ${JSON.stringify(tierId)}`);

      checkRateLimits(key, clientIp(c), t);
      const bundle = buildBundle(agent, tier, clientIp(c), t);
      return c.json(bundle, 200);
    } catch (e) {
      if (e instanceof TaskError) return taskErrorResponse(c, e);
      throw e;
    }
  });

  routes.post(`${WELL_KNOWN_TASKS_PATH}/:bundleId`, async (c) => {
    try {
      const t = now();
      const key = requireKey(c);
      const bundleId = c.req.param("bundleId");
      if (isBlocked(store.getAgent(key) ?? { goldenSeen: 0, goldenCorrect: 0, bundles: 0 })) {
        throw new TaskError("blocked", "this key is blocked");
      }

      let raw: unknown;
      try {
        raw = await c.req.json();
      } catch {
        throw new TaskError("bad_request", "body must be JSON");
      }
      const parsed = SubmitBody.safeParse(raw);
      if (!parsed.success) throw new TaskError("bad_request", "body does not match SubmitBody");
      const body = parsed.data;

      const bundle = store.getBundle(bundleId);
      if (!bundle) throw new TaskError("unknown_bundle", "no such bundle");
      if (bundle.submittedAt !== null) throw new TaskError("already_submitted", "bundle was already submitted");
      if (bundle.expiresAt <= t) throw new TaskError("expired_bundle", "bundle has expired");
      if (bundle.agent !== key || !verifySubmit(key, bundleId, body.answers, body.sig)) {
        throw new TaskError("bad_signature", "signature does not verify for this key and bundle");
      }

      const model = body.model ?? c.req.header(HEADERS.model) ?? null;
      const outcome = await grade(key, bundle, body.answers, model, t);
      if (!outcome.passed) {
        return c.json({ error: "quality", message: "bundle did not meet the quality bar" }, 422);
      }
      return c.json(outcome.result, 200);
    } catch (e) {
      if (e instanceof TaskError) return taskErrorResponse(c, e);
      throw e;
    }
  });

  // -- gate (SPEC 7, 7.1) ---------------------------------------------------

  // Hono's "/search/*" also matches "/search", so mounting the gate on both
  // (the documented usage) runs it twice per request. Remember requests that
  // already paid so the second pass is a no-op.
  const spent = new WeakSet<Request>();

  const gate: MiddlewareHandler = async (c, next) => {
    if (spent.has(c.req.raw)) return next();
    const fail = (code: ErrorCode, message: string) => c.json(offer(code, message), 402);

    const token = c.req.header(HEADERS.voucher);
    if (!token) return fail("missing_voucher", `${HEADERS.voucher} header is required`);

    const t = now();
    let claims: VoucherClaims;
    try {
      const { payload } = await jwtVerify(token, secretKey, {
        algorithms: ["HS256"],
        issuer: opts.sellerId,
        currentDate: new Date(t * 1000),
      });
      const parsed = VoucherClaims.safeParse(payload);
      if (!parsed.success) return fail("voucher_invalid", "voucher claims are malformed");
      claims = parsed.data;
    } catch (e) {
      if (e instanceof joseErrors.JWTExpired) return fail("voucher_expired", "voucher has expired");
      return fail("voucher_invalid", "voucher does not verify");
    }
    if (claims.exp <= t) return fail("voucher_expired", "voucher has expired");

    const path = c.req.path;
    if (!scopeMatches(claims.scope, path)) return fail("scope_mismatch", "path is outside the voucher scope");

    const stored = store.getVoucher(claims.jti);
    if (!stored || stored.sub !== claims.sub) return fail("voucher_invalid", "unknown voucher");
    if (!scopeMatches(stored.scope, path)) return fail("scope_mismatch", "path is outside the voucher scope");

    if (bindVouchers) {
      const key = c.req.header(HEADERS.key);
      if (!key || key !== claims.sub) return fail("bad_key", `${HEADERS.key} must equal the voucher subject`);
      const tsRaw = c.req.header(HEADERS.timestamp);
      const ts = tsRaw === undefined ? NaN : Number(tsRaw);
      if (!Number.isFinite(ts) || Math.abs(t - ts) > DEFAULTS.spendTimestampSkew) {
        return fail("stale_timestamp", `${HEADERS.timestamp} is missing or outside the allowed skew`);
      }
      const sig = c.req.header(HEADERS.sig);
      const nonce = c.req.header(HEADERS.nonce);
      if (nonce === undefined && requireSpendNonce) {
        return fail("bad_signature", `${HEADERS.nonce} is required by this seller`);
      }
      if (nonce !== undefined && (nonce.length < 8 || nonce.length > 128)) {
        return fail("bad_signature", `${HEADERS.nonce} must be 8 to 128 characters`);
      }
      if (!sig || !verifySpend(key, c.req.method, path, claims.jti, ts, sig, nonce)) {
        return fail("bad_signature", `${HEADERS.sig} does not verify`);
      }
      if (nonce !== undefined) {
        if (t - lastNoncePurge >= 60) {
          store.purgeSpendNonces(t);
          lastNoncePurge = t;
        }
        if (!store.recordSpendNonce(claims.jti, nonce, ts + DEFAULTS.spendTimestampSkew + 1)) {
          return fail("replayed_spend", `${HEADERS.nonce} was already used for this voucher`);
        }
      }
    }

    if (stored.callsLeft <= 0) return fail("voucher_exhausted", "voucher has no calls left");
    const remaining = store.spendVoucher(claims.jti);
    if (remaining === undefined) return fail("voucher_exhausted", "voucher has no calls left");

    spent.add(c.req.raw);
    c.header(HEADERS.callsRemaining, String(remaining));
    await next();
  };

  if (opts.adminToken) routes.route("/", createAdminRoutes({ token: opts.adminToken, store, now, voucherTtl, stats: () => pool.stats(store, now()), exportResolved: () => pool.exportResolved(store), listAgents: () => store.listAgents().map(toAgentRecord) }));

  // -- public surface -------------------------------------------------------

  return {
    gate,
    routes,
    offer,
    tasks: {
      load: (items) => pool.loadItems(store, items),
      loadFile: (path) => pool.loadFile(store, path),
      exportResolved: () => pool.exportResolved(store),
      stats: () => pool.stats(store, now()),
    },
    agents: {
      get: (publicKey) => {
        const a = store.getAgent(publicKey);
        return a ? toAgentRecord(a) : undefined;
      },
      list: () => store.listAgents().map(toAgentRecord),
    },
    vouchers: {
      get: (jti) => store.getVoucher(jti),
    },
    close: () => store.close(),
  };
}
