/**
 * DEMO: agents pay for the product API with work from the job market.
 *
 *   Part 1, website review (one job):
 *   4 honest reviewers (different keys and model families) browse for real
 *   1 lazy reviewer never opens the site, and keeps trying until it is blocked
 *   1 faker opens the home page and invents the rest
 *
 *   Part 2, the rest of the market: the same kind of agent picks other jobs
 *   (sentiment labelling, ticket triage, invoice extraction); a random guesser fails the hidden controls.
 *
 *   pnpm --filter d402-example-site-review run start   # in one terminal
 *   pnpm --filter d402-example-site-review run demo    # in another (env BASE_URL, D402_ADMIN_TOKEN)
 */
import { generateKeypair } from "@d402/spec";
import { fakerReviewer, honestReviewer, honestWorker, lazyReviewer, randomWorker, reviewAndCall, workAndCall, type Reviewer } from "./agents.js";

const base = (process.env.BASE_URL ?? "http://localhost:8788").replace(/\/+$/, "");
const token = process.env.D402_ADMIN_TOKEN ?? "demo";
const apiUrl = `${base}/api/products?q=lamp`;

async function run(name: string, model: string, reviewer: Reviewer, keypair = generateKeypair()) {
  console.log(`\n== ${name} (${model}) ==`);
  const r = await reviewAndCall({ apiUrl, keypair, model, reviewer, log: (l) => console.log(`  ${l}`) });
  console.log(`  => ${r.outcome.toUpperCase()}`);
  return r;
}

await run("Honest reviewer #1", "claude", honestReviewer);
await run("Lazy reviewer", "unknown", lazyReviewer);
await run("Honest reviewer #2", "gpt", honestReviewer);
await run("Faker", "unknown", fakerReviewer);
await run("Honest reviewer #3", "gemini", honestReviewer);
await run("Honest reviewer #4", "llama", honestReviewer);

console.log(`\n== Lazy reviewer keeps retrying with the same key ==`);
const lazyKey = generateKeypair();
for (let i = 1; i <= 6; i++) {
  const r = await reviewAndCall({ apiUrl, keypair: lazyKey, model: "unknown", reviewer: lazyReviewer });
  console.log(`  attempt ${i}: ${r.outcome}${r.detail ? ` (${r.detail})` : ""}`);
  if (r.outcome === "blocked") break;
}

console.log(`\n== The rest of the market ==`);
const market = (await (await fetch(`${base}/market/jobs`)).json()) as { jobs: Array<{ id: string; type: string; title: string; reward: { calls: number }; est_tokens: number }> };
for (const j of market.jobs) console.log(`  ${j.id.padEnd(18)} ${j.type.padEnd(9)} ${String(j.reward.calls).padStart(3)} calls for ~${j.est_tokens} tokens  ${j.title}`);

const workers = ["claude", "gpt", "gemini", "llama"].map((model) => ({ model, keypair: generateKeypair() }));
for (const job of market.jobs.filter((j) => j.type !== "review")) {
  console.log(`\n== ${job.title} (${job.id}) ==`);
  for (let round = 0; round < 3; round++) {
    for (const w of workers) {
      const r = await workAndCall({ apiUrl, job: job.id, keypair: w.keypair, model: w.model, worker: honestWorker });
      if (round === 0) console.log(`  ${w.model.padEnd(7)} => ${r.outcome.toUpperCase()}${r.callsRemaining ? `, ${r.callsRemaining} calls left` : ""}`);
    }
  }
  const guess = await workAndCall({ apiUrl, job: job.id, model: "unknown", worker: randomWorker });
  console.log(`  guesser => ${guess.outcome.toUpperCase()}`);
}

const res = await fetch(`${base}/admin/state`, { headers: { authorization: `Bearer ${token}` } });
if (res.ok) {
  const s = (await res.json()) as {
    stats: { passed: number; rejected: number; avgUsability: number | null };
    issues: Array<{ confirmed: boolean; page: string; category: string; title: string; reporters: number }>;
    jobs: Array<{ id: string; progress: { done: number; total: number; unit: string }; stats: { passed: number; rejected: number } }>;
  };
  console.log(`\n== Seller's view ==`);
  console.log(`  reviews accepted ${s.stats.passed}, rejected ${s.stats.rejected}, average usability ${s.stats.avgUsability ?? "-"} / 5`);
  for (const i of s.issues) {
    console.log(`  ${i.confirmed ? "CONFIRMED" : "candidate"}  ${i.page} ${i.category}: ${i.title} (${i.reporters} reviewer(s))`);
  }
  for (const j of s.jobs) {
    console.log(`  ${j.id.padEnd(18)} ${j.progress.done}/${j.progress.total} ${j.progress.unit}, ${j.stats.passed} accepted, ${j.stats.rejected} rejected`);
  }
  console.log(`  market:    ${base}/market`);
  console.log(`  dashboard: ${base}/dashboard?token=${token}`);
}
