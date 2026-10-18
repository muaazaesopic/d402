/**
 * 02 x402 side by side: one seller, two payment schemes in the same 402.
 *
 * The offer lists an x402-style "exact" entry (0.007 USDC on base) and d402.
 * An agent with a wallet reads the exact entry and would pay; an agent with no
 * wallet labels 5 news snippets and gets the data. x402 settlement is not
 * implemented here: the wallet agent only shows what it would do.
 */
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { createD402 } from "@d402/server";
import { createD402Client, createLookupSolver } from "@d402/client";
import { HEADERS, generateKeypair, type Bundle, type Offer } from "@d402/spec";
import { DOMAINS, generateDataset, hash32, mulberry32, noisyLookup, toTaskFile, truthMap } from "../../_shared/gen.js";
import { createLog, isMain, listen, ms, runMain } from "../../_shared/harness.js";

const SEED = 402;

/** The x402 "exact" entry: 7000 base units of USDC (6 decimals) = 0.007 USDC. */
export const X402_EXACT = {
  scheme: "exact",
  network: "base",
  asset: "USDC",
  amount: "7000",
  payTo: "0x7f3c0a9e2b5d41c8e6f0a1b2c3d4e5f60718293a",
};

export interface Summary {
  schemes: string[];
  wallet: { status: number; wouldPayUsdc: number; settled: false; elapsedMs: number };
  noWallet: { status: number; bundles: number; callsRemaining: string | null; elapsedMs: number; body: unknown };
}

export async function run(opts: { silent?: boolean } = {}): Promise<Summary> {
  const log = createLog(opts.silent);
  const domain = DOMAINS.news;
  log.header("02 x402 side by side", "A quote API accepts USDC (x402 exact) or labelled data (d402). Two agents, one 402, two paths.");

  // 1. Seller: GET /quote, offer lists both schemes.
  const items = generateDataset("news", 80, SEED);
  const truth = truthMap(items);
  const site = await listen(serve);
  const d402 = createD402({
    sellerId: "quotes.example",
    taskUrl: `${site.baseUrl}/.well-known/d402/tasks`,
    scope: ["/quote"],
    secret: "uc02-secret",
    labels: domain.labels,
    instructions: domain.instructions,
    tiers: [{ id: "s", items: 5, est_tokens: 800, reward: { calls: 10 } }],
    otherAccepts: [X402_EXACT],
    random: mulberry32(SEED),
  });
  d402.tasks.load(toTaskFile(items, 20, SEED));
  const app = new Hono();
  app.route("/", d402.routes);
  app.use("/quote", d402.gate);
  app.get("/quote", (c) => {
    const symbol = (c.req.query("symbol") ?? "ACME").toUpperCase();
    const price = 50 + (hash32(symbol) % 20000) / 100;
    return c.json({ symbol, price, currency: "USD", asOf: "2026-10-18T09:30:00Z" });
  });
  site.setHandler((req, env) => app.fetch(req, env));
  const url = `${site.baseUrl}/quote?symbol=ACME`;
  const offer = (await (await fetch(url)).json()) as Offer;
  const schemes = offer.accepts.map((a) => a.scheme);
  log.step(1, `seller up at ${site.baseUrl}; GET /quote answers 402 with accepts = [${schemes.join(", ")}]`);

  // 2. Agent with a wallet: finds the exact entry, would pay.
  const t0 = performance.now();
  const walletRes = await fetch(url);
  const walletOffer = (await walletRes.json()) as Offer;
  const exact = walletOffer.accepts.find((a) => a.scheme === "exact") as typeof X402_EXACT | undefined;
  if (!exact) throw new Error("no exact scheme in the offer");
  const usdc = Number(exact.amount) / 1e6;
  const walletMs = performance.now() - t0;
  log.step(2, `wallet agent: HTTP ${walletRes.status} in ${walletMs.toFixed(0)} ms, picks scheme "exact": would pay ${usdc} ${exact.asset} on ${exact.network} to ${exact.payTo.slice(0, 10)}...`);
  log.line(`(x402 settlement is not implemented in this demo; the wallet agent stops here)`);

  // 3. Agent without a wallet: earns via d402 and gets the quote.
  let bundles = 0;
  const base = createLookupSolver(noisyLookup(truth, domain.labels, 0.9, 7));
  const solver = async (b: Bundle) => {
    bundles++;
    return base(b);
  };
  const client = createD402Client({ keypair: generateKeypair(), solver, model: "claude" });
  const t1 = performance.now();
  const res = await client.fetch(url);
  const body = await res.json();
  const d402Ms = performance.now() - t1;
  const remaining = res.headers.get(HEADERS.callsRemaining);
  log.step(3, `no-wallet agent: 402 -> labelled ${bundles} bundle of 5 snippets -> HTTP ${res.status} in ${d402Ms.toFixed(0)} ms, calls remaining ${remaining}`);
  log.line(`body: ${JSON.stringify(body)}`);

  // 4. Side by side.
  const col = (s: string) => s.padEnd(38);
  log.step(4, "side by side:");
  log.line(`${col("")}| ${col("wallet agent (x402 exact)")}| no-wallet agent (d402)`);
  log.line(`${col("first response")}| ${col(`402 in ${walletMs.toFixed(0)} ms`)}| 402 (handled inside client.fetch)`);
  log.line(`${col("pays with")}| ${col(`${usdc} USDC on ${exact.network}`)}| ${bundles} bundle of 5 labelled snippets`);
  log.line(`${col("needs")}| ${col("a funded wallet, a chain, a facilitator")}| an Ed25519 key and a model`);
  log.line(`${col("gets the data")}| ${col("after settlement (not run here)")}| HTTP ${res.status} in ${d402Ms.toFixed(0)} ms, ${remaining} calls left`);

  await site.close();
  d402.close();
  log.result(`same 402, two currencies: ${usdc} USDC (not settled) or 5 labels -> data in ${ms(t1)} with no wallet`);
  return {
    schemes,
    wallet: { status: walletRes.status, wouldPayUsdc: usdc, settled: false, elapsedMs: walletMs },
    noWallet: { status: res.status, bundles, callsRemaining: remaining, elapsedMs: d402Ms, body },
  };
}

if (isMain(import.meta.url)) runMain(run);
