# d402 use cases

Seven short, runnable stories. Each one starts a real seller (`@d402/server` on
port 0), runs one or more agents (`@d402/client`, or the real `@d402/mcp` binary),
prints what happened and exits. No mocks, no network, no LLM: a seeded "model"
answers from a hidden truth map with a fixed accuracy, so every run is reproducible
and finishes in a couple of seconds.

```sh
pnpm install
pnpm --filter 'd402-uc-*' run start          # all seven (add --workspace-concurrency=1 for unmixed output)
pnpm --filter d402-uc-paid-crawl run start   # one of them
pnpm exec vitest run use-cases               # the 7 tests
```

`node:sqlite` prints an `ExperimentalWarning` on start; that is expected. The
`start` scripts run `tsx` against the packages' built `dist/` (run `pnpm build`
after changing a package); the tests resolve `@d402/*` to `src/` through the
root vitest aliases.

`_shared/` is not a package. It holds `gen.ts` (seeded PRNG, three templated
datasets, truth map, noisy lookup) and `harness.ts` (port-0 listener, logger),
imported by relative path. It deliberately imports nothing from the workspace.

| Folder | Seller | Agent | Story in one line |
|---|---|---|---|
| [`01-dataset-builder`](01-dataset-builder/) | a helpdesk with no API | 3 labelling agents | the labels are the product |
| [`02-x402-side-by-side`](02-x402-side-by-side/) | a quote API | one with a wallet, one without | same 402, USDC or labels |
| [`03-rate-limit-upgrade`](03-rate-limit-upgrade/) | a weather API with a free tier | one agent, 12 requests | work lifts the limit, no 429 |
| [`04-mcp-agent`](04-mcp-agent/) | a glossary API | the real MCP server over stdio | the LLM is its own solver |
| [`05-multi-seller-wallet`](05-multi-seller-wallet/) | three unrelated sellers | one key, one voucher file | earn once per seller, spend anywhere |
| [`06-trust-tiers`](06-trust-tiers/) | a 1300-item pool | honest p=0.95 vs lazy | 0.4 -> 0.2 -> 0.1 goldens; lazy cut at 5 |
| [`07-paid-crawl`](07-paid-crawl/) | a 10-article magazine | a crawler | one bundle buys the whole crawl |

## 01 dataset builder

The seller is a helpdesk that wants 500 support tickets labelled by urgency
(`low`, `medium`, `high`, `critical`). It has nothing to sell, so it gates a
trivial `GET /thanks`; a 50-item bundle is worth one call to it. Three agents
of different model families (claude, gpt, gemini; roughly 90% accurate, seeded)
label until the seller has nothing new for them. What the agent gets is a
thank-you; what the seller gets is `d402.tasks.exportResolved()`: every ticket
on which three distinct keys agreed with enough weight, written to
`out/labels.jsonl` and scored here against the hidden truth (100%). Cents do not
buy this: paying 0.1 cent per ticket needs payouts and fraud handling and tells
you nothing about quality; here the payment is the labels, and the golden items
are the quality check. Run: `pnpm --filter d402-uc-dataset-builder run start`.

## 02 x402 side by side

The seller is a quote API whose 402 lists two entries in `accepts`: an x402-style
`{ scheme: "exact", network: "base", asset: "USDC", amount: "7000", payTo }` and
d402. The agent with a wallet reads the exact entry and would pay 0.007 USDC
(x402 settlement is not implemented in this demo, it stops there); the agent
without a wallet labels 5 news snippets and gets the quote in about 30 ms, with 9
calls left. The point is choice: the same handshake, two currencies, and the
agent that has tokens but no treasury is not locked out. Run:
`pnpm --filter d402-uc-x402-side-by-side run start`.

## 03 rate limit upgrade

The seller is a public weather API with a free tier of 5 requests per minute per
IP, implemented as a tiny in-memory limiter in front of the d402 gate. Request
6 does not get a 429: it gets the d402 402 offer. The agent, using plain
`client.fetch`, labels one bundle and continues on the paid tier; the wire log
shows 5 free hits, the 402, the bundle GET, the signed submit, and 7 paid hits
with `D402-Calls-Remaining` counting down. Compared with a card or an API key,
the upgrade needs no account and the work benefits the API owner. Run:
`pnpm --filter d402-uc-rate-limit-upgrade run start`.

## 04 MCP agent

The seller is a glossary API. The agent is the real `@d402/mcp` server, spawned
as `node --import tsx packages/mcp/src/bin.ts` with `D402_HOME` in a temp
directory and driven over stdio with the MCP SDK's `Client`, calling
`d402_discover -> d402_get_bundle -> d402_submit -> d402_fetch -> d402_status`
exactly as an LLM would, with the hidden truth map standing in for the model's
labels. Each tool result is printed trimmed. The folder README has the
`claude mcp add` command, the Claude Desktop JSON and a 5-line transcript of what
the agent says. With cents the agent harness would need a wallet integration;
here it needs five tools. Run: `pnpm --filter d402-uc-mcp-agent run start`.

## 05 multi-seller wallet

Three sellers with different sellerIds, scopes, labels and tiers (news
headlines, helpdesk stats, shop reviews) run in one process. One agent with a
`FileVoucherCache` fetches from all three, earning one voucher per seller; the
cache file then holds 3 vouchers. A second client built from the same directory,
with no solver at all, discovers each seller and spends the cached vouchers
without earning anything; `client.status()` shows the balances going 9/19/14 to
8/18/13. A wallet made of per-seller vouchers in one JSON file, no balances on
any chain. Run: `pnpm --filter d402-uc-multi-seller-wallet run start`.

## 06 trust tiers

The seller is a 1300-snippet pool with rate limits raised so 60 rounds fit in
two seconds. An honest agent (p=0.95) earns 60 bundles of 20 items; every 10
bundles the story prints the seller's accuracy estimate, the golden ratio band it
puts the agent in (recomputed with `goldenRatio` from `@d402/server`), the
number of goldens in the next bundle and the calls earned. A lazy agent that
always answers the first label gets `403 blocked` on its 6th request. A
micropayment says nothing about quality; the golden system builds a reputation
that cuts the honest agent's overhead (8 -> 4 -> 2 goldens per bundle) and cuts
the lazy agent off for free. Run: `pnpm --filter d402-uc-trust-tiers run start`.

## 07 paid crawl

The seller is a content site with 10 articles behind `GET /articles/:id`, scope
`["/articles"]`, one tier that pays 12 calls for 5 labelled snippets. A crawler
with `maxEarnAttempts: 3` fetches all 10 in a loop; it earns once on the first
402 and spends one call per page, and the output prints the calls remaining after
each fetch and the total bundles earned (1). Ten per-page micropayments would be
ten settlements; here it is one bundle. Run:
`pnpm --filter d402-uc-paid-crawl run start`.
