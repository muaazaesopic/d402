import {
  Bundle,
  D402Accept,
  ErrorBody,
  HEADERS,
  Offer,
  SubmitResult,
  WELL_KNOWN_PATH,
  findD402Accept,
  newNonce,
  signSpend,
  signSubmit,
  type Answers,
  type Keypair,
} from "@d402/spec";
import { MemoryVoucherCache, scopeMatches, type StoredVoucher, type VoucherCache } from "./cache.js";
import { D402Error } from "./errors.js";
import type { Solver } from "./solvers.js";

export interface D402ClientOptions {
  keypair: Keypair;
  /** Required for fetch() and earn(); getBundle()/submit() work without it. */
  solver?: Solver;
  /** Default: MemoryVoucherCache. */
  cache?: VoucherCache;
  /** Sent as D402-Model and body.model. */
  model?: string;
  /** Tier id, or a chooser. Default: the tier with the fewest items. */
  tier?: string | ((accept: D402Accept) => string);
  /** Injectable transport. Default: globalThis.fetch. */
  fetch?: typeof fetch;
  /** Unix seconds. Default: Date.now()/1000. */
  now?: () => number;
  /** How many bundles to try when one fails with 422 quality. Default 3. */
  maxEarnAttempts?: number;
  /** Send D402-Key, D402-Timestamp, D402-Sig on every spend (SPEC 7.1). Default true. */
  signSpends?: boolean;
}

export interface D402Client {
  keypair: Keypair;
  /** Drop-in fetch that attaches vouchers and earns one on 402. */
  fetch: typeof fetch;
  /** GET {base}/.well-known/d402 (a full well-known URL is used as is). */
  discover(baseUrlOrOfferUrl: string): Promise<Offer>;
  /** GET taskUrl?tier=... with D402-Key (+ D402-Model). */
  getBundle(taskUrl: string, tier: string): Promise<Bundle>;
  /** Sign and POST answers; the voucher is stored in the cache and returned. */
  submit(taskUrl: string, bundle: Bundle, answers: Answers, accept?: D402Accept): Promise<StoredVoucher>;
  /** getBundle -> solver -> submit, retrying on 422 quality up to maxEarnAttempts. */
  earn(accept: D402Accept, tier?: string): Promise<StoredVoucher>;
  /** Everything in the cache. */
  status(): Promise<StoredVoucher[]>;
}

const VOUCHER_EVICT_ERRORS = new Set(["voucher_exhausted", "voucher_expired", "voucher_invalid"]);

interface NormalizedRequest {
  url: string;
  method: string;
  headers: Headers;
  body: BodyInit | null | undefined;
  init: RequestInit;
}

async function normalizeRequest(input: RequestInfo | URL, init?: RequestInit): Promise<NormalizedRequest> {
  if (typeof Request !== "undefined" && input instanceof Request) {
    const headers = new Headers(input.headers);
    if (init?.headers) new Headers(init.headers).forEach((v, k) => headers.set(k, v));
    let body: BodyInit | null | undefined = init?.body;
    if (body === undefined && input.body !== null) {
      // Buffer a Request body so the request can be replayed after earning.
      body = await input.arrayBuffer();
    }
    const rest: RequestInit = { ...(init ?? {}) };
    if (rest.signal === undefined && input.signal) rest.signal = input.signal;
    if (rest.redirect === undefined) rest.redirect = input.redirect;
    return { url: input.url, method: (init?.method ?? input.method ?? "GET").toUpperCase(), headers, body, init: rest };
  }
  const url = typeof input === "string" ? input : input.toString();
  return {
    url,
    method: (init?.method ?? "GET").toUpperCase(),
    headers: new Headers(init?.headers),
    body: init?.body,
    init: { ...(init ?? {}) },
  };
}

