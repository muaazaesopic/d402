/**
 * Shared fixtures for the d402 end-to-end tests.
 *
 * The seller is a real @d402/server behind a real HTTP listener on an
 * ephemeral port, and the agent is a real @d402/client talking to it over
 * globalThis.fetch.
 *
 * NOTE on the HTTP listener: neither `hono` nor `@hono/node-server` resolve
 * from tests/e2e (they are installed only under packages/server, bench and
 * examples, and pnpm does not hoist them to the root). `d402.routes` is
 * already a Hono instance, so it is used as the app, and `listen()` below is a
 * ~30 line node:http adapter that does what @hono/node-server does: build a
 * Request from the IncomingMessage, call `app.fetch(request, { incoming })`,
 * write the Response back. `{ incoming }` is passed as the Hono env so the
 * seller's clientIp() sees the socket address exactly as it would under
 * @hono/node-server.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { createD402, type D402Server, type D402ServerOptions } from "@d402/server";
import {
  HEADERS,
  generateKeypair,
  signSubmit,
  type Answers,
  type Bundle,
  type Keypair,
  type TaskFileItem,
  type Tier,
} from "@d402/spec";
import { createD402Client, type D402Client, type Solver, type VoucherCache } from "@d402/client";

// ---------------------------------------------------------------------------
// Constants (SPEC 3)
// ---------------------------------------------------------------------------

export const LABELS = ["sports", "business", "tech", "world"] as const;
export type Label = (typeof LABELS)[number];

export const TIERS: Tier[] = [
  { id: "s", items: 5, est_tokens: 1000, reward: { calls: 10 } },
  { id: "m", items: 25, est_tokens: 5000, reward: { calls: 60 } },
  { id: "l", items: 50, est_tokens: 10000, reward: { calls: 150 } },
];

export const SELLER_ID = "test-seller";
export const SECRET = "test-secret";

// ---------------------------------------------------------------------------
// Seeded PRNG (mulberry32)
// ---------------------------------------------------------------------------

export function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(rng: () => number, arr: readonly T[]): T {
  return arr[Math.floor(rng() * arr.length)]!;
}

// ---------------------------------------------------------------------------
// Deterministic classify pool
// ---------------------------------------------------------------------------

const TEMPLATES: Record<Label, string[]> = {
  sports: [
    "{team} beat {team2} {n}-{m} in the {league} final on {day}",
    "{player} scored twice as {team} edged {team2} in overtime",
    "{team} sign {player} ahead of the {league} playoffs",
  ],
  business: [
    "{company} shares rose {n}% after quarterly earnings beat forecasts",
    "{company} to acquire {company2} in a ${n} billion deal",
    "Central bank holds rates as {company} warns of slowing demand",
  ],
  tech: [
    "{company} releases new {gadget} with faster chip and longer battery",
    "Researchers at {company} train a model that beats benchmarks on {gadget} tasks",
    "{company} patches a critical bug in its {gadget} firmware",
  ],
  world: [
    "Leaders of {country} and {country2} meet to discuss border trade",
    "Elections in {country} head to a runoff after a tight first round",
    "Floods displace thousands in {country} as rains continue",
  ],
};

const FILL: Record<string, string[]> = {
  team: ["Lions", "Tigers", "Rovers", "United", "City", "Wanderers"],
  team2: ["Hawks", "Sharks", "Athletic", "Royals", "Kings", "Comets"],
  player: ["Ortega", "Nakamura", "Smith", "Okafor", "Dubois", "Petrov"],
  league: ["cup", "league", "championship", "derby"],
  day: ["Saturday", "Sunday", "Monday", "Friday"],
  company: ["Acme", "Globex", "Initech", "Umbrella", "Vandelay", "Hooli"],
  company2: ["Stark", "Wayne", "Wonka", "Tyrell", "Cyberdyne", "Soylent"],
  gadget: ["phone", "laptop", "headset", "watch", "router", "drone"],
  country: ["Atlantis", "Freedonia", "Genovia", "Zubrowka", "Elbonia", "Latveria"],
  country2: ["Sokovia", "Wakanda", "Qumar", "Krakozhia", "Florin", "Guilder"],
};

export interface Pool {
  items: TaskFileItem[];
  /** id -> true label for every item, golden or not. */
  truth: Map<string, Label>;
  /** ids of the control items (the seller knows these; agents do not). */
  goldenIds: Set<string>;
}

