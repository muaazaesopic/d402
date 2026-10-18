/**
 * The d402 job marketplace. An agent's inference can pay for anything, so the
 * seller does not have to pick one kind of work: it lists jobs, and an agent
 * takes whichever one it is good at. Website review is one job; labelling a
 * dataset or pulling fields out of documents are others; posters add more at
 * runtime (see dataset.ts).
 *
 * The marketplace owns what every job shares:
 *
 *   identity   the agent's Ed25519 key (D402-Key), one per agent across all jobs
 *   trust      SPEC 5.2 counters per key; cheat on one job and you are blocked from all of them
 *   handshake  402 offer (one tier per job), GET a task, POST a signed result, get a voucher
 *   vouchers   HS256 JWTs for the gated API, worth the job's reward in calls
 *
 * A job only decides what the task looks like and how a result is checked. It
 * reports how many control items it checked and how many were right, and the
 * marketplace folds that into the agent's trust.
 *
 * Results are signed over "d402:{type}\n{assignmentId}\n{canonical JSON of result}".
 */
import { randomBytes } from "node:crypto";
import { Hono } from "hono";
import type { Context, MiddlewareHandler } from "hono";
import { SignJWT, jwtVerify, errors as joseErrors } from "jose";
import { z } from "zod";
import { D402_VERSION, DEFAULTS, HEADERS, SCHEME, WELL_KNOWN_PATH, WELL_KNOWN_TASKS_PATH, canonicalJSON, isValidPublicKey, signBytes, verifyBytes } from "@d402/spec";
import { accuracy, isBlocked, type TrustCounters } from "@d402/server";

export const MARKET_PATH = "/market";
export const MARKET_JOBS_PATH = "/market/jobs";
const MAX_OPEN_ASSIGNMENTS = 3;

// ---------------------------------------------------------------------------
// Signing
// ---------------------------------------------------------------------------

export function resultMessage(type: string, assignmentId: string, result: unknown): string {
  return `d402:${type}\n${assignmentId}\n${canonicalJSON(result)}`;
}
export function signResult(privateKey: string, type: string, assignmentId: string, result: unknown): string {
  return signBytes(privateKey, resultMessage(type, assignmentId, result));
}

// ---------------------------------------------------------------------------
// Job contract
// ---------------------------------------------------------------------------

export interface Agent extends TrustCounters {
  key: string;
  model: string | null;
  passed: number;
  rejected: number;
}

export interface Grade {
  passed: boolean;
  /** Seller-side only: the agent just gets "quality". */
  reasons: string[];
  /** Control items in this task and how many the agent got right (SPEC 5.2 counters). */
  goldenSeen: number;
  goldenCorrect: number;
}

export interface JobProgress {
  done: number;
  total: number;
  /** e.g. "items labelled", "issues confirmed". */
  unit: string;
}

export interface JobType<S = unknown> {
  /** Tier id in the offer and `?tier=` on the task URL. */
  id: string;
  /** Task type: what the agent is asked to do ("review", "classify", "extract", ...). Part of the signed message. */
  type: string;
  title: string;
  /** Who posted the job and gets the output. */
  poster: string;
  /** One line: what the agent does. */
  summary: string;
  /** One line: how the result is checked. */
  verification: string;
  /** Size of one task (items, or planted bugs for a review). */
  items: number;
  estTokens: number;
  reward: { calls: number };
  /** Seconds an assignment stays open. Default DEFAULTS.bundleTtl. */
  ttl?: number;
  /** Build one task for this agent. Return the fields it sees and private state for grading. Throw MarketError("no_tasks") when empty. */
  assign(agent: Agent, ctx: { assignmentId: string; now: number; ttl: number; random: () => number }): { task: Record<string, unknown>; state: S };
  /** Check a result. `weight` is the agent's accuracy before this task: use it for any votes the result casts. */
  grade(state: S, result: unknown, ctx: { agent: Agent; model: string | null; weight: number }): Grade | Promise<Grade>;
  progress(): JobProgress;
  /** The output so far, for the poster. */
  results?(): unknown;
}

