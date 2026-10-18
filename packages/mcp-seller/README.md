# @d402/mcp-seller

The seller side of d402 as a remote MCP server. Your tools are paid for in
labelled data: an agent calls a paid tool, gets the d402 offer back, labels a
bundle of items, earns a voucher worth N calls, and calls the tool again with
the voucher. No wallet, no API key. You get a labelled dataset.

It is a plain Streamable HTTP MCP server, so it runs anywhere one does. The
vouchers are the same HS256 JWTs `@d402/server` mints for HTTP routes, so one
voucher works on both the HTTP routes and the MCP tools of the same seller.

```sh
d402-mcp-seller --tasks tasks.jsonl --labels sports,business,tech,world --scope /mcp/search --port 8788 --secret $D402_SECRET
```

That is a complete paid MCP server: four `d402_*` tools for earning, a demo
`search` tool over a built-in 10-document corpus, and the d402 HTTP routes at
`/.well-known/d402*`. Without `--tasks` it loads a built-in 20-item pool so it
runs with no files at all.

## Tools

| Tool | What it does |
|---|---|
| `d402_offer` | The offer (same JSON as `GET /.well-known/d402`) plus a one-line `how`. |
| `d402_get_bundle { tier?, key?, model? }` | A bundle of items to label. |
| `d402_submit { bundleId, answers, sig?, key?, model? }` | Grades the bundle; returns `{ voucher, calls, scope, expiresAt }` or `isError` with code `quality`. |
| `d402_status { voucher? }` | Calls left on a voucher (default: the session's last one), the session public key, pending bundles. |
| your gated tools | Each takes its own args plus `d402_voucher` (and the four bound-spend args, see below). |

A gated tool called without `d402_voucher` returns the offer, not an error:

```json
{ "paymentRequired": true, "d402": { "d402": "1", "accepts": [ ... ] }, "how": "Call d402_get_bundle, label the items, call d402_submit, then call the paid tool with the voucher." }
```

With a voucher it runs your handler and appends `d402_calls_remaining` to the
structured content and a `calls remaining: N` text line. A spend that fails
(`voucher_exhausted`, `voucher_expired`, `scope_mismatch`, ...) returns the same
payment-required shape with `error` set.

## Two identity modes

**Session mode** (default). The agent passes no key. The server generates a
real Ed25519 keypair per MCP session, earns bundles under it, signs
submissions and bound spends with it. Zero setup for the agent. The trade-off:
trust (fewer control items, bigger rewards as a key builds a clean history)
resets with every session, because the key does.

**Key mode.** The agent passes `key` (its base64url Ed25519 public key) to
`d402_get_bundle` and `key` + `sig` to `d402_submit`, where `sig` is its
signature over `"d402:submit\n{bundleId}\n{canonical JSON of answers}"` (spec
section 5). Trust follows the key across sellers, sessions and harnesses, and
the same key works on the HTTP routes. `@d402/spec` has `generateKeypair` and
`signSubmit`; `@d402/client` persists a keypair file.

`sessionKeys: false` (CLI `--no-session-keys`) turns session mode off: every
earning tool then requires `key`.

### Bound vouchers

With `bindVouchers: true` on the seller (spec 7.1, 7.2) every spend must be
signed by the voucher's key. In session mode the server does this itself
(timestamp, fresh nonce, signature with the session key). In key mode the agent
passes four extra args on every gated tool call:

| Arg | Value |
|---|---|
| `d402_key` | its public key, equal to the voucher's `sub` |
| `d402_timestamp` | unix seconds, within 300s of the server |
| `d402_nonce` | 16 random bytes, base64url, never reused |
| `d402_sig` | Ed25519 over `"d402:spend\nTOOL\n{scope path}\n{jti}\n{timestamp}\n{nonce}"` |

The method is the literal string `TOOL` and the path is the tool's scope path
(`/mcp/<name>` by default). A reused nonce is `replayed_spend`.

## One voucher across HTTP and MCP

Vouchers carry a `scope` of path prefixes. Each gated MCP tool spends against a
path, `/mcp/<tool name>` by default (override with `scope` in the tool config).
List both prefixes in the seller's `scope` and one voucher covers both:

```ts
const d402 = createD402({
  sellerId: "api.example.com",
  taskUrl: "https://api.example.com/.well-known/d402/tasks",
  scope: ["/search", "/mcp/search"],   // HTTP route and MCP tool
  secret: process.env.D402_SECRET!,
  labels: ["sports", "business", "tech", "world"],
  tiers: [{ id: "s", items: 5, est_tokens: 1000, reward: { calls: 10 } }],
});
```

An agent can then earn over `GET /.well-known/d402/tasks` with curl and spend
on the MCP `search` tool, or earn through `d402_get_bundle` in Claude and spend
on `GET /search` with a `D402-Voucher` header. The calls counter is shared.

## Programmatic use

```ts
import { createD402 } from "@d402/server";
import { createD402McpServer, createStreamableHttpApp } from "@d402/mcp-seller";
import { serve } from "@hono/node-server";
import { z } from "zod";

const d402 = createD402({ /* as above */ });
d402.tasks.loadFile("tasks.jsonl");

function makeMcp() {
  const { server, gated } = createD402McpServer({ d402 });
  gated(
    "search",
    { description: "Search the index.", inputSchema: { q: z.string() } },   // scope defaults to /mcp/search
    async ({ q }) => ({ content: [{ type: "text", text: `hits for ${q}` }], structuredContent: { hits: [] } }),
  );
  return server;
}

const { app } = createStreamableHttpApp({ d402, mcp: makeMcp });   // /.well-known/d402* and /mcp
app.use("/search", d402.gate);                                      // the HTTP twin, same vouchers
app.get("/search", (c) => c.json({ hits: [] }));
serve({ fetch: app.fetch, port: Number(process.env.PORT ?? 8788) });
```

`createD402McpServer` returns `{ server, gated, sessions }`. `createStreamableHttpApp`
returns `{ app, sessions, path, close }`. `mcp` is a factory called once per MCP
session, which is the SDK's recommended pattern (one `McpServer` and one
transport per session); a single instance is accepted but serves one session.

