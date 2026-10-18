import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { findD402Accept, HEADERS, Offer, type Bundle, type D402Accept, type Tier } from "@d402/spec";
import { isD402ErrorLike, type D402ClientLike, type SolverLike } from "./types.js";

export interface McpServerOptions {
  /** The d402 client that holds the keypair, signs submissions and caches vouchers. */
  client: D402ClientLike;
  /** Where bundles handed out by `d402_get_bundle` are remembered until submitted. */
  bundleStore?: Map<string, Bundle>;
  /** Alias of `bundleStore`. */
  getBundleStore?: Map<string, Bundle>;
  /**
   * Solver used by `d402_fetch { autoEarn: true }`. The bin wires this to
   * `D402_SOLVER_CMD`. Without it autoEarn fails with an explanatory error.
   */
  solver?: SolverLike;
  /** Tier id used when a tool call does not name one (env `D402_TIER`). */
  defaultTier?: string;
  /** Clock in unix seconds, for tests. */
  now?: () => number;
  /** How many bundles autoEarn may attempt before giving up. Default 3. */
  maxEarnAttempts?: number;
  /** Response bodies longer than this many bytes are truncated. Default 65536. */
  maxBodyBytes?: number;
}

export const SERVER_NAME = "d402";
export const SERVER_VERSION = "0.1.0";
export const DEFAULT_MAX_BODY_BYTES = 64 * 1024;

const GET_BUNDLE_HINT =
  "Label every item with exactly one label from `labels`, then call d402_submit with { taskUrl, bundleId, answers: { <item id>: <label> } }.";

function ok(data: Record<string, unknown>): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }], structuredContent: data };
}

function fail(message: string, extra: Record<string, unknown> = {}): CallToolResult {
  const data = { error: true, message, ...extra };
  return { isError: true, content: [{ type: "text", text: JSON.stringify(data, null, 2) }], structuredContent: data };
}

function describeError(err: unknown): { message: string; code?: string; status?: number } {
  if (isD402ErrorLike(err)) return { message: err.message, code: err.code, status: err.status };
  if (err instanceof Error) return { message: err.message };
  return { message: String(err) };
}

function failFrom(prefix: string, err: unknown): CallToolResult {
  const d = describeError(err);
  const extra: Record<string, unknown> = {};
  if (d.code) extra.code = d.code;
  if (d.status) extra.status = d.status;
  return fail(`${prefix}: ${d.message}`, extra);
}

export function smallestTier(tiers: Tier[]): Tier {
  return tiers.reduce((best, t) => (t.items < best.items ? t : best), tiers[0]!);
}

function acceptSummary(accept: D402Accept) {
  return {
    sellerId: accept.sellerId,
    taskUrl: accept.taskUrl,
    taskTypes: accept.taskTypes,
    scope: accept.scope,
    voucherTtl: accept.voucherTtl,
    tiers: accept.tiers,
  };
}

/** Parses an offer out of a 402 body (string or already-decoded JSON). */
function parseOffer(body: unknown): Offer | undefined {
  let value = body;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return undefined;
    }
  }
  const res = Offer.safeParse(value);
  return res.success ? res.data : undefined;
}

export interface ValidationProblem {
  missing: string[];
  badLabels: { id: string; label: string }[];
  unknownIds: string[];
}

/** Checks answers against a bundle. Returns undefined when they are complete and well formed. */
export function validateAnswers(bundle: Bundle, answers: Record<string, string>): ValidationProblem | undefined {
  const labels = new Set(bundle.labels);
  const itemIds = new Set(bundle.items.map((i) => i.id));
  const missing = bundle.items.filter((i) => !(i.id in answers)).map((i) => i.id);
  const badLabels: { id: string; label: string }[] = [];
  const unknownIds: string[] = [];
  for (const [id, label] of Object.entries(answers)) {
    if (!itemIds.has(id)) unknownIds.push(id);
    else if (!labels.has(label)) badLabels.push({ id, label });
  }
  if (missing.length === 0 && badLabels.length === 0 && unknownIds.length === 0) return undefined;
  return { missing, badLabels, unknownIds };
}

