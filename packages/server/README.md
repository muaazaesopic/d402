# @d402/server

Seller-side middleware for the [d402 protocol](../../spec/SPEC.md): gate Hono
routes behind labelled-data vouchers, hand out classify bundles seeded with
golden items, grade them, and turn agents' answers into weighted votes.

Storage is SQLite via Node's built-in `node:sqlite` (Node 22+). It prints an
`ExperimentalWarning` on start; that is expected.

## Install

```sh
pnpm add @d402/server hono
```

## Usage

```ts
import { Hono } from "hono";
import { createD402 } from "@d402/server";

const d = createD402({
  sellerId: "api.example.com",
  taskUrl: "http://localhost:8787/.well-known/d402/tasks",
  scope: ["/search"],
  tiers: [{ id: "s", items: 5, est_tokens: 1000, reward: { calls: 10 } }],
  secret: process.env.D402_SECRET!,
  labels: ["sports", "business", "tech", "world"],
  db: "./d402.db",
});
d.tasks.loadFile("./tasks.jsonl");

const app = new Hono();
app.route("/", d.routes);                                  // /.well-known/d402 + task endpoints
app.use("/search", d.gate); app.use("/search/*", d.gate);  // 402 without a valid voucher
app.get("/search", (c) => c.json({ hits: [] }));
```

`d.gate` verifies the voucher, checks scope and remaining calls, decrements
atomically, sets `D402-Calls-Remaining` and calls the route. Any failure is a
`402` whose body is the offer plus `error` (and `message`). Mounting the gate on
both `/search` and `/search/*` is safe: it runs once per request.

## Options

| Option | Default | Meaning |
|---|---|---|
| `sellerId` | required | `iss` of vouchers and `sellerId` in the offer |
| `taskUrl` | required | absolute URL of the task endpoint |
| `scope` | required | path prefixes vouchers are valid for |
| `tiers` | required | bundle sizes and rewards (SPEC 3) |
| `secret` | required | HMAC secret for HS256 vouchers |
| `labels` | required | classify labels (at least 2) |
| `instructions` | `"Label each item with exactly one of the labels."` | shown in every bundle |
| `db` | `":memory:"` | SQLite path |
| `voucherTtl` | `86400` | voucher lifetime, seconds |
| `bundleTtl` | `600` | bundle lifetime, seconds |
| `goldenMaxExposures` | `200` | a golden is retired after this many bundles |
| `bundlesPerKeyPerHour` | `60` | rate limit per key |
| `bundlesPerIpPerHour` | `120` | rate limit per IP (`x-forwarded-for`, then the socket address) |
| `maxOpenBundlesPerKey` | `5` | unsubmitted, unexpired bundles per key |
| `requireModelFamilies` | `false` | resolution also needs 2 distinct `D402-Model` families |
| `bindVouchers` | `false` | SPEC 7.1: spends must carry `D402-Key`, `D402-Timestamp`, `D402-Sig` |
| `now` | `Date.now()/1000` | clock, unix seconds (inject in tests) |
| `random` | `Math.random` | RNG for golden sampling and shuffling |
| `otherAccepts` | `[]` | extra entries appended to `offer.accepts` (e.g. an x402 `exact` scheme) |

## Server object

- `routes`: `GET /.well-known/d402`, `GET /.well-known/d402/tasks?tier=<id>`, `POST /.well-known/d402/tasks/:bundleId`
- `gate`: middleware for gated routes
- `offer(error?, message?)`: the SPEC 3 body
- `tasks.load(items)` / `tasks.loadFile(path)` / `tasks.exportResolved()` / `tasks.stats()`
- `agents.get(publicKey)` / `agents.list()`
- `vouchers.get(jti)`
- `close()`

## Behaviour notes

- Vote weight is the agent's accuracy estimate computed **before** the submitted
  bundle's golden counters are folded in, so a bundle cannot raise its own weight
  with the goldens it just answered. The first bundle of a key votes at the prior
  `0.5`.
- An agent is never re-handed an unknown item from a bundle it submitted or that
  is still open. Unknowns with the fewest votes are handed out first.
- `tier` defaults to the first tier when the query parameter is omitted.
- `D402-Timestamp` on a bound spend must be within `spendTimestampSkew` (300 s) of
  the server clock in either direction.
- A blocked key gets `403 blocked` on both task endpoints; its vouchers keep working.

## CLI

```sh
d402-tasks load <db> <file.jsonl>   # insert items (duplicate ids are ignored)
d402-tasks export <db>              # resolved unknown items as JSONL
d402-tasks stats <db>               # pool statistics as JSON
```

Task file lines follow SPEC 10: `{"id":"i_1","type":"classify","text":"...","golden":"tech"}`.

## Admin endpoints

Set `adminToken` and four read-only routes are mounted next to the task routes. Every
request must carry `Authorization: Bearer <adminToken>`; anything else is
`401 { "error": "unauthorized" }`. Without `adminToken` the routes do not exist (404).

```ts
const d402 = createD402({ ...opts, adminToken: process.env.D402_ADMIN_TOKEN });
```

| Route | Body |
|---|---|
| `GET /.well-known/d402/admin/stats` | `{ stats: tasks.stats(), agents: agents.list(), resolvedCount, now }` |
| `GET /.well-known/d402/admin/export` | `tasks.exportResolved()` as JSONL (`application/x-ndjson`), one `{ id, text, answer, weight, voters }` per line |
| `GET /.well-known/d402/admin/agents` | `agents.list()` |
| `GET /.well-known/d402/admin/events?since=<unix>` | `{ events, now }`: the last 200 events at or after `since`, oldest first |

An event is `{ t, type, key?, bundleId?, itemId?, tier?, jti?, calls?, answer?, voters? }` with
`type` one of `bundle_issued`, `bundle_passed`, `bundle_failed`, `voucher_issued`,
`item_resolved`, `agent_blocked`.

Limitation: there is no event log. Events are reconstructed from the store on every
request (bundles' `issued_at`/`submitted_at`, vouchers, votes, resolved items, blocked
agents), which keeps the grading path untouched but means:

- voucher *spends* are not visible as events (`stats.vouchers` and `vouchers.get(jti)` are);
- a resolved item is dated by the latest bundle that voted for the winning answer;
- a blocked agent is dated by its last submission;
- only `SqliteStore` supports the table-backed events; another `Store` yields `agent_blocked` only.

`curl -s -H "Authorization: Bearer $TOKEN" http://localhost:8787/.well-known/d402/admin/export > resolved.jsonl`
is the quickest way to pull labelled data out of a running seller.