export class MarketError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: 400 | 401 | 403 | 404 | 409 | 410 | 422 | 429 = 400,
  ) {
    super(message);
  }
}

export interface JobListing {
  id: string;
  type: string;
  title: string;
  poster: string;
  summary: string;
  verification: string;
  items: number;
  est_tokens: number;
  reward: { calls: number };
  /** GET this with a D402-Key header to take the job. */
  taskUrl: string;
  progress: JobProgress;
  stats: { taken: number; passed: number; rejected: number };
}

// ---------------------------------------------------------------------------
// Marketplace
// ---------------------------------------------------------------------------

const SubmitBody = z.object({
  result: z.unknown().optional(),
  /** Older review clients send `report`. */
  report: z.unknown().optional(),
  model: z.string().max(64).optional(),
  sig: z.string().min(1),
});

interface AssignmentState {
  id: string;
  jobId: string;
  agent: string;
  state: unknown;
  expiresAt: number;
  submittedAt: number | null;
}

export interface MarketOptions {
  sellerId: string;
  /** Public origin, e.g. http://localhost:8788. */
  baseUrl: string;
  secret: string;
  /** Path prefixes vouchers are valid for. */
  scope?: string[];
  voucherTtl?: number;
  now?: () => number;
  random?: () => number;
}

const randomId = (prefix: string) => `${prefix}${randomBytes(12).toString("base64url")}`;