export function createMcpServer(opts: McpServerOptions): McpServer {
  const client = opts.client;
  const bundles = opts.bundleStore ?? opts.getBundleStore ?? new Map<string, Bundle>();
  const now = opts.now ?? (() => Math.floor(Date.now() / 1000));
  const maxEarnAttempts = opts.maxEarnAttempts ?? 3;
  const maxBodyBytes = opts.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;

  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      instructions:
        "d402 lets you pay for API access by labelling data. Flow: d402_discover (or a 402 from d402_fetch) " +
        "gives a taskUrl and tiers; d402_get_bundle returns items to label; d402_submit signs and stores a voucher; " +
        "d402_fetch then spends it automatically. d402_status lists vouchers and your public key.",
    },
  );

  function pruneExpired(): void {
    const t = now();
    for (const [id, b] of bundles) if (b.expiresAt <= t) bundles.delete(id);
  }

  /** origin -> accept learned from discover() or a 402; null means "known not to offer d402". */
  const acceptsByOrigin = new Map<string, D402Accept | null>();

  function originOf(url: string): string | undefined {
    try {
      return new URL(url).origin;
    } catch {
      return undefined;
    }
  }

  function rememberAccept(url: string, accept: D402Accept): void {
    const o = originOf(url);
    if (o) acceptsByOrigin.set(o, accept);
  }

  /**
   * Discovers the origin's offer once. This also teaches the underlying client
   * about the seller, so a voucher persisted by an earlier process is attached
   * to the very first request instead of after a 402 round trip.
   */
  async function ensureAccept(origin: string): Promise<D402Accept | undefined> {
    const cached = acceptsByOrigin.get(origin);
    if (cached !== undefined) return cached ?? undefined;
    try {
      const offer = await client.discover(origin);
      const accept = findD402Accept(offer);
      acceptsByOrigin.set(origin, accept ?? null);
      return accept;
    } catch (err) {
      const d = describeError(err);
      if (d.code === "bad_offer" || d.code === "no_d402" || d.status === 404) acceptsByOrigin.set(origin, null);
      return undefined;
    }
  }

  async function discoverAccept(baseUrl: string): Promise<{ accept?: D402Accept; offer?: Offer; error?: CallToolResult }> {
    let offer: Offer;
    try {
      offer = await client.discover(baseUrl);
    } catch (err) {
      const d = describeError(err);
      if (d.status === 404 || d.code === "bad_offer") {
        return {
          error: fail(`${baseUrl} does not offer d402 (no valid offer at /.well-known/d402${d.status ? `, HTTP ${d.status}` : ""}).`, {
            code: "no_d402",
          }),
        };
      }
      return { error: failFrom(`discover failed for ${baseUrl}`, err) };
    }
    const accept = findD402Accept(offer);
    if (accept) rememberAccept(baseUrl, accept);
    if (!accept) {
      return {
        offer,
        error: fail(`${baseUrl} does not offer d402: no "d402" scheme in the offer's accepts.`, {
          code: "no_d402",
          schemes: offer.accepts.map((a) => a.scheme),
        }),
      };
    }
    return { accept, offer };
  }

  function pickTier(accept: D402Accept, requested?: string): Tier | undefined {
    if (requested) return accept.tiers.find((t) => t.id === requested);
    return smallestTier(accept.tiers);
  }

  server.registerTool(
    "d402_discover",
    {
      title: "Discover a d402 offer",
      description:
        "Fetch a seller's d402 offer (GET {baseUrl}/.well-known/d402). Returns sellerId, taskUrl, tiers and scope, " +
        "or an error if the seller does not offer d402. Use the taskUrl and a tier id with d402_get_bundle.",
      inputSchema: {
        baseUrl: z.string().min(1).describe("Seller base URL (https://api.example.com) or a full offer URL."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ baseUrl }) => {
      const r = await discoverAccept(baseUrl);
      if (r.error || !r.accept) return r.error ?? fail("discover failed");
      return ok({
        ...acceptSummary(r.accept),
        hint: `Call d402_get_bundle with taskUrl "${r.accept.taskUrl}" and one of the tier ids (smallest first is cheapest).`,
      });
    },
  );

  server.registerTool(
    "d402_get_bundle",
    {
      title: "Get a bundle to label",
      description:
        "Request a bundle of items to label from a seller's taskUrl. Pass a tier id from d402_discover, or a baseUrl " +
        "so the smallest tier can be chosen. The bundle is remembered so d402_submit can validate your answers. " +
        "Bundles expire (expiresAt, unix seconds).",
      inputSchema: {
        taskUrl: z.string().min(1).optional().describe("The seller's taskUrl from the offer. Optional when baseUrl is given."),
        tier: z.string().min(1).optional().describe("Tier id (for example s, m, l). Defaults to D402_TIER, else the smallest tier when baseUrl is given."),
        baseUrl: z.string().min(1).optional().describe("Seller base URL; used to discover the taskUrl and tiers when not given."),
      },
      annotations: { openWorldHint: true },
    },
    async ({ taskUrl, tier, baseUrl }) => {
      pruneExpired();
      let tierId = tier ?? opts.defaultTier;
      let url = taskUrl;
      if (!tierId || !url) {
        if (!baseUrl) {
          return fail(
            "tier is required: pass tier (a tiers[].id from d402_discover) or baseUrl so the smallest tier can be picked.",
            { code: "missing_tier" },
          );
        }
        const r = await discoverAccept(baseUrl);
        if (r.error || !r.accept) return r.error ?? fail("discover failed");
        url = url ?? r.accept.taskUrl;
        const picked = pickTier(r.accept, tierId);
        if (!picked) {
          return fail(`tier "${tierId}" is not offered by ${r.accept.sellerId}.`, {
            code: "bad_tier",
            tiers: r.accept.tiers.map((t) => t.id),
          });
        }
        tierId = picked.id;
      }
      let bundle: Bundle;
      try {
        bundle = await client.getBundle(url, tierId);
      } catch (err) {
        return failFrom("could not get a bundle", err);
      }
      bundles.set(bundle.bundleId, bundle);
      return ok({
        bundleId: bundle.bundleId,
        tier: bundle.tier,
        type: bundle.type,
        taskUrl: url,
        instructions: bundle.instructions,
        labels: bundle.labels,
        items: bundle.items,
        expiresAt: bundle.expiresAt,
        hint: GET_BUNDLE_HINT,
      });
    },
  );

  server.registerTool(
    "d402_submit",
    {
      title: "Submit bundle answers",
      description:
        "Submit your labels for a bundle from d402_get_bundle. Answers are checked locally (every item answered, each " +
        "label in the bundle's labels), signed with this server's key and sent to the seller. On success the voucher is " +
        "stored and d402_fetch will spend it. On a quality failure the seller does not say which items were wrong; get a new bundle.",
      inputSchema: {
        taskUrl: z.string().min(1).describe("The taskUrl the bundle came from."),
        bundleId: z.string().min(1).describe("bundleId from d402_get_bundle."),
        answers: z.record(z.string(), z.string()).describe("Map of item id to one label."),
      },
      annotations: { openWorldHint: true },
    },
    async ({ taskUrl, bundleId, answers }) => {
      const bundle = bundles.get(bundleId);
      if (!bundle) {
        return fail(
          `Unknown bundleId "${bundleId}". Bundles are remembered only after d402_get_bundle in this server; call d402_get_bundle first.`,
          { code: "unknown_bundle" },
        );
      }
      if (bundle.expiresAt <= now()) {
        bundles.delete(bundleId);
        return fail(`Bundle ${bundleId} expired at ${bundle.expiresAt}. Call d402_get_bundle for a fresh bundle.`, {
          code: "expired_bundle",
        });
      }
      const problem = validateAnswers(bundle, answers);
      if (problem) {
        const parts: string[] = [];
        if (problem.missing.length) parts.push(`${problem.missing.length} item(s) have no answer: ${problem.missing.join(", ")}`);
        if (problem.badLabels.length)
          parts.push(
            `label not in bundle labels for ${problem.badLabels.map((b) => `${b.id}="${b.label}"`).join(", ")} (allowed: ${bundle.labels.join(", ")})`,
          );
        if (problem.unknownIds.length) parts.push(`answers for ids not in the bundle: ${problem.unknownIds.join(", ")}`);
        return fail(`Answers rejected before submission: ${parts.join("; ")}. Fix them and call d402_submit again.`, {
          code: "invalid_answers",
          ...problem,
          labels: bundle.labels,
        });
      }
      try {
        const o = originOf(taskUrl);
        const accept = (o && acceptsByOrigin.get(o)) || undefined;
        const v = await client.submit(taskUrl, bundle, answers, accept);
        bundles.delete(bundleId);
        return ok({
          jti: v.jti,
          sellerId: v.sellerId,
          calls: v.calls,
          scope: v.scope,
          expiresAt: v.expiresAt,
          hint: `Voucher stored. d402_fetch on ${v.sellerId} paths under ${v.scope.join(", ")} will spend it (${v.calls} calls).`,
        });
      } catch (err) {
        const d = describeError(err);
        if (d.code === "quality" || d.status === 422) {
          bundles.delete(bundleId);
          return fail(
            "The seller rejected this bundle for quality. It never reveals which items were wrong. Call d402_get_bundle to get a different bundle and try again.",
            { code: "quality", status: 422 },
          );
        }
        if (d.code === "expired_bundle" || d.code === "already_submitted" || d.code === "unknown_bundle") {
          bundles.delete(bundleId);
          return fail(`Submission failed (${d.code}): ${d.message}. Call d402_get_bundle for a fresh bundle.`, {
            code: d.code,
            status: d.status,
          });
        }
        return failFrom("submission failed", err);
      }
    },
  );

  type FetchOutcome =
    | { kind: "response"; res: Response }
    | { kind: "needsVoucher"; offer?: Offer; accept?: D402Accept };

  /**
   * One request through the client. A 402 carrying a d402 offer (as a response,
   * or as the body of a thrown D402Error) and the client's own "no_solver"
   * error (it saw a 402 and has no solver to earn with) both mean "needs a voucher".
   */
  async function doFetch(url: string, init: RequestInit, origin: string | undefined): Promise<FetchOutcome> {
    try {
      const res = await client.fetch(url, init);
      if (res.status === 402) {
        const offer = parseOffer(await res.clone().text());
        const accept = offer ? findD402Accept(offer) : undefined;
        if (offer && accept) {
          rememberAccept(url, accept);
          return { kind: "needsVoucher", offer, accept };
        }
      }
      return { kind: "response", res };
    } catch (err) {
      if (isD402ErrorLike(err)) {
        if (err.status === 402) {
          const offer = parseOffer(err.body);
          const accept = offer ? findD402Accept(offer) : undefined;
          if (offer && accept) {
            rememberAccept(url, accept);
            return { kind: "needsVoucher", offer, accept };
          }
        }
        if (err.code === "no_solver") {
          const accept = origin ? await ensureAccept(origin) : undefined;
          return { kind: "needsVoucher", accept };
        }
      }
      throw err;
    }
  }

  async function formatResponse(res: Response): Promise<CallToolResult> {
    const text = await res.text();
    const bytes = Buffer.byteLength(text, "utf8");
    let body = text;
    let truncated = false;
    if (bytes > maxBodyBytes) {
      body = Buffer.from(text, "utf8").subarray(0, maxBodyBytes).toString("utf8");
      truncated = true;
    }
    const headers: Record<string, string> = {};
    const ct = res.headers.get("content-type");
    if (ct) headers["content-type"] = ct;
    const remaining = res.headers.get(HEADERS.callsRemaining);
    if (remaining !== null) headers[HEADERS.callsRemaining] = remaining;
    const data: Record<string, unknown> = { status: res.status, ok: res.ok, headers, body, truncated, bodyBytes: bytes };
    return ok(data);
  }

  server.registerTool(
    "d402_fetch",
    {
      title: "Fetch with a d402 voucher",
      description:
        "HTTP request that attaches a cached d402 voucher when one covers the URL. Returns status, a few headers " +
        "(content-type, D402-Calls-Remaining) and the body text (truncated at 64KB). If the seller answers 402 with a d402 " +
        "offer and autoEarn is false, the offer is returned with instructions to earn via d402_get_bundle + d402_submit. " +
        "With autoEarn true the configured solver command (D402_SOLVER_CMD) labels a bundle and the request is retried.",
      inputSchema: {
        url: z.string().min(1).describe("Absolute URL to request."),
        method: z.string().min(1).optional().describe("HTTP method, default GET."),
        headers: z.record(z.string(), z.string()).optional().describe("Extra request headers."),
        body: z.string().optional().describe("Request body (string)."),
        autoEarn: z.boolean().optional().describe("Earn a voucher automatically with the solver command on 402. Default false."),
      },
      annotations: { openWorldHint: true },
    },
    async ({ url, method, headers, body, autoEarn }) => {
      const origin = originOf(url);
      if (!origin) return fail(`url must be absolute: ${url}`, { code: "bad_url" });
      const init: RequestInit = { method: (method ?? "GET").toUpperCase() };
      if (headers) init.headers = headers;
      if (body !== undefined) init.body = body;

      // Learn the seller up front so a persisted voucher is used on the first request.
      await ensureAccept(origin);

      for (let attempt = 0; attempt <= maxEarnAttempts; attempt++) {
        let outcome: FetchOutcome;
        try {
          outcome = await doFetch(url, init, origin);
        } catch (err) {
          return failFrom(`fetch failed for ${url}`, err);
        }
        if (outcome.kind === "response") return formatResponse(outcome.res);

        const { offer, accept } = outcome;
        if (!accept) {
          return fail(
            `${url} requires a d402 voucher but the seller's offer could not be read. Call d402_discover with the seller's base URL, then d402_get_bundle and d402_submit.`,
            { code: "offer_unavailable", status: 402 },
          );
        }
        if (!autoEarn) {
          return ok({
            status: 402,
            needsVoucher: true,
            reason: offer?.error ?? "missing_voucher",
            sellerMessage: offer?.message,
            offer: acceptSummary(accept),
            instructions:
              `This URL requires a d402 voucher. Call d402_get_bundle { taskUrl: "${accept.taskUrl}", tier: "${smallestTier(accept.tiers).id}" } ` +
              "(or a bigger tier for more calls), label every item, call d402_submit, then call d402_fetch again with the same arguments.",
          });
        }
        if (!opts.solver) {
          return fail(
            "autoEarn requested but no solver is configured. Start d402-mcp with D402_SOLVER_CMD set to a command that reads the bundle JSON on stdin and prints answers JSON on stdout, " +
              `or earn manually: d402_get_bundle { taskUrl: "${accept.taskUrl}" }, label the items, d402_submit, then d402_fetch again.`,
            { code: "no_solver", offer: acceptSummary(accept) },
          );
        }
        if (attempt === maxEarnAttempts) break;
        const tier = pickTier(accept, opts.defaultTier) ?? smallestTier(accept.tiers);
        try {
          const bundle = await client.getBundle(accept.taskUrl, tier.id);
          const answers = await opts.solver(bundle);
          const problem = validateAnswers(bundle, answers);
          if (problem) {
            return fail("solver returned incomplete or invalid answers", { code: "invalid_answers", ...problem });
          }
          await client.submit(accept.taskUrl, bundle, answers, accept);
        } catch (err) {
          const d = describeError(err);
          if (d.code === "quality" || d.status === 422) continue;
          return failFrom("autoEarn failed", err);
        }
      }
      return fail(`Could not earn a voucher for ${url} after ${maxEarnAttempts} attempts (bundles kept failing quality).`, {
        code: "earn_failed",
      });
    },
  );

  server.registerTool(
    "d402_status",
    {
      title: "d402 status",
      description: "List cached vouchers (jti, sellerId, calls, expiresAt, scope) and this agent's public key.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => {
      let vouchers;
      try {
        vouchers = await client.status();
      } catch (err) {
        return failFrom("status failed", err);
      }
      const t = now();
      return ok({
        publicKey: client.keypair.publicKey,
        now: t,
        vouchers: vouchers.map((v) => ({
          jti: v.jti,
          sellerId: v.sellerId,
          calls: v.calls,
          expiresAt: v.expiresAt,
          scope: v.scope,
          expired: v.expiresAt <= t,
        })),
        pendingBundles: [...bundles.keys()],
      });
    },
  );

  return server;
}