The MCP endpoint uses the SDK's `WebStandardStreamableHTTPServerTransport`. It
takes a web-standard `Request` and returns a `Response`, so Hono's `c.req.raw`
goes straight in: no Node `req`/`res` conversion, no `fetch-to-node`, and the
same code runs under `@hono/node-server`, Cloudflare Workers, Deno or Bun. The
`StreamableHTTPServerTransport` in the SDK's examples is a thin Node wrapper
around this same class.

These methods on `@d402/server` back the tools, so anything the HTTP routes can
do, the MCP tools can: `d402.issueBundle(...)`, `d402.submitBundle(...)` (both
throw `TaskError` with the route's `code` and `status`) and `d402.spend(...)`
(the gate's checks and decrement, returning `{ remaining, claims }` or
`{ error, message }`).

## Hosting

The binary is a plain Streamable HTTP MCP server on `PORT` with no state
outside the SQLite file (`--db`; in memory by default), so it deploys on any
MCP host from this repo: Manufact, Cloudflare, Fly, a container. Set
`D402_SECRET` so vouchers survive restarts and `--public-url` to the URL agents
see, since it is written into the offer's `taskUrl`.

```sh
pnpm --filter @d402/mcp-seller run start -- --tasks tasks.jsonl --labels a,b   # local
PORT=8788 D402_SECRET=... d402-mcp-seller --db /data/d402.sqlite --public-url https://seller.example
```

The per-IP rate limit reads `X-Forwarded-For` (or `X-Real-IP`) on the MCP
side; behind a host's proxy that is the agent's IP, bare on a socket it is
`unknown` for everyone, and the per-key limits still apply.

## CLI flags

```
--tasks <file.jsonl>        classify task file (SPEC 10); default: a built-in 20-item demo pool
--labels <a,b,...>          classify labels, at least 2 (default: derived from the task file's goldens)
--scope <prefix,...>        voucher scope prefixes (default: /mcp/search); list /search too to share vouchers with HTTP routes
--port <n>                  listen port (default: env PORT, else 8788; 0 picks a free port)
--secret <s>                voucher HMAC secret (default: env D402_SECRET, else random with a warning)
--seller-id <id>            sellerId in the offer (default: d402-mcp-seller)
--public-url <url>          public base URL, for taskUrl (default: http://localhost:<port>)
--tier <id:items:tokens:calls>  a tier; repeatable (default: s:5:1000:10 m:25:5000:60 l:50:10000:150)
--db <path>                 SQLite path (default: in memory)
--path <p>                  MCP endpoint path (default: /mcp)
--tools-module <file.js>    module exporting register(gated, { d402, server }) that adds your gated tools
--no-search                 do not register the demo search tool
--no-session-keys           agents must pass key (and sign); no per-session keypairs
--bind-vouchers             SPEC 7.1: spends must be signed by the agent key (the server signs in session mode)
--require-spend-nonce       SPEC 7.2: bound spends must carry a nonce
--require-model-families    resolution needs votes from 2 model families
--instructions <text>       instructions shown in every bundle
--name <s>                  MCP server name (default: d402-seller)
```

The port is printed to stderr as `d402-mcp-seller listening on http://localhost:<port>`.

## Adding your own gated tools

Without touching the package, write a module that exports `register`:

```js
// my-tools.mjs
import { z } from "zod";

export function register(gated, { d402 }) {
  gated(
    "lookup",
    { description: "Look up a ticker.", inputSchema: { symbol: z.string() }, scope: "/mcp/lookup" },
    async ({ symbol }) => ({ content: [{ type: "text", text: `${symbol}: 101.2` }], structuredContent: { symbol, price: 101.2 } }),
  );
}
```

```sh
d402-mcp-seller --tools-module ./my-tools.mjs --scope /mcp --no-search
```

`gated(name, config, handler)` takes the same `config` as the SDK's
`registerTool` (`title`, `description`, `inputSchema`, `annotations`) plus
`scope`, the path the spend is checked against. The handler receives only your
own args; the `d402_*` args are consumed before it runs. `register` may be
async and is called once per MCP session.