/**
 * `n` items, labels cycling evenly through LABELS, every 1/goldenFraction-th
 * item golden. Deterministic for a given seed.
 */
export function generatePool(n = 400, goldenFraction = 0.25, seed = 7): Pool {
  const rng = seeded(seed);
  const items: TaskFileItem[] = [];
  const truth = new Map<string, Label>();
  const goldenIds = new Set<string>();
  const every = goldenFraction > 0 ? Math.round(1 / goldenFraction) : Infinity;
  for (let i = 0; i < n; i++) {
    // Offset the label cycle by the golden index so goldens (every `every`-th
    // item) also cycle through all four labels instead of sharing one.
    const label = LABELS[(i + Math.floor(i / every)) % LABELS.length]!;
    const template = pick(rng, TEMPLATES[label]);
    const text = template.replace(/\{(\w+)\}/g, (_, k: string) => {
      if (k === "n") return String(1 + Math.floor(rng() * 9));
      if (k === "m") return String(Math.floor(rng() * 5));
      return pick(rng, FILL[k]!);
    });
    const golden = i % every === 0;
    const id = (golden ? "g_" : "u_") + String(i).padStart(4, "0");
    const item: TaskFileItem = { id, type: "classify", text };
    if (golden) {
      item.golden = label;
      goldenIds.add(id);
    }
    items.push(item);
    truth.set(id, label);
  }
  return { items, truth, goldenIds };
}

// ---------------------------------------------------------------------------
// Solvers
// ---------------------------------------------------------------------------

export function perfectSolver(truth: Map<string, string>): Solver {
  return async (bundle) => {
    const out: Answers = {};
    for (const it of bundle.items) out[it.id] = truth.get(it.id) ?? bundle.labels[0]!;
    return out;
  };
}

/** Right with probability p, otherwise a uniformly chosen wrong label. */
export function honestSolver(truth: Map<string, string>, p: number, seed = 1): Solver {
  const rng = seeded(seed);
  return async (bundle) => {
    const out: Answers = {};
    for (const it of bundle.items) {
      const right = truth.get(it.id) ?? bundle.labels[0]!;
      if (rng() < p) out[it.id] = right;
      else out[it.id] = pick(rng, bundle.labels.filter((l) => l !== right));
    }
    return out;
  };
}

/** Answers the first label for everything. */
export function lazySolver(): Solver {
  return async (bundle) => {
    const out: Answers = {};
    for (const it of bundle.items) out[it.id] = bundle.labels[0]!;
    return out;
  };
}

/** Always wrong: the label after the true one. */
export function wrongSolver(truth: Map<string, string>): Solver {
  return async (bundle) => {
    const out: Answers = {};
    for (const it of bundle.items) {
      const right = truth.get(it.id) ?? bundle.labels[0]!;
      const i = bundle.labels.indexOf(right);
      out[it.id] = bundle.labels[(i + 1) % bundle.labels.length]!;
    }
    return out;
  };
}

// ---------------------------------------------------------------------------
// Seller
// ---------------------------------------------------------------------------

export interface Clock {
  /** Unix seconds; the seller reads it on every request. */
  t: number;
}

export interface SellerOverrides extends Partial<Omit<D402ServerOptions, "now" | "taskUrl">> {
  /** Replace the generated pool (default generatePool(400, 0.25)). [] loads nothing. */
  pool?: Pool;
  poolSize?: number;
  goldenFraction?: number;
  poolSeed?: number;
  /** Seed for the seller's RNG (golden sampling, shuffling). Default 42. */
  rngSeed?: number;
  /** Starting clock value. Default: now. */
  startAt?: number;
}

export interface Seller {
  baseUrl: string;
  taskUrl: string;
  d402: D402Server;
  /** The Hono app (d402.routes, with the gated routes mounted on it). */
  app: D402Server["routes"];
  clock: Clock;
  truth: Map<string, Label>;
  goldenIds: Set<string>;
  pool: Pool;
  /** Bodies received by POST /search, oldest first. */
  received: unknown[];
  server: Server;
  close(): Promise<void>;
}

