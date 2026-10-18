# d402

Pay for API access with labelled data instead of micropayments.

d402 ("data 402") is an HTTP payment scheme for agents. A gated route returns
`402 Payment Required` with an offer. Instead of sending USDC, the agent labels a
bundle of items, passes hidden control items, and gets a voucher worth N calls.
The seller gets labelled data. The agent needs no wallet.

It is reCAPTCHA for agents:

| reCAPTCHA | d402 |
|---|---|
| Gate a page | Gate an API route |
| Type 2 words | Label a bundle of 5 to 50 items |
| One word is known, one is unknown | Some items are golden (known), the rest are votes |
| Humans pay in seconds | Agents pay in tokens |
| Google got digitized books | The seller gets a labelled dataset |

The offer uses the same `accepts` array shape as x402, so a seller can list USDC
and d402 side by side and the agent picks.

## Packages

| Package | What it is |
|---|---|
| `spec/SPEC.md` | The protocol. Read this first. |
| `@d402/spec` | Zod schemas, header names, defaults, Ed25519 signing helpers. |
| `@d402/server` | Hono middleware for sellers: offer, bundles, grading, trust, vouchers. SQLite via `node:sqlite`. CLI `d402-tasks`. |
| `@d402/client` | Fetch wrapper for agents: earns on 402, caches vouchers, retries. Pluggable solver. |
| `@d402/mcp` | MCP server so an LLM agent is its own solver: `d402_get_bundle`, `d402_submit`, `d402_fetch`, `d402_status`, `d402_discover`. |
| `@d402/proxy` | `d402-proxy`: put a d402 gate in front of any existing API with one command. No code. |
| `clients/python` | Python client with the same keypair and voucher files as the TS client. Signatures verified byte-equal. |
| `clients/curl` | The whole protocol in a bash script: curl, jq and one signing call. |
| `examples/search-proxy` | A gated search API with a live dashboard for demos. |
| `use-cases/` | 7 runnable stories: dataset builder, x402 side by side, rate-limit upgrade, MCP agent, multi-seller wallet, trust tiers, paid crawl. |
| `bench/` | Simulated agents against hidden ground truth. Produces the 6 go/no-go numbers. |

## Three ways in

Seller with an existing API and no time:

```sh
npx d402-proxy --upstream https://api.example.com --tasks tickets.jsonl --scope /v1 --admin-token demo
```

Agent in Claude Code or Claude Desktop:

```sh
claude mcp add d402 -e D402_HOME=~/.d402 -- d402-mcp
```

Human at a terminal:

```sh
d402 earn https://api.example.com --answers key.json
d402 fetch https://api.example.com/v1/search?q=rates
```

## Quick start

```sh
pnpm install
pnpm build
pnpm test          # unit + e2e
pnpm bench         # prints the metrics table, writes bench/out/report.md
pnpm example       # gated search API on :8787, dashboard at /dashboard?token=demo
pnpm --workspace-concurrency=1 --filter 'd402-uc-*' run start   # all 7 use cases
bash clients/curl/walkthrough.sh                                 # the protocol in curl
cd clients/python && python3 -m unittest                         # Python client tests
```

Test count: 432 vitest (unit, e2e over real HTTP, MCP over real stdio, proxy, use cases) plus 24 Python.

Seller side, 10 lines:

```ts
import { Hono } from "hono";
import { createD402 } from "@d402/server";

const d = createD402({
  sellerId: "api.example.com",
  taskUrl: "https://api.example.com/.well-known/d402/tasks",
  scope: ["/search"],
  secret: process.env.D402_SECRET!,
  labels: ["sports", "business", "tech", "world"],
  tiers: [{ id: "s", items: 5, est_tokens: 1000, reward: { calls: 10 } }],
});
d.tasks.loadFile("tasks.jsonl");

const app = new Hono();
app.route("/", d.routes);
app.use("/search", d.gate);
app.get("/search", (c) => c.json({ hits: [] }));
```

Agent side, 5 lines:

```ts
import { createD402Client, loadOrCreateKeypair, createLlmSolver } from "@d402/client";

const client = createD402Client({
  keypair: loadOrCreateKeypair("~/.d402/keypair.json"),
  solver: createLlmSolver({ complete: (prompt) => myModel(prompt) }),
});
const res = await client.fetch("https://api.example.com/search?q=rates");
```

## The 6 numbers

The bench measures what decides whether the medium holds:

| Number | Bar |
|---|---|
| Resolved-label accuracy vs ground truth | >= 90%, and above any single agent |
| Golden pass rate for honest agents | > 85% |
| Bundles until an item resolves | < 4 |
| Tokens per call earned | < 200 |
| Seconds added per gated request, cached voucher | < 0.5s |
| Bundles before a lazy agent is cut off | <= 5 (the spec floor; it earns 0 calls either way) |

## Bench results

From `pnpm bench` (2,000 items, 15% golden, 7 simulated agents, 60 rounds each, seed 42).
Full report with the per-agent table in `bench/REPORT.md`.

| Number | requireModelFamilies off | on | Bar |
|---|---|---|---|
| Resolved-label accuracy | 0.999 (768 items) | 1.000 (961 items) | >= 0.90 |
| Single best agent accuracy, for comparison | 0.925 | 0.925 | |
| Honest golden pass rate | 0.92 | 0.96 | > 0.85 |
| Bundles per resolution | 3.0 | 3.0 | < 4 |
| Tokens per call earned | 83 | 83 | < 200 |
| Added latency, cached voucher | 0.9 ms | 0.9 ms | < 500 ms |
| Bundles before the lazy agent is blocked | 5 | 5 | <= 5 |
| Calls earned by the lazy and replay agents | 0 | 0 | |

Both runs pass every bar. Read the caveats in the report: the bench raises the
rate limits so 60 rounds fit in 5 seconds, and simulated agents err independently,
which real models on the same family may not.

## Status

v1. One task type (`classify`). Bearer vouchers by default; `bindVouchers: true`
ties spends to the agent's Ed25519 key and `requireSpendNonce: true` closes replay
inside the clock skew (spec 7.2). Key and IP rate limits are the only Sybil
defence. See `spec/SPEC.md` section 11.

Packages are not on npm yet. Until they are, `pnpm build` and run the bins from
`packages/*/dist`, or `pnpm link` them.
