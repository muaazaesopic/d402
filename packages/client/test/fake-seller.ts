import { createHmac } from "node:crypto";
import {
  HEADERS,
  WELL_KNOWN_PATH,
  WELL_KNOWN_TASKS_PATH,
  verifySpend,
  verifySubmit,
  type D402Accept,
  type Offer,
  type Tier,
} from "@d402/spec";

export interface LoggedRequest {
  method: string;
  url: string;
  path: string;
  headers: Record<string, string>;
  body?: string;
  /** For spend requests: whether 7.1 headers were present and verified. */
  spendSig?: "missing" | "valid" | "invalid";
  spendNonce?: string;
}

export interface FakeSellerOptions {
  origin?: string;
  sellerId?: string;
  scope?: string[];
  tiers?: Tier[];
  bindVouchers?: boolean;
  now?: () => number;
  voucherTtl?: number;
  bundleTtl?: number;
  labels?: string[];
  goldenRatio?: number;
}

interface IssuedBundle {
  bundleId: string;
  tier: string;
  items: Array<{ id: string; text: string }>;
  goldens: Map<string, string>;
  expiresAt: number;
  submitted: boolean;
}

export interface VoucherState {
  jti: string;
  sub: string;
  scope: string[];
  exp: number;
  calls: number;
}

export interface FakeSeller {
  fetch: typeof fetch;
  requests: LoggedRequest[];
  offer: Offer;
  accept: D402Accept;
  bundles: Map<string, IssuedBundle>;
  vouchers: Map<string, VoucherState>;
  bundlesIssued: number;
  submits: number;
  /** Answer for an item, derived from its text (the oracle). */
  answerFor(item: { id: string; text: string }): string;
}

const SECRET = "fake-seller-secret";
const b64u = (s: string | Buffer) => Buffer.from(s).toString("base64url");

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

