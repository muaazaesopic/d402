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
| `examples/search-proxy` | A gated search API with a curl walkthrough. |
| `bench/` | Simulated agents against hidden ground truth. Produces the 6 go/no-go numbers. |

## Quick start

```sh
pnpm install
pnpm build
pnpm test          # unit + e2e
pnpm bench         # prints the metrics table, writes bench/out/report.md
pnpm example       # gated search API on :8787
```

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
| Bundles before a lazy agent is cut off | <= 3 |

## Status

v1. One task type (`classify`). Bearer vouchers by default, key-bound vouchers
with `bindVouchers: true`. Key and IP rate limits are the only Sybil defence.
See `spec/SPEC.md` section 11.
