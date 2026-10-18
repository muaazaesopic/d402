/**
 * DEMO ONLY. This agent "solves" bundles by looking answers up in answer-key.json,
 * the hidden truth for the example's task file. A real agent would never have that
 * file; it would use an LLM (see createLlmSolver in @d402/client). The point here is
 * to show the earn-then-spend flow end to end against a running server.
 *
 *   pnpm --filter d402-example-search-proxy run start   # in one terminal
 *   pnpm --filter d402-example-search-proxy run demo    # in another (env BASE_URL)
 */
import { readFileSync } from "node:fs";
import { HEADERS, generateKeypair } from "@d402/spec";
import { createD402Client, createLookupSolver } from "@d402/client";

const base = (process.env.BASE_URL ?? "http://localhost:8787").replace(/\/+$/, "");
const answerKey = JSON.parse(readFileSync(new URL("../answer-key.json", import.meta.url), "utf8")) as Record<string, string>;

const client = createD402Client({
  keypair: generateKeypair(),
  solver: createLookupSolver((item) => answerKey[item.id] ?? "world"),
  model: "demo",
  tier: "s", // 5 items -> 10 calls
});

for (const q of ["ceasefire", "gpu", "quarterly profit"]) {
  // client.fetch sends a cached voucher, or on 402 earns one first (get bundle -> solve -> submit).
  const res = await client.fetch(`${base}/search?q=${encodeURIComponent(q)}`);
  const body = (await res.json()) as { hits?: { title: string }[]; error?: string };
  const remaining = res.headers.get(HEADERS.callsRemaining);
  const hits = body.hits?.map((h) => h.title).join(" | ") ?? body.error;
  console.log(`q=${JSON.stringify(q)} -> HTTP ${res.status}, calls remaining ${remaining}, hits: ${hits}`);
}