export function createFakeSeller(opts: FakeSellerOptions = {}): FakeSeller {
  const origin = opts.origin ?? "https://api.test";
  const sellerId = opts.sellerId ?? "api.test";
  const scope = opts.scope ?? ["/search", "/echo"];
  const tiers: Tier[] = opts.tiers ?? [
    { id: "m", items: 5, est_tokens: 1000, reward: { calls: 6 } },
    { id: "s", items: 2, est_tokens: 400, reward: { calls: 3 } },
    { id: "l", items: 10, est_tokens: 2000, reward: { calls: 20 } },
  ];
  const now = opts.now ?? (() => Math.floor(Date.now() / 1000));
  const voucherTtl = opts.voucherTtl ?? 86_400;
  const bundleTtl = opts.bundleTtl ?? 600;
  const labels = opts.labels ?? ["sports", "tech", "world"];
  const goldenRatio = opts.goldenRatio ?? 0.4;
  const taskUrl = origin + WELL_KNOWN_TASKS_PATH;

  const accept: D402Accept = {
    scheme: "d402",
    sellerId,
    taskUrl,
    taskTypes: ["classify"],
    scope,
    voucherTtl,
    tiers,
  };
  const offer: Offer = {
    d402: "1",
    accepts: [{ scheme: "exact", network: "base", amount: "1000" }, accept],
  };

  const state: FakeSeller = {
    fetch: undefined as unknown as typeof fetch,
    requests: [],
    offer,
    accept,
    bundles: new Map(),
    vouchers: new Map(),
    bundlesIssued: 0,
    submits: 0,
    answerFor: (item) => item.text.split(" ").pop()!,
  };

  let seq = 0;

  function offerResponse(error?: string, message?: string): Response {
    return json(402, { ...offer, ...(error ? { error, message: message ?? error } : {}) });
  }

  function mintVoucher(sub: string): { token: string; jti: string; exp: number } {
    const jti = `v_${++seq}`;
    const iat = now();
    const exp = iat + voucherTtl;
    const header = b64u(JSON.stringify({ alg: "HS256", typ: "JWT" }));
    const payload = b64u(JSON.stringify({ iss: sellerId, sub, scope, jti, iat, exp }));
    const sig = createHmac("sha256", SECRET).update(`${header}.${payload}`).digest("base64url");
    return { token: `${header}.${payload}.${sig}`, jti, exp };
  }

  function verifyVoucher(token: string): Record<string, unknown> | undefined {
    const parts = token.split(".");
    if (parts.length !== 3) return undefined;
    const expected = createHmac("sha256", SECRET).update(`${parts[0]}.${parts[1]}`).digest("base64url");
    if (expected !== parts[2]) return undefined;
    try {
      return JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8")) as Record<string, unknown>;
    } catch {
      return undefined;
    }
  }

  async function handle(req: Request, log: LoggedRequest): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;
    const key = req.headers.get(HEADERS.key);

    if (path === WELL_KNOWN_PATH) return json(200, offer);

    if (path === WELL_KNOWN_TASKS_PATH && req.method === "GET") {
      if (!key) return json(400, { error: "missing_key", message: "D402-Key required" });
      const tierId = url.searchParams.get("tier");
      const tier = tiers.find((t) => t.id === tierId);
      if (!tier) return json(400, { error: "bad_tier", message: `unknown tier ${tierId}` });
      const bundleId = `b_${++seq}`;
      const items: IssuedBundle["items"] = [];
      const goldens = new Map<string, string>();
      const goldenCount = Math.max(1, Math.round(tier.items * goldenRatio));
      for (let k = 0; k < tier.items; k++) {
        const label = labels[(k + seq) % labels.length]!;
        const id = `${bundleId}_i${k}`;
        items.push({ id, text: `a story about ${label}` });
        if (k < goldenCount) goldens.set(id, label);
      }
      const bundle: IssuedBundle = { bundleId, tier: tier.id, items, goldens, expiresAt: now() + bundleTtl, submitted: false };
      state.bundles.set(bundleId, bundle);
      state.bundlesIssued++;
      return json(200, {
        bundleId,
        tier: tier.id,
        type: "classify",
        instructions: "Label each item with exactly one of the labels.",
        labels,
        items,
        expiresAt: bundle.expiresAt,
      });
    }

    if (path.startsWith(WELL_KNOWN_TASKS_PATH + "/") && req.method === "POST") {
      state.submits++;
      if (!key) return json(400, { error: "missing_key", message: "D402-Key required" });
      const bundleId = decodeURIComponent(path.slice(WELL_KNOWN_TASKS_PATH.length + 1));
      const bundle = state.bundles.get(bundleId);
      if (!bundle) return json(404, { error: "unknown_bundle", message: "unknown bundle" });
      if (bundle.submitted) return json(409, { error: "already_submitted", message: "already submitted" });
      if (bundle.expiresAt <= now()) return json(410, { error: "expired_bundle", message: "bundle expired" });
      let body: { answers?: Record<string, string>; sig?: string; model?: string };
      try {
        body = JSON.parse(log.body ?? "");
      } catch {
        return json(400, { error: "bad_request", message: "bad json" });
      }
      if (!body.answers || typeof body.sig !== "string") return json(400, { error: "bad_request", message: "bad body" });
      if (!verifySubmit(key, bundleId, body.answers, body.sig)) {
        return json(401, { error: "bad_signature", message: "signature does not verify" });
      }
      for (const item of bundle.items) {
        const a = body.answers[item.id];
        if (a === undefined) return json(422, { error: "incomplete", message: `no answer for ${item.id}` });
        if (!labels.includes(a)) return json(422, { error: "bad_label", message: `bad label ${a}` });
      }
      bundle.submitted = true;
      let correct = 0;
      for (const [id, golden] of bundle.goldens) if (body.answers[id] === golden) correct++;
      const g = bundle.goldens.size;
      const passed = g === 1 ? correct === 1 : correct / g >= 0.8;
      if (!passed) return json(422, { error: "quality", message: "bundle failed quality check" });
      const tier = tiers.find((t) => t.id === bundle.tier)!;
      const v = mintVoucher(key);
      state.vouchers.set(v.jti, { jti: v.jti, sub: key, scope, exp: v.exp, calls: tier.reward.calls });
      return json(200, { voucher: v.token, calls: tier.reward.calls, scope, expiresAt: v.exp });
    }

    // Special test routes
    if (path === "/x402only") {
      return json(402, { d402: "1", accepts: [{ scheme: "exact", network: "base", amount: "1000" }] });
    }
    if (path === "/text402") {
      return new Response("payment required", { status: 402, headers: { "content-type": "text/plain" } });
    }
    if (path === "/open") return json(200, { ok: true, open: true });

    // Gated routes: everything else.
    const token = req.headers.get(HEADERS.voucher);
    if (!token) return offerResponse("missing_voucher", "no voucher");
    const claims = verifyVoucher(token);
    if (!claims || typeof claims.jti !== "string") return offerResponse("voucher_invalid", "bad voucher");
    if ((claims.exp as number) <= now()) return offerResponse("voucher_expired", "voucher expired");
    if (!(claims.scope as string[]).some((p) => path.startsWith(p))) return offerResponse("scope_mismatch", "scope");
    const vs = state.vouchers.get(claims.jti);
    if (!vs) return offerResponse("voucher_invalid", "unknown jti");

    const sigKey = req.headers.get(HEADERS.key);
    const ts = req.headers.get(HEADERS.timestamp);
    const sig = req.headers.get(HEADERS.sig);
    if (sigKey && ts && sig) {
      const nonce = req.headers.get(HEADERS.nonce) ?? undefined;
      log.spendNonce = nonce;
      const ok = sigKey === vs.sub && verifySpend(sigKey, req.method, path, vs.jti, Number(ts), sig, nonce);
      log.spendSig = ok ? "valid" : "invalid";
      if (opts.bindVouchers) {
        if (Math.abs(now() - Number(ts)) > 300) return offerResponse("stale_timestamp", "stale");
        if (!ok) return offerResponse("voucher_invalid", "bad spend signature");
      }
    } else {
      log.spendSig = "missing";
      if (opts.bindVouchers) return offerResponse("voucher_invalid", "spend must be signed");
    }

    if (vs.calls <= 0) return offerResponse("voucher_exhausted", "no calls left");
    vs.calls--;
    const headers = { [HEADERS.callsRemaining]: String(vs.calls) };
    if (path === "/echo") {
      return json(200, { ok: true, method: req.method, body: log.body ?? null, ct: req.headers.get("content-type") }, headers);
    }
    if (path === "/search/fail") return json(500, { ok: false }, headers);
    return json(200, { ok: true, path, q: url.searchParams.get("q") }, headers);
  }

  state.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    const headers: Record<string, string> = {};
    req.headers.forEach((v, k) => (headers[k.toLowerCase()] = v));
    const log: LoggedRequest = { method: req.method, url: req.url, path: new URL(req.url).pathname, headers };
    if (req.body) log.body = await req.text();
    state.requests.push(log);
    return handle(req, log);
  }) as typeof fetch;

  return state;
}