/** Minimal node:http -> fetch adapter (see the file header). */
export function listen(app: { fetch: (req: Request, env?: unknown) => Response | Promise<Response> }): Promise<Server> {
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const method = req.method ?? "GET";
      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers)) {
        if (v === undefined) continue;
        if (Array.isArray(v)) for (const x of v) headers.append(k, x);
        else headers.set(k, v);
      }
      const url = `http://${req.headers.host ?? "127.0.0.1"}${req.url ?? "/"}`;
      const body = method === "GET" || method === "HEAD" || chunks.length === 0 ? undefined : Buffer.concat(chunks);
      const request = new Request(url, { method, headers, body });
      const response = await app.fetch(request, { incoming: req });
      const out: Record<string, string> = {};
      response.headers.forEach((v, k) => (out[k] = v));
      const buf = Buffer.from(await response.arrayBuffer());
      res.writeHead(response.status, out);
      res.end(buf);
    } catch (e) {
      res.writeHead(500, { "content-type": "text/plain" });
      res.end(String(e));
    }
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

export async function startSeller(over: SellerOverrides = {}): Promise<Seller> {
  const {
    pool: poolOverride,
    poolSize,
    goldenFraction,
    poolSeed,
    rngSeed,
    startAt,
    scope: scopeOverride,
    ...rest
  } = over;
  const clock: Clock = { t: startAt ?? Math.floor(Date.now() / 1000) };
  const pool = poolOverride ?? generatePool(poolSize ?? 400, goldenFraction ?? 0.25, poolSeed ?? 7);
  const scope = scopeOverride ?? ["/search"];

  // The port is not known until the socket is bound, so start the listener on
  // a throwaway app first? No: Hono's fetch is late-bound through the d402
  // routes object, so we bind the port, then build the seller with the real
  // absolute taskUrl, then swap in its fetch.
  let app: D402Server["routes"] | undefined;
  const server = await listen({ fetch: (req, env) => app!.fetch(req, env) });
  const port = (server.address() as AddressInfo).port;
  const baseUrl = `http://127.0.0.1:${port}`;
  const taskUrl = `${baseUrl}/.well-known/d402/tasks`;

  const d402 = createD402({
    sellerId: SELLER_ID,
    taskUrl,
    scope,
    tiers: TIERS,
    secret: SECRET,
    labels: [...LABELS],
    now: () => clock.t,
    random: seeded(rngSeed ?? 42),
    ...rest,
  });
  if (pool.items.length) d402.tasks.load(pool.items);

  app = d402.routes;
  const received: unknown[] = [];
  app.get("/health", (c) => c.json({ ok: true }));
  app.use("/search", d402.gate);
  app.use("/search/*", d402.gate);
  app.get("/search", (c) => {
    const q = c.req.query("q") ?? "";
    return c.json({ q, hits: [{ id: 1, title: `result for ${q}` }] });
  });
  app.post("/search", async (c) => {
    const body: unknown = await c.req.json().catch(() => null);
    received.push(body);
    const q = body && typeof body === "object" && "q" in body ? String((body as { q: unknown }).q) : "";
    return c.json({ q, hits: [{ id: 1, title: `result for ${q}` }], viaPost: true });
  });
  app.get("/search/:kind", (c) => c.json({ kind: c.req.param("kind"), hits: [] }));

  return {
    baseUrl,
    taskUrl,
    d402,
    app,
    clock,
    truth: pool.truth,
    goldenIds: pool.goldenIds,
    pool,
    received,
    server,
    close: () =>
      new Promise<void>((resolve) => {
        d402.close();
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

// ---------------------------------------------------------------------------
// Agents
// ---------------------------------------------------------------------------

export interface AgentOptions {
  solver?: Solver;
  model?: string;
  tier?: string;
  cache?: VoucherCache;
  signSpends?: boolean;
  keypair?: Keypair;
  maxEarnAttempts?: number;
  now?: () => number;
}

export function newAgent(_baseUrl: string, opts: AgentOptions = {}): D402Client {
  const keypair = opts.keypair ?? generateKeypair();
  return createD402Client({
    keypair,
    solver: opts.solver,
    model: opts.model,
    tier: opts.tier,
    cache: opts.cache,
    signSpends: opts.signSpends,
    maxEarnAttempts: opts.maxEarnAttempts,
    now: opts.now,
  });
}

// ---------------------------------------------------------------------------
// Hand-rolled HTTP helpers (for the abuse tests)
// ---------------------------------------------------------------------------

export interface RawResult<T = unknown> {
  status: number;
  headers: Headers;
  body: T;
}

export async function rawJson<T = unknown>(res: Response): Promise<RawResult<T>> {
  const text = await res.text();
  let body: unknown = text;
  try {
    body = text ? JSON.parse(text) : undefined;
  } catch {
    // leave as text
  }
  return { status: res.status, headers: res.headers, body: body as T };
}

export async function rawGetBundle(
  seller: Pick<Seller, "taskUrl">,
  publicKey: string,
  tier = "s",
  extra: Record<string, string> = {},
): Promise<RawResult<Bundle & { error?: string; message?: string }>> {
  const res = await fetch(`${seller.taskUrl}?tier=${encodeURIComponent(tier)}`, {
    headers: { [HEADERS.key]: publicKey, ...extra },
  });
  return rawJson(res);
}

export interface RawSubmitOptions {
  /** Public key header; default kp.publicKey. */
  key?: string;
  /** Precomputed signature; default signSubmit with kp. */
  sig?: string;
  model?: string;
  /** Raw body override (string sent as is). */
  rawBody?: string;
  extraHeaders?: Record<string, string>;
}

export async function rawSubmit(
  seller: Pick<Seller, "taskUrl">,
  kp: Keypair,
  bundleId: string,
  answers: Answers,
  o: RawSubmitOptions = {},
): Promise<RawResult<{ voucher?: string; calls?: number; scope?: string[]; expiresAt?: number; error?: string; message?: string }>> {
  const sig = o.sig ?? signSubmit(kp.privateKey, bundleId, answers);
  const payload: Record<string, unknown> = { answers, sig };
  if (o.model) payload.model = o.model;
  const res = await fetch(`${seller.taskUrl}/${encodeURIComponent(bundleId)}`, {
    method: "POST",
    headers: { "content-type": "application/json", [HEADERS.key]: o.key ?? kp.publicKey, ...(o.extraHeaders ?? {}) },
    body: o.rawBody ?? JSON.stringify(payload),
  });
  return rawJson(res);
}

/** GET+solve+submit by hand; returns the raw submit result and the bundle. */
export async function rawEarn(
  seller: Pick<Seller, "taskUrl">,
  kp: Keypair,
  solver: Solver,
  tier = "s",
  extra: Record<string, string> = {},
) {
  const got = await rawGetBundle(seller, kp.publicKey, tier, extra);
  if (got.status !== 200) throw new Error(`getBundle ${got.status}: ${JSON.stringify(got.body)}`);
  const bundle = got.body as Bundle;
  const answers = await solver(bundle);
  const sub = await rawSubmit(seller, kp, bundle.bundleId, answers);
  return { bundle, answers, sub };
}

/** Spend a voucher token on a gated path with hand-made headers. */
export async function rawSpend(
  seller: Pick<Seller, "baseUrl">,
  token: string | undefined,
  path = "/search?q=x",
  headers: Record<string, string> = {},
  init: RequestInit = {},
): Promise<RawResult<{ error?: string; message?: string; q?: string; hits?: unknown[] }>> {
  const h: Record<string, string> = { ...headers };
  if (token !== undefined) h[HEADERS.voucher] = token;
  const res = await fetch(`${seller.baseUrl}${path}`, { ...init, headers: h });
  return rawJson(res);
}

export function answersFor(bundle: Bundle, truth: Map<string, string>): Answers {
  const out: Answers = {};
  for (const it of bundle.items) out[it.id] = truth.get(it.id) ?? bundle.labels[0]!;
  return out;
}

export function decodeJwtPayload(token: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(token.split(".")[1]!, "base64url").toString("utf8")) as Record<string, unknown>;
}

export function tamperJwtSignature(token: string): string {
  // Flip a character in the middle of the signature. The last base64url character
  // of a 32-byte HMAC carries only 2 real bits plus padding, so flipping it can
  // leave the decoded bytes unchanged and the token valid.
  const parts = token.split(".");
  const sig = parts[2]!;
  const i = 10;
  const replacement = sig[i] === "A" ? "B" : "A";
  parts[2] = sig.slice(0, i) + replacement + sig.slice(i + 1);
  return parts.join(".");
}
