# @d402/proxy

Put a [d402](../../spec/SPEC.md) gate in front of any existing HTTP API with
one command. No code on the seller side: the proxy sits between agents and
your API, answers `402 Payment Required` with a d402 offer, hands out classify
bundles, grades them, and forwards paid requests to your API unchanged.

```sh
npx d402-proxy --upstream https://api.example.com --tasks ./tasks.jsonl --labels sports,business,tech,world
```

## Put d402 in front of your API in 60 seconds

1. Write a JSONL task file: one `{"id","type":"classify","text"}` per line, some with a `"golden"` label (SPEC 10). Any JSONL with a few hundred lines will do.
2. `export D402_SECRET=$(openssl rand -hex 32)`
3. `npx d402-proxy --upstream https://api.example.com --tasks ./tasks.jsonl --labels a,b,c --public-url https://d402.example.com`
4. Point agents (or your DNS) at the proxy instead of the API. `curl -i https://d402.example.com/anything` now returns a 402 with the offer.
5. Agents label bundles, earn vouchers and call through. Resolved labels: `curl -H 'Authorization: Bearer $TOKEN' https://d402.example.com/.well-known/d402/admin/export` (with `--admin-token $TOKEN`).

## What it does

- Mounts the d402 routes: `GET /.well-known/d402` (the offer), `GET /.well-known/d402/tasks?tier=`, `POST /.well-known/d402/tasks/:bundleId`.
- Runs `d402.gate` on every request whose path starts with a `--scope` prefix (default: everything except `/.well-known/*` and `--open` paths). No valid voucher means `402` with the offer; a valid one is decremented and the request goes through with `D402-Calls-Remaining` on the response.
- Forwards every request, gated or open, to `--upstream`: same method, path, query, headers and body (streamed). Hop-by-hop headers and `D402-Voucher` are dropped, `Host` becomes the upstream host, and `X-Forwarded-For`, `X-Forwarded-Proto`, `X-Forwarded-Host` and `Via` are added. The upstream status, headers and body come back unchanged except for hop-by-hop headers.
- Logs one line per request to stderr: `GET /v1/items 200 12ms paid` (`paid`, `open` or `402`).
- Keeps the pool, agents and vouchers in SQLite (`--db`), in memory by default.

## Flags

| Flag | Default | Meaning |
|---|---|---|
| `--upstream <url>` | required | base URL of the API to gate; a path prefix is kept (`https://x/base` + `/v1` -> `https://x/base/v1`) |
| `--tasks <file.jsonl>` | none | classify task file loaded at boot (SPEC 10) |
| `--scope <prefix,...>` | `/` | path prefixes to gate; also the voucher scope in the offer |
| `--labels <a,b,...>` | derived | classify labels, at least 2; when absent the distinct `golden` values of the task file are used (a warning says so) |
| `--seller-id <id>` | upstream host | `sellerId` in the offer and `iss` of vouchers |
| `--public-url <url>` | `http://localhost:<port>` | public base URL of the proxy; `taskUrl` is `<public-url>/.well-known/d402/tasks` |
| `--secret <s>` | env `D402_SECRET` | voucher HMAC secret; with neither, a random one is generated and a warning says vouchers will not survive a restart |
| `--port <n>` | `8787` | listen port (`0` picks a free one and prints it) |
| `--tier <id:items:est_tokens:calls>` | `s:5:1000:10 m:25:5000:60 l:50:10000:150` | a tier; repeat the flag for several |
| `--db <path>` | in memory | SQLite path |
| `--bind-vouchers` | off | SPEC 7.1: spends must carry `D402-Key`, `D402-Timestamp`, `D402-Sig` |
| `--require-model-families` | off | an item resolves only with votes from 2 distinct `D402-Model` families |
| `--admin-token <t>` | off | enables the admin endpoints below |
| `--open <prefix,...>` | none | path prefixes that are never gated, e.g. `/health,/docs` |
| `--instructions <text>` | SPEC default | instructions shown in every bundle |
| `--config <file.json>` | none | JSON config file, see below |
| `-h`, `--help` | | usage |

Prefix matching is the same rule the server uses for voucher scope: `--scope /v1`
gates `/v1`, `/v1/items` and `/v1x`.

## Config file

The same keys in camelCase. Flags override the file; the file overrides env
`D402_SECRET`. `tiers` entries may be `"id:items:est_tokens:calls"` strings or
SPEC 3 tier objects; `scope`, `labels` and `open` may be arrays or comma lists.

```json
{
  "upstream": "https://api.example.com",
  "tasks": "./tasks.jsonl",
  "scope": ["/v1"],
  "labels": ["sports", "business", "tech", "world"],
  "sellerId": "api.example.com",
  "publicUrl": "https://d402.example.com",
  "port": 8787,
  "tiers": ["s:5:1000:10", { "id": "m", "items": 25, "est_tokens": 5000, "reward": { "calls": 60 } }],
  "db": "./d402.db",
  "bindVouchers": false,
  "requireModelFamilies": false,
  "adminToken": "change-me",
  "open": ["/health", "/docs"]
}
```

```sh
d402-proxy --config d402.json --port 9000
```

## Admin endpoints

Only mounted when `--admin-token` is set. Both need `Authorization: Bearer <token>`;
anything else is `401`.

| Endpoint | Returns |
|---|---|
| `GET /.well-known/d402/admin/stats` | `{ stats, agents, resolved }`: pool stats (`tasks.stats()`), every agent with its accuracy and block state (`agents.list()`), and the count of resolved items |
| `GET /.well-known/d402/admin/export` | the resolved unknown items as JSONL (`application/x-ndjson`), one `{ id, text, answer, weight, voters }` per line |

```sh
curl -s -H "Authorization: Bearer $TOKEN" http://localhost:8787/.well-known/d402/admin/stats | jq
curl -s -H "Authorization: Bearer $TOKEN" http://localhost:8787/.well-known/d402/admin/export > resolved.jsonl
```

## As a library

```ts
import { serve } from "@hono/node-server";
import { createProxyApp, parseArgs } from "@d402/proxy";

const { app, d402 } = createProxyApp({
  upstream: "https://api.example.com",
  tasks: "./tasks.jsonl",
  labels: ["sports", "business", "tech", "world"],
  scope: ["/v1"],
  open: ["/health"],
  publicUrl: "https://d402.example.com",
  secret: process.env.D402_SECRET,
});
serve({ fetch: app.fetch, port: 8787 });
// d402.tasks.stats(), d402.agents.list(), d402.tasks.exportResolved(), d402.close()
```

`createProxyApp(opts)` is pure apart from opening the SQLite store, so it can be
driven with `app.request()` in tests; `log`, `warn` and `fetch` are injectable.
`parseArgs(argv, env?)` turns CLI flags into the same options object.

## Notes

- The proxy decodes compressed upstream bodies (`fetch` does), so `Content-Encoding` and `Content-Length` are dropped from such responses; everything else passes through.
- `X-Forwarded-For` is appended to when the request already carries one. The server's per-IP rate limit reads the first entry.
- The proxy needs Node 22+ for `node:sqlite` (it prints an `ExperimentalWarning` on start; that is expected).