export function createMarket(opts: MarketOptions) {
  const now = opts.now ?? (() => Math.floor(Date.now() / 1000));
  const random = opts.random ?? Math.random;
  const scope = opts.scope ?? ["/api"];
  const voucherTtl = opts.voucherTtl ?? DEFAULTS.voucherTtl;
  const secretKey = new TextEncoder().encode(opts.secret);
  const taskUrl = `${opts.baseUrl}${WELL_KNOWN_TASKS_PATH}`;
  const marketUrl = `${opts.baseUrl}${MARKET_JOBS_PATH}`;

  const jobs = new Map<string, JobType>();
  const jobStats = new Map<string, JobListing["stats"]>();
  const agents = new Map<string, Agent>();
  const assignments = new Map<string, AssignmentState>();
  const vouchers = new Map<string, { sub: string; callsLeft: number; exp: number }>();

  function add<S>(job: JobType<S>): void {
    if (!/^[a-z0-9][a-z0-9-]{1,39}$/.test(job.id)) throw new Error(`job id "${job.id}" must be 2-40 chars of a-z, 0-9 and -`);
    if (jobs.has(job.id)) throw new MarketError("job_exists", `a job with id "${job.id}" already exists`, 409);
    jobs.set(job.id, job as JobType);
    jobStats.set(job.id, { taken: 0, passed: 0, rejected: 0 });
  }

  function listing(): JobListing[] {
    return [...jobs.values()].map((j) => ({
      id: j.id,
      type: j.type,
      title: j.title,
      poster: j.poster,
      summary: j.summary,
      verification: j.verification,
      items: j.items,
      est_tokens: j.estTokens,
      reward: { ...j.reward },
      taskUrl: `${taskUrl}?tier=${j.id}`,
      progress: j.progress(),
      stats: { ...jobStats.get(j.id)! },
    }));
  }

  function offer(error?: string, message?: string) {
    const list = [...jobs.values()];
    const best = list.slice().sort((a, b) => b.reward.calls / b.estTokens - a.reward.calls / a.estTokens)[0];
    return {
      d402: D402_VERSION,
      accepts: [
        {
          scheme: SCHEME,
          sellerId: opts.sellerId,
          taskUrl,
          taskTypes: [...new Set(list.map((j) => j.type))],
          scope,
          voucherTtl,
          tiers: list.map((j) => ({ id: j.id, items: j.items, est_tokens: j.estTokens, reward: { ...j.reward } })),
          market: marketUrl,
          hint:
            `No wallet needed: pay with work. Each tier is a job (descriptions at ${marketUrl}); pick one you are good at` +
            (best ? `, e.g. "${best.id}" (${best.reward.calls} calls for ~${best.estTokens} tokens)` : "") +
            `. GET ${taskUrl}?tier={job id} with a D402-Key header (your base64url Ed25519 public key), do the task, ` +
            `then POST {result, sig} to ${taskUrl}/{assignmentId}, where sig is your Ed25519 signature over ` +
            `"d402:{type}\\n{assignmentId}\\n{canonical JSON of result}". Retry with the voucher in a D402-Voucher header.`,
        },
      ],
      ...(error ? { error, message } : {}),
    };
  }

  function agentFor(key: string, model: string | null): Agent {
    let a = agents.get(key);
    if (!a) {
      a = { key, model, goldenSeen: 0, goldenCorrect: 0, bundles: 0, passed: 0, rejected: 0 };
      agents.set(key, a);
    }
    if (model) a.model = model;
    return a;
  }

  function requireKey(c: Context): string {
    const key = c.req.header(HEADERS.key);
    if (!key) throw new MarketError("missing_key", `${HEADERS.key} header is required`);
    if (!isValidPublicKey(key)) throw new MarketError("bad_key", `${HEADERS.key} is not a valid Ed25519 public key`);
    return key;
  }

  function assign(key: string, model: string | null, jobId: string | undefined) {
    const job = jobId === undefined ? jobs.values().next().value : jobs.get(jobId);
    if (!job) throw new MarketError("bad_tier", `unknown job "${jobId}"; see ${marketUrl}`);
    const agent = agentFor(key, model);
    if (isBlocked(agent)) throw new MarketError("blocked", "this key's work quality is below the floor", 403);
    const t = now();
    const open = [...assignments.values()].filter((a) => a.agent === key && a.submittedAt === null && a.expiresAt > t);
    if (open.length >= MAX_OPEN_ASSIGNMENTS) throw new MarketError("rate_limited", "too many open assignments for this key", 429);

    const ttl = job.ttl ?? DEFAULTS.bundleTtl;
    const id = randomId("a_");
    const { task, state } = job.assign(agent, { assignmentId: id, now: t, ttl, random });
    assignments.set(id, { id, jobId: job.id, agent: key, state, expiresAt: t + ttl, submittedAt: null });
    jobStats.get(job.id)!.taken++;
    return { assignmentId: id, type: job.type, tier: job.id, ...task, expiresAt: t + ttl };
  }

  async function mintVoucher(sub: string, calls: number) {
    const t = now();
    const jti = randomId("v_");
    const exp = t + voucherTtl;
    const token = await new SignJWT({ scope })
      .setProtectedHeader({ alg: "HS256", typ: "JWT" })
      .setIssuer(opts.sellerId)
      .setSubject(sub)
      .setJti(jti)
      .setIssuedAt(t)
      .setExpirationTime(exp)
      .sign(secretKey);
    vouchers.set(jti, { sub, callsLeft: calls, exp });
    return { voucher: token, calls, scope: scope.slice(), expiresAt: exp };
  }

  // -- routes -----------------------------------------------------------------

  const routes = new Hono();
  const marketError = (c: Context, e: MarketError) => c.json({ error: e.code, message: e.message }, e.status);

  routes.get(WELL_KNOWN_PATH, (c) => c.json(offer()));
  routes.get(MARKET_JOBS_PATH, (c) => c.json({ sellerId: opts.sellerId, taskUrl, scope, jobs: listing() }));

  routes.get(WELL_KNOWN_TASKS_PATH, (c) => {
    try {
      return c.json(assign(requireKey(c), c.req.header(HEADERS.model) ?? null, c.req.query("tier")));
    } catch (e) {
      if (e instanceof MarketError) return marketError(c, e);
      throw e;
    }
  });

  routes.post(`${WELL_KNOWN_TASKS_PATH}/:assignmentId`, async (c) => {
    try {
      const key = requireKey(c);
      const a = assignments.get(c.req.param("assignmentId"));
      if (!a || a.agent !== key) throw new MarketError("unknown_bundle", "no such assignment for this key", 404);
      if (a.submittedAt !== null) throw new MarketError("already_submitted", "this assignment was already submitted", 409);
      if (a.expiresAt <= now()) throw new MarketError("expired_bundle", "this assignment has expired", 410);
      const job = jobs.get(a.jobId)!;

      let raw: unknown;
      try {
        raw = await c.req.json();
      } catch {
        throw new MarketError("bad_request", "body must be JSON");
      }
      const body = SubmitBody.safeParse(raw);
      const result = body.success ? (body.data.result ?? body.data.report) : undefined;
      if (!body.success || result === undefined) throw new MarketError("bad_request", "body must be {result, sig, model?}");
      // The signature covers the result exactly as sent, before any defaults are filled in.
      if (!verifyBytes(key, resultMessage(job.type, a.id, result), body.data.sig)) {
        throw new MarketError("bad_signature", "sig does not verify", 401);
      }

      const model = body.data.model ?? c.req.header(HEADERS.model) ?? null;
      const agent = agentFor(key, model);
      // Vote weight uses the accuracy before this task, as SPEC 5.1 does in @d402/server.
      const weight = accuracy(agent);
      // Claim the assignment before grading (grading can await), release it if the result is malformed.
      a.submittedAt = now();
      let grade: Grade;
      try {
        grade = await job.grade(a.state, result, { agent, model: model ?? agent.model, weight });
      } catch (e) {
        a.submittedAt = null;
        throw e;
      }
      agent.goldenSeen += grade.goldenSeen;
      agent.goldenCorrect += grade.goldenCorrect;
      agent.bundles += 1;
      const stats = jobStats.get(job.id)!;
      if (grade.passed) {
        agent.passed++;
        stats.passed++;
      } else {
        agent.rejected++;
        stats.rejected++;
      }
      if (!grade.passed) return c.json({ error: "quality", message: "the result did not meet the quality bar" }, 422);
      return c.json(await mintVoucher(key, job.reward.calls));
    } catch (e) {
      if (e instanceof MarketError) return marketError(c, e);
      throw e;
    }
  });

  /** Gate for scope paths: verify the voucher, spend one call (SPEC 7). */
  const gate: MiddlewareHandler = async (c, next) => {
    const fail = (code: string, message: string) => c.json(offer(code, message), 402);
    const token = c.req.header(HEADERS.voucher);
    if (!token) return fail("missing_voucher", `${HEADERS.voucher} header is required`);
    let jti: string;
    try {
      const { payload } = await jwtVerify(token, secretKey, { algorithms: ["HS256"], issuer: opts.sellerId, currentDate: new Date(now() * 1000) });
      if (typeof payload.jti !== "string") return fail("voucher_invalid", "voucher has no jti");
      jti = payload.jti;
    } catch (e) {
      if (e instanceof joseErrors.JWTExpired) return fail("voucher_expired", "voucher has expired");
      return fail("voucher_invalid", "voucher does not verify");
    }
    const v = vouchers.get(jti);
    if (!v) return fail("voucher_invalid", "unknown voucher");
    if (v.callsLeft <= 0) return fail("voucher_exhausted", "voucher has no calls left");
    v.callsLeft -= 1;
    c.header(HEADERS.callsRemaining, String(v.callsLeft));
    await next();
  };

  function agentList() {
    return [...agents.values()].map((a) => ({
      key: a.key,
      model: a.model,
      tasks: a.bundles,
      passed: a.passed,
      rejected: a.rejected,
      accuracy: Math.round(accuracy(a) * 1000) / 1000,
      blocked: isBlocked(a),
    }));
  }

  return {
    routes,
    gate,
    offer,
    add,
    listing,
    agents: agentList,
    job: (id: string) => jobs.get(id),
    taskUrl,
    marketUrl,
  };
}

export type Market = ReturnType<typeof createMarket>;
