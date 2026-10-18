/**
 * 03 rate limit upgrade: a free tier that upgrades with work instead of a 429.
 *
 * A weather API allows 5 requests per minute per IP. The 6th request does not
 * get a 429; it gets the d402 402 offer. The agent labels a bundle and keeps
 * going on the paid tier, where a voucher pays per call.
 */
import { Hono } from "hono";
import { serve, type HttpBindings } from "@hono/node-server";
import { createD402 } from "@d402/server";
import { createD402Client, createLookupSolver } from "@d402/client";
import { HEADERS, generateKeypair, type Bundle } from "@d402/spec";
import { DOMAINS, generateDataset, hash32, mulberry32, noisyLookup, toTaskFile, truthMap } from "../../_shared/gen.js";
import { createLog, isMain, listen, runMain } from "../../_shared/harness.js";

const SEED = 429;
export const FREE_PER_MINUTE = 5;
const CITIES = ["Oslo", "Lima", "Osaka", "Accra", "Perth", "Quito", "Riga", "Doha", "Cork", "Bern", "Pune", "Kyiv"];

export interface WireEntry {
  n: number;
  method: string;
  path: string;
  status: number;
  tier: string | null;
  freeLeft: string | null;
  callsLeft: string | null;
}

export interface Summary {
  free: number;
  paid: number;
  offers402: number;
  bundles: number;
  finalCallsRemaining: string | null;
  wire: WireEntry[];
}

export async function run(opts: { silent?: boolean } = {}): Promise<Summary> {
  const log = createLog(opts.silent);
  const domain = DOMAINS.news;
  log.header("03 rate limit upgrade", `A weather API: ${FREE_PER_MINUTE} free requests per minute per IP, then a 402 offer instead of a 429.`);

  // 1. Seller with an in-memory limiter in front of the d402 gate.
  const items = generateDataset("news", 80, SEED);
  const truth = truthMap(items);
  const site = await listen(serve);
  const d402 = createD402({
    sellerId: "weather.example",
    taskUrl: `${site.baseUrl}/.well-known/d402/tasks`,
    scope: ["/forecast"],
    secret: "uc03-secret",
    labels: domain.labels,
    instructions: domain.instructions,
    tiers: [{ id: "s", items: 5, est_tokens: 800, reward: { calls: 10 } }],
    random: mulberry32(SEED),
  });
  d402.tasks.load(toTaskFile(items, 20, SEED));

  const hits = new Map<string, number[]>();
  const app = new Hono<{ Bindings: HttpBindings }>();
  app.route("/", d402.routes);
  app.use("/forecast", async (c, next) => {
    const ip = c.env.incoming.socket.remoteAddress ?? "unknown";
    const now = Date.now();
    const recent = (hits.get(ip) ?? []).filter((t) => now - t < 60_000);
    if (recent.length < FREE_PER_MINUTE) {
      recent.push(now);
      hits.set(ip, recent);
      c.header("X-Tier", "free");
      c.header("X-Free-Remaining", String(FREE_PER_MINUTE - recent.length));
      return next();
    }
    hits.set(ip, recent);
    c.header("X-Tier", "paid");
    return d402.gate(c, next); // no voucher -> 402 with the offer; voucher -> spend one call
  });
  app.get("/forecast", (c) => {
    const city = c.req.query("city") ?? "Oslo";
    return c.json({ city, tempC: (hash32(city) % 350) / 10 - 5, sky: ["clear", "cloudy", "rain"][hash32(city) % 3] });
  });
  site.setHandler((req, env) => app.fetch(req, env));
  log.step(1, `seller up at ${site.baseUrl}: GET /forecast is free ${FREE_PER_MINUTE}x per minute, then gated by d402 (5 snippets -> 10 calls)`);

  // 2. One agent, 12 requests. A logging transport records the wire.
  const wire: WireEntry[] = [];
  const transport: typeof fetch = async (input, init) => {
    const res = await fetch(input, init);
    const u = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    wire.push({
      n: wire.length + 1,
      method: (init?.method ?? "GET").toUpperCase(),
      path: u.pathname + u.search,
      status: res.status,
      tier: res.headers.get("X-Tier"),
      freeLeft: res.headers.get("X-Free-Remaining"),
      callsLeft: res.headers.get(HEADERS.callsRemaining),
    });
    return res;
  };
  let bundles = 0;
  const base = createLookupSolver(noisyLookup(truth, domain.labels, 0.9, 3));
  const solver = async (b: Bundle) => {
    bundles++;
    return base(b);
  };
  const client = createD402Client({ keypair: generateKeypair(), solver, model: "claude", fetch: transport });
  log.step(2, `agent makes ${CITIES.length} requests through client.fetch:`);
  let free = 0;
  let paid = 0;
  let finalCallsRemaining: string | null = null;
  for (const city of CITIES) {
    const res = await client.fetch(`${site.baseUrl}/forecast?city=${city}`);
    if (res.status !== 200) throw new Error(`unexpected ${res.status} for ${city}`);
    await res.text();
    if (res.headers.get("X-Tier") === "free") free++;
    else paid++;
    finalCallsRemaining = res.headers.get(HEADERS.callsRemaining) ?? finalCallsRemaining;
  }

  // 3. The request log, as seen on the wire.
  log.step(3, "request log:");
  for (const e of wire) {
    let note = "";
    if (e.path.startsWith("/forecast")) {
      if (e.status === 402) note = "free tier used up -> 402 with the d402 offer (not a 429)";
      else if (e.tier === "free") note = `free tier (${e.freeLeft} left this minute)`;
      else note = `paid tier, voucher spent (${e.callsLeft} calls left)`;
    } else if (e.method === "GET") note = "bundle: 5 snippets to label";
    else note = "answers signed and submitted -> voucher for 10 calls";
    log.line(`#${String(e.n).padStart(2)} ${e.method.padEnd(4)} ${e.path.padEnd(42)} ${e.status}  ${note}`);
  }
  const offers402 = wire.filter((e) => e.status === 402).length;

  await site.close();
  d402.close();
  log.result(`${free} free requests, 1 x 402 offer, ${bundles} bundle labelled, ${paid} paid requests; no 429, no key, no card`);
  return { free, paid, offers402, bundles, finalCallsRemaining, wire };
}

if (isMain(import.meta.url)) runMain(run);