function isReplayableBody(body: unknown): boolean {
  if (body === undefined || body === null) return true;
  if (typeof body === "string") return true;
  if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) return true;
  if (body instanceof URLSearchParams) return true;
  if (typeof FormData !== "undefined" && body instanceof FormData) return true;
  if (typeof Blob !== "undefined" && body instanceof Blob) return true;
  return false;
}

function decodeJwtPayload(token: string): Record<string, unknown> {
  const parts = token.split(".");
  if (parts.length < 2) throw new D402Error("bad_voucher", "voucher is not a JWT");
  try {
    const json = Buffer.from(parts[1]!, "base64url").toString("utf8");
    const payload: unknown = JSON.parse(json);
    if (!payload || typeof payload !== "object") throw new Error("payload is not an object");
    return payload as Record<string, unknown>;
  } catch (err) {
    throw new D402Error("bad_voucher", "voucher payload could not be decoded", { cause: err });
  }
}

async function readJson(res: Response): Promise<unknown> {
  const text = await res.text();
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function errorFromResponse(res: Response, body: unknown, fallbackCode: string): D402Error {
  const parsed = ErrorBody.safeParse(body);
  if (parsed.success) {
    return new D402Error(parsed.data.error, parsed.data.message ?? `${parsed.data.error} (HTTP ${res.status})`, {
      status: res.status,
      body,
    });
  }
  return new D402Error(fallbackCode, `HTTP ${res.status} from ${res.url || "seller"}`, { status: res.status, body });
}

export function smallestTier(accept: D402Accept): string {
  let best = accept.tiers[0]!;
  for (const t of accept.tiers) if (t.items < best.items) best = t;
  return best.id;
}

export function createD402Client(opts: D402ClientOptions): D402Client {
  const keypair = opts.keypair;
  const cache: VoucherCache = opts.cache ?? new MemoryVoucherCache();
  const rawFetch: typeof fetch = opts.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const now = opts.now ?? (() => Math.floor(Date.now() / 1000));
  const maxEarnAttempts = Math.max(1, opts.maxEarnAttempts ?? 3);
  const signSpends = opts.signSpends ?? true;
  /** origin -> accept learned from 402s or discover(). */
  const accepts = new Map<string, D402Accept>();

  function rememberAccept(url: string, accept: D402Accept): void {
    try {
      accepts.set(new URL(url).origin, accept);
    } catch {
      // ignore unparsable urls
    }
  }

  function pickTier(accept: D402Accept): string {
    const chosen = typeof opts.tier === "function" ? opts.tier(accept) : opts.tier;
    const id = chosen ?? smallestTier(accept);
    if (!accept.tiers.some((t) => t.id === id)) {
      throw new D402Error("bad_tier", `tier "${id}" is not offered by ${accept.sellerId}`, { body: accept.tiers });
    }
    return id;
  }

  function taskHeaders(extra?: Record<string, string>): Headers {
    const h = new Headers(extra);
    h.set(HEADERS.key, keypair.publicKey);
    if (opts.model) h.set(HEADERS.model, opts.model);
    return h;
  }

  async function discover(baseUrlOrOfferUrl: string): Promise<Offer> {
    let url: string;
    try {
      const u = new URL(baseUrlOrOfferUrl);
      url = u.pathname.replace(/\/+$/, "").endsWith(WELL_KNOWN_PATH)
        ? u.toString()
        : u.origin + u.pathname.replace(/\/+$/, "") + WELL_KNOWN_PATH;
    } catch (err) {
      throw new D402Error("bad_url", `not an absolute URL: ${baseUrlOrOfferUrl}`, { cause: err });
    }
    const res = await rawFetch(url, { method: "GET", headers: { Accept: "application/json" } });
    const body = await readJson(res);
    const parsed = Offer.safeParse(body);
    if (!parsed.success) {
      throw new D402Error("bad_offer", `no valid d402 offer at ${url} (HTTP ${res.status})`, {
        status: res.status,
        body,
      });
    }
    const accept = findD402Accept(parsed.data);
    if (accept) rememberAccept(url, accept);
    return parsed.data;
  }

  async function getBundle(taskUrl: string, tier: string): Promise<Bundle> {
    const u = new URL(taskUrl);
    u.searchParams.set("tier", tier);
    const res = await rawFetch(u.toString(), { method: "GET", headers: taskHeaders({ Accept: "application/json" }) });
    const body = await readJson(res);
    if (!res.ok) throw errorFromResponse(res, body, "bundle_failed");
    const parsed = Bundle.safeParse(body);
    if (!parsed.success) {
      throw new D402Error("bad_bundle", `seller returned an invalid bundle: ${parsed.error.message}`, {
        status: res.status,
        body,
      });
    }
    return parsed.data;
  }

  async function submit(
    taskUrl: string,
    bundle: Bundle,
    answers: Answers,
    accept?: D402Accept,
  ): Promise<StoredVoucher> {
    const sig = signSubmit(keypair.privateKey, bundle.bundleId, answers);
    const payload: Record<string, unknown> = { answers, sig };
    if (opts.model) payload.model = opts.model;
    const url = taskUrl.replace(/\/+$/, "") + "/" + encodeURIComponent(bundle.bundleId);
    const res = await rawFetch(url, {
      method: "POST",
      headers: taskHeaders({ "Content-Type": "application/json", Accept: "application/json" }),
      body: JSON.stringify(payload),
    });
    const body = await readJson(res);
    if (!res.ok) throw errorFromResponse(res, body, "submit_failed");
    const parsed = SubmitResult.safeParse(body);
    if (!parsed.success) {
      throw new D402Error("bad_submit_result", `seller returned an invalid submit result: ${parsed.error.message}`, {
        status: res.status,
        body,
      });
    }
    const result = parsed.data;
    const claims = decodeJwtPayload(result.voucher);
    const jti = typeof claims.jti === "string" ? claims.jti : undefined;
    if (!jti) throw new D402Error("bad_voucher", "voucher has no jti claim", { body: claims });
    const sellerId = accept?.sellerId ?? (typeof claims.iss === "string" ? claims.iss : undefined);
    if (!sellerId) throw new D402Error("bad_voucher", "voucher has no iss claim and no accept was given", { body: claims });
    const voucher: StoredVoucher = {
      jti,
      sellerId,
      token: result.voucher,
      scope: result.scope.length ? result.scope : accept?.scope ?? [],
      calls: result.calls,
      expiresAt: result.expiresAt,
      sub: typeof claims.sub === "string" ? claims.sub : keypair.publicKey,
      taskUrl,
    };
    await cache.put(voucher);
    if (accept) rememberAccept(taskUrl, accept);
    return voucher;
  }

  async function earn(accept: D402Accept, tier?: string): Promise<StoredVoucher> {
    const solver = opts.solver;
    if (!solver) throw new D402Error("no_solver", "a solver is required to earn vouchers");
    const tierId = tier ?? pickTier(accept);
    let last: D402Error | undefined;
    for (let attempt = 1; attempt <= maxEarnAttempts; attempt++) {
      const bundle = await getBundle(accept.taskUrl, tierId);
      const answers = await solver(bundle);
      try {
        return await submit(accept.taskUrl, bundle, answers, accept);
      } catch (err) {
        if (err instanceof D402Error && err.code === "quality") {
          last = err;
          continue;
        }
        throw err;
      }
    }
    throw new D402Error(
      "earn_failed",
      `failed quality check on ${maxEarnAttempts} bundle(s) from ${accept.sellerId}: ${last?.message ?? ""}`,
      { status: last?.status ?? 422, body: last?.body, cause: last },
    );
  }

  /**
   * On the first request to an origin this process has not seen a 402 from, a
   * persisted voucher may still apply (same origin as its taskUrl, scope matches).
   * Using it saves the 402 round trip and, for a solver-less client, is the only
   * way a cached voucher gets spent without a discover() first.
   */
  async function findByOrigin(origin: string, path: string): Promise<StoredVoucher | undefined> {
    const t = now();
    let best: StoredVoucher | undefined;
    for (const v of await cache.list()) {
      let vo: string;
      try {
        vo = new URL(v.taskUrl).origin;
      } catch {
        continue;
      }
      if (vo !== origin || v.calls <= 0 || v.expiresAt <= t || !scopeMatches(v.scope, path)) continue;
      if (!best || v.expiresAt < best.expiresAt) best = v;
    }
    return best;
  }

  async function send(req: NormalizedRequest, voucher: StoredVoucher | undefined, path: string): Promise<Response> {
    const headers = new Headers(req.headers);
    if (voucher) {
      headers.set(HEADERS.voucher, voucher.token);
      if (signSpends) {
        const ts = now();
        const nonce = newNonce();
        headers.set(HEADERS.key, keypair.publicKey);
        headers.set(HEADERS.timestamp, String(ts));
        headers.set(HEADERS.nonce, nonce);
        headers.set(HEADERS.sig, signSpend(keypair.privateKey, req.method, path, voucher.jti, ts, nonce));
      }
    }
    return rawFetch(req.url, { ...req.init, method: req.method, headers, body: req.body });
  }

  async function noteCalls(res: Response, voucher: StoredVoucher | undefined): Promise<void> {
    if (!voucher) return;
    const raw = res.headers.get(HEADERS.callsRemaining);
    if (raw === null) return;
    const n = Number.parseInt(raw, 10);
    if (Number.isFinite(n)) await cache.setCalls(voucher.jti, n);
  }

  async function readOffer(res: Response): Promise<Offer | undefined> {
    let body: unknown;
    try {
      body = await readJson(res.clone());
    } catch {
      return undefined;
    }
    const parsed = Offer.safeParse(body);
    return parsed.success ? parsed.data : undefined;
  }

  const wrappedFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const req = await normalizeRequest(input, init);
    const url = new URL(req.url);
    const path = url.pathname;

    let voucher: StoredVoucher | undefined;
    const known = accepts.get(url.origin);
    if (known) voucher = await cache.find(known.sellerId, path, now());
    else voucher = await findByOrigin(url.origin, path);

    const first = await send(req, voucher, path);
    if (first.status !== 402) {
      await noteCalls(first, voucher);
      return first;
    }

    const offer = await readOffer(first);
    const accept = offer ? findD402Accept(offer) : undefined;
    if (!offer || !accept) return first;
    accepts.set(url.origin, accept);

    if (voucher && offer.error && VOUCHER_EVICT_ERRORS.has(offer.error)) {
      await cache.remove(voucher.jti);
    }
    // The offer says which paths a voucher would cover. Earning for a path outside
    // that scope can never succeed, so hand the 402 back instead of wasting a bundle.
    if (!scopeMatches(accept.scope, path)) return first;
    // The 402 just taught us the sellerId. A voucher earned earlier (another process,
    // or a seller reached through a different host) may already cover this path.
    if (!voucher) {
      const cached = await cache.find(accept.sellerId, path, now());
      if (cached) {
        const viaCache = await send(req, cached, path);
        if (viaCache.status !== 402) {
          await noteCalls(viaCache, cached);
          return viaCache;
        }
        const o2 = await readOffer(viaCache);
        if (o2?.error && VOUCHER_EVICT_ERRORS.has(o2.error)) await cache.remove(cached.jti);
      }
    }
    if (!isReplayableBody(req.body)) {
      throw new D402Error(
        "unreplayable_body",
        `request body for ${req.method} ${req.url} is a stream and cannot be replayed after earning a voucher`,
        { status: 402, body: offer },
      );
    }

    const fresh = await earn(accept);
    const second = await send(req, fresh, path);
    if (second.status !== 402) await noteCalls(second, fresh);
    return second;
  };

  return {
    keypair,
    fetch: wrappedFetch as typeof fetch,
    discover,
    getBundle,
    submit,
    earn,
    status: () => cache.list(),
  };
}
