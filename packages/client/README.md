# @d402/client

Agent-side client for the [d402 protocol](../../spec/SPEC.md): a drop-in `fetch`
that earns vouchers by labelling data when a seller answers `402`, caches them,
and spends them on later calls.

## Quickstart

```ts
import { createD402Client, createLlmSolver, loadOrCreateKeypair } from "@d402/client";

const keypair = loadOrCreateKeypair("~/.d402/agent.json"); // Ed25519, created on first run (mode 0600)

const solver = createLlmSolver({
  complete: async (prompt) => callYourModel(prompt), // returns the model's text
});

const client = createD402Client({ keypair, solver, model: "claude" });

// Behaves like fetch. On 402 it earns a voucher, then retries once.
const res = await client.fetch("https://api.example.com/search?q=hello");
console.log(res.status, await res.json());

// Earn ahead of time, or inspect what is cached.
const offer = await client.discover("https://api.example.com");
console.log(await client.status());
```

## Options (`createD402Client`)

| Option | Default | What it does |
|---|---|---|
| `keypair` | required | `{ publicKey, privateKey }` from `loadOrCreateKeypair` or `generateKeypair()` |
| `solver` | none | `(bundle) => Promise<answers>`; needed by `fetch()` and `earn()` |
| `cache` | `new MemoryVoucherCache()` | Voucher store; `FileVoucherCache(dir)` persists to one JSON file with atomic writes |
| `model` | none | Sent as `D402-Model` and `body.model` (used by sellers for model diversity) |
| `tier` | smallest tier by `items` | A tier id, or `(accept) => tierId` |
| `fetch` | `globalThis.fetch` | Transport to use underneath |
| `now` | `Date.now()/1000` | Clock in unix seconds (handy in tests) |
| `maxEarnAttempts` | `3` | Bundles to try when one fails with `422 quality` |
| `signSpends` | `true` | Send `D402-Key`, `D402-Timestamp`, `D402-Sig` on every spend (SPEC 7.1) |

## What `client.fetch` does

1. Looks for a cached, unexpired voucher for the request's seller whose scope covers the path and attaches `D402-Voucher` (plus the 7.1 headers).
2. Sends the request. Anything other than `402` is returned as is; `D402-Calls-Remaining` updates the cache.
3. On a `402` with a d402 offer: evicts the voucher if the seller said it was exhausted, expired or invalid, runs `earn()` (bundle, solver, signed submit), and retries the original request once. A second `402` is returned, never looped on.

Only protocol failures throw (`D402Error` with `code`, `status`, `body`): `earn_failed` after `maxEarnAttempts` quality failures, `bad_offer`, `bad_bundle`, `unreplayable_body` for stream bodies, `no_solver`, and seller error codes such as `bad_tier`, `blocked`, `rate_limited`. Network errors propagate untouched.

## Plugging in an LLM

`createLlmSolver({ complete, maxRetries })` builds a prompt with `buildClassifyPrompt(bundle)` (instructions, allowed labels, numbered items with ids, and a request for a single JSON object `{ itemId: label }`), parses the reply with `parseClassifyAnswers(text, bundle)` (tolerates code fences and surrounding prose, matches labels case-insensitively), and re-asks with a short correction up to `maxRetries` times (default 2) when the reply is unusable.

```ts
import Anthropic from "@anthropic-ai/sdk";
const anthropic = new Anthropic();

const solver = createLlmSolver({
  complete: async (prompt) => {
    const msg = await anthropic.messages.create({
      model: "claude-sonnet-4-5",
      max_tokens: 1024,
      messages: [{ role: "user", content: prompt }],
    });
    return msg.content.map((c) => (c.type === "text" ? c.text : "")).join("");
  },
});
```

For tests and benchmarks, `createLookupSolver(recordOrFn)` answers from a map of item id to label, or from `(item, bundle) => label`.

## Lower-level API

- `client.discover(baseUrl)`: `GET {base}/.well-known/d402`, returns the parsed `Offer`.
- `client.getBundle(taskUrl, tier)`: `GET taskUrl?tier=...` with `D402-Key`.
- `client.submit(taskUrl, bundle, answers, accept?)`: signs with `signSubmit`, POSTs, stores and returns the `StoredVoucher`.
- `client.earn(accept, tier?)`: the three steps above with retries on `quality`.
- `client.status()`: everything in the cache.

## CLI: `d402`

The package ships a `d402` binary (zero extra dependencies) that drives the same client
from a shell. State lives in `$D402_HOME` (default `~/.d402`): `keypair.json`,
`vouchers.json` (a `FileVoucherCache`) and `pending/<bundleId>.json`.

```sh
d402 keygen                                   # create $D402_HOME/keypair.json, print the public key
d402 discover http://localhost:8787           # the seller's d402 accept as JSON
d402 bundle http://localhost:8787 --tier s    # print a bundle; also saved under $D402_HOME/pending/
d402 submit <bundleId> --answers answers.json # sign + submit the pending bundle, print the voucher summary
d402 earn http://localhost:8787 --tier s --answers key.json      # bundle -> solve -> submit in one go
d402 earn http://localhost:8787 --solver-cmd "python solve.py"  # ...with a command as the solver
d402 fetch "http://localhost:8787/search?q=gpu"                 # spend a cached voucher (prints status, headers, body)
d402 fetch "http://localhost:8787/search?q=gpu" --auto-earn --solver-cmd "python solve.py"
d402 fetch http://localhost:8787/search -X POST -d '{"q":"gpu"}' -H "X-Trace: 1"
d402 status                                   # public key, cached vouchers, pending bundles
```

Solvers:

- `--answers <file>`: a JSON object `{ "<itemId>": "<label>" }`. Every item in the bundle
  must be present (`solver_missing_answer` otherwise); extra ids are ignored.
- `--solver-cmd "<cmd>"`: the command gets the bundle JSON on stdin and must print
  `{ "<itemId>": "<label>" }` (or `{ "answers": {...} }`) on stdout. Same contract as the
  MCP package's `D402_SOLVER_CMD`.

Environment: `D402_HOME`, `D402_MODEL` (sent as `D402-Model`), `D402_TIER` (default tier;
`--tier` wins). `--home <dir>` overrides `D402_HOME`.

Exit codes: `0` ok (any HTTP status from `fetch` counts as ok), `1` protocol error with
`error: <code> <message>` on stderr (`bad_tier`, `quality`, `earn_failed`, `unknown_bundle`,
`solver_failed`, ...), `2` usage.

`fetch` without `--auto-earn` only spends: it attaches the best cached voucher for the
seller (with the SPEC 7.1 signed headers) and prints whatever comes back, including a `402`.
With `--auto-earn` it is `client.fetch`: a `402` triggers earn and one retry.

For tests, `main(argv, { stdout, stderr, env, fetch, now })` is exported from
`@d402/client/dist/cli.js`'s source (`src/cli.ts`) and returns the exit code; `fetch` can be a
Hono `app.request` wrapper.
