/**
 * 05 multi-seller wallet: one key, one voucher file, three sellers.
 *
 * Three unrelated sellers (news, helpdesk, shop) run in this process with
 * different sellerIds, scopes, labels and tiers. One agent with a
 * FileVoucherCache fetches from all three, earning once per seller. A second
 * client built from the same directory, with no solver at all, spends the
 * cached vouchers without earning anything.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { createD402, type D402Server } from "@d402/server";
import { FileVoucherCache, createD402Client, createLookupSolver, loadOrCreateKeypair, type StoredVoucher } from "@d402/client";
import { HEADERS, type Tier } from "@d402/spec";
import { DOMAINS, generateDataset, mulberry32, noisyLookup, toTaskFile, truthMap, type DomainName } from "../../_shared/gen.js";
import { createLog, isMain, listen, runMain, type Listening } from "../../_shared/harness.js";

const SEED = 505;

interface SellerSpec {
  id: string;
  domain: DomainName;
  scope: string;
  path: string;
  tier: Tier;
  body: unknown;
}

const SELLERS: SellerSpec[] = [
  { id: "news.example", domain: "news", scope: "/headlines", path: "/headlines?region=eu", tier: { id: "n", items: 5, est_tokens: 800, reward: { calls: 10 } }, body: { headlines: ["Ceasefire holds", "GPU prices fall"] } },
  { id: "helpdesk.example", domain: "tickets", scope: "/tickets", path: "/tickets/stats", tier: { id: "t", items: 8, est_tokens: 1500, reward: { calls: 20 } }, body: { open: 42, critical: 3 } },
  { id: "shop.example", domain: "reviews", scope: "/reviews", path: "/reviews/summary?sku=kettle", tier: { id: "r", items: 6, est_tokens: 900, reward: { calls: 15 } }, body: { sku: "kettle", stars: 4.2 } },
];

export interface Summary {
  afterEarn: { sellerId: string; calls: number }[];
  bundlesPerSeller: Record<string, number>;
  secondClient: { sellerId: string; status: number; callsRemaining: string | null }[];
  afterSpend: { sellerId: string; calls: number }[];
  cacheDir: string;
}

export async function run(opts: { silent?: boolean; cacheDir?: string } = {}): Promise<Summary> {
  const log = createLog(opts.silent);
  const dir = opts.cacheDir ?? mkdtempSync(join(tmpdir(), "d402-uc05-wallet-"));
  log.header("05 multi-seller wallet", "Three sellers, one agent key, one vouchers.json. Earn once per seller, spend from any process.");

  // 1. Three sellers in one process.
  const sellers: { spec: SellerSpec; site: Listening; d402: D402Server }[] = [];
  const lookups: Record<string, (item: { id: string }) => string> = {};
  log.step(1, "sellers:");
  for (const [i, spec] of SELLERS.entries()) {
    const domain = DOMAINS[spec.domain];
    const items = generateDataset(spec.domain, 60, SEED + i);
    lookups[domain.idPrefix] = noisyLookup(truthMap(items), domain.labels, 0.95, 50 + i);
    const site = await listen(serve);
    const d402 = createD402({
      sellerId: spec.id,
      taskUrl: `${site.baseUrl}/.well-known/d402/tasks`,
      scope: [spec.scope],
      secret: `uc05-${spec.id}`,
      labels: domain.labels,
      instructions: domain.instructions,
      tiers: [spec.tier],
      random: mulberry32(SEED + i),
    });
    d402.tasks.load(toTaskFile(items, 15, SEED + i));
    const app = new Hono();
    app.route("/", d402.routes);
    app.use(`${spec.scope}/*`, d402.gate);
    app.use(spec.scope, d402.gate);
    app.get(spec.path.split("?")[0]!, (c) => c.json(spec.body as Record<string, unknown>));
    site.setHandler((req, env) => app.fetch(req, env));
    sellers.push({ spec, site, d402 });
    log.line(`${spec.id.padEnd(18)} ${site.baseUrl}  scope ${spec.scope.padEnd(11)} labels [${domain.labels.join(",")}]  tier ${spec.tier.id}: ${spec.tier.items} items -> ${spec.tier.reward.calls} calls`);
  }

  // 2. Agent A: a file-backed wallet, earns at each seller on first contact.
  const keypair = loadOrCreateKeypair(join(dir, "keypair.json"));
  const clientA = createD402Client({
    keypair,
    cache: new FileVoucherCache(dir),
    solver: createLookupSolver((item, bundle) => {
      const lookup = lookups[item.id[0]!];
      if (!lookup) throw new Error(`unknown item ${item.id}`);
      const a = lookup(item);
      return bundle.labels.includes(a) ? a : bundle.labels[0]!;
    }),
    model: "claude",
  });
  log.step(2, `agent A (key ${keypair.publicKey.slice(0, 8)}..., FileVoucherCache at ${dir}) fetches from all three:`);
  for (const { spec, site } of sellers) {
    const res = await clientA.fetch(site.baseUrl + spec.path);
    await res.text();
    log.line(`GET ${spec.path.padEnd(28)} -> ${res.status}, earned a voucher, calls remaining ${res.headers.get(HEADERS.callsRemaining)}`);
  }
  const afterEarn = (await clientA.status()).map((v) => ({ sellerId: v.sellerId, calls: v.calls }));
  log.line(`client.status(): ${afterEarn.length} vouchers -> ${afterEarn.map((v) => `${v.sellerId}:${v.calls}`).join("  ")}`);
  const bundlesPerSeller: Record<string, number> = {};
  for (const { spec, d402 } of sellers) bundlesPerSeller[spec.id] = d402.agents.get(keypair.publicKey)?.bundles ?? 0;

  // 3. Agent B: same directory, no solver. Discovers each seller, then spends.
  const clientB = createD402Client({ keypair: loadOrCreateKeypair(join(dir, "keypair.json")), cache: new FileVoucherCache(dir) });
  log.step(3, "agent B: a second client from the same directory, no solver, so it cannot earn:");
  const secondClient: Summary["secondClient"] = [];
  for (const { spec, site } of sellers) {
    await clientB.discover(site.baseUrl); // learn which seller lives at this origin
    const res = await clientB.fetch(site.baseUrl + spec.path);
    await res.text();
    const callsRemaining = res.headers.get(HEADERS.callsRemaining);
    secondClient.push({ sellerId: spec.id, status: res.status, callsRemaining });
    log.line(`GET ${spec.path.padEnd(28)} -> ${res.status}, spent a cached voucher, calls remaining ${callsRemaining}`);
  }
  const afterSpend = (await clientB.status()).map((v) => ({ sellerId: v.sellerId, calls: v.calls }));
  const unchanged = sellers.every(({ spec, d402 }) => (d402.agents.get(keypair.publicKey)?.bundles ?? 0) === bundlesPerSeller[spec.id]);

  log.step(4, "client.status() from agent B:");
  const fmt = (v: StoredVoucher) => `${v.sellerId.padEnd(18)} jti ${v.jti.slice(0, 10)}...  calls ${String(v.calls).padStart(2)}  scope ${v.scope.join(",")}  expires in ${Math.round((v.expiresAt - Date.now() / 1000) / 3600)} h`;
  for (const v of await clientB.status()) log.line(fmt(v));

  for (const { site, d402 } of sellers) {
    await site.close();
    d402.close();
  }
  log.result(`3 vouchers in one file, earned with 3 bundles, spent by a solver-less client (${unchanged ? "no new bundles" : "unexpected earning"}); balances ${afterSpend.map((v) => v.calls).join("/")}`);
  return { afterEarn, bundlesPerSeller, secondClient, afterSpend, cacheDir: dir };
}

if (isMain(import.meta.url)) runMain(run);
