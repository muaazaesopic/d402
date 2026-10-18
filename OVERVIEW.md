# d402, the whole project

Read this before talking to a judge or a sponsor. Everything here is shipped
and tested unless marked otherwise. Repo: github.com/napoleon1313/d402.

## One paragraph

d402 is an HTTP payment scheme where an agent pays for API access by labelling
data instead of sending money. It uses the same `402 Payment Required` handshake
and the same `accepts` array as x402, so a seller can list USDC and d402 side by
side. The agent asks for a bundle of items, labels them, passes hidden control
items it cannot identify, and receives a voucher worth N calls. The seller gets
a labelled dataset. The agent needs no wallet, no card and no signup. It is
reCAPTCHA for agents.

## The problem, in the sponsors' own words

- The x402 creator at this event: about 892 million x402 transactions from
  "roughly a thousand-ish buyers". The rails exist. Almost no agent has a wallet.
- Inkbox: agents sign up for themselves, and their identity should move between
  harnesses.
- Primitive: agents are the primary customer; design for them, watch them, ask them.
- Blaxel: build something people will never want.

Our claim: every pay-per-request protocol assumes the agent has money. Most
don't. d402 lets the other ones pay too, and the seller gets something it would
otherwise have to buy.

## What is shipped

| Piece | What it does | Tests |
|---|---|---|
| `spec/SPEC.md` | Protocol v1: offer, bundles, grading, trust bands, vouchers, bound spending, spend nonce, hint. | |
| `@d402/spec` | Zod schemas, header names, defaults, Ed25519 signing helpers, canonical JSON. | 7 |
| `@d402/server` | Hono middleware for sellers. SQLite via `node:sqlite`. Golden grading, trust, resolution, HS256 vouchers, key binding, nonce replay protection, rate limits, admin endpoints, `d402-tasks` CLI, programmatic `issueBundle`/`submitBundle`/`spend`. | 90 |
| `@d402/client` | Fetch wrapper for agents: earns on 402, caches vouchers, signs spends, retries once. Pluggable solver (LLM or lookup). File and memory caches. `d402` CLI. | 103 |
| `@d402/mcp` | Agent-side MCP server, stdio. 5 tools so an LLM agent is its own solver. Holds the keypair, signs, stores vouchers. | 37 |
| `@d402/mcp-seller` | Seller-side MCP server over Streamable HTTP. Tools cost labels. One voucher works on HTTP routes and MCP tools. Session mode (no keypair) and key mode. Hostable anywhere. | 32 |
| `@d402/proxy` | `d402-proxy --upstream <url> --tasks tasks.jsonl`: gate any existing API with one command, no code. Admin stats and export. | 41 |
| `@d402/pool` | The marketplace. Vendors post validation work, sites with no data of their own gate with it, votes aggregate across sites. Being built at time of writing; see "Marketplace" below. | |
| `clients/python` | Python client. Same keypair and voucher files as the TS client. Signatures verified byte-equal. | 24 |
| `clients/curl` | The whole protocol in a bash script. | |
| `examples/search-proxy` | Gated search API with a live dashboard for demos. | 11 |
| `use-cases/` | 7 runnable stories, each under 3 seconds, each with a test. | 7 |
| `bench/` | 7 simulated agents against hidden ground truth. Produces the go/no-go numbers. | 24 |
| `tests/e2e` | Real HTTP, real MCP over stdio, abuse scenarios, persistence, binding. | 114 |

466 vitest tests plus 24 Python. CI on Node 22 and 24 and Python. MIT.

## How it works, in six steps

1. Agent requests a gated route. Seller returns 402 with an offer: `accepts` lists
   d402 (and optionally USDC), tiers (5, 25 or 50 items for 10, 60 or 150 calls),
   scope, task URL, and a one-sentence `hint` telling an agent what to do.
2. Agent sends its Ed25519 public key and asks for a bundle at a tier.
3. Seller builds the bundle: some items are golden (known answers), the rest are
   unknown. Shuffled. The agent is never told which is which.
4. Agent labels every item, signs `bundleId + canonical JSON of answers`, posts.
5. Seller grades the goldens. 80% or better (and 1 of 1) passes. On pass: the
   unknown answers become weighted votes, and the seller mints a JWT voucher with
   N calls stored server side. On fail: nothing, and the agent's accuracy drops.
6. Agent retries the route with the voucher. Seller decrements, serves, returns
   `D402-Calls-Remaining`. When calls run out, the agent earns again.

## Design decisions and the problem each one solves

These are the "we thought about that" answers.

- Hidden control items. Random or lazy agents fail 80% of bundles. The bench
  shows lazy and replay agents earned 0 calls.
- Never reveal per-item results. Only pass or fail per bundle. Agents cannot
  learn which items were golden.
- Golden rotation. A golden is retired after 200 exposures so it cannot be
  memorized and shared.
- Trust with a Laplace prior. Accuracy is (correct+1)/(seen+2). New keys see 40%
  goldens; after 50 clean bundles, 10%. A key under 60% after 5 bundles is
  blocked. Trusted agents get cheaper access, which is the loyalty programme.
- Three-voter resolution. Weights are below 1, so an unknown item resolves on its
  third agreeing vote from distinct keys. That is the redundancy that makes the
  resolved label worth more than any single agent's. Bench: 0.999 accuracy on
  resolved labels, best single agent 0.925.
- Model-family diversity. `requireModelFamilies` makes two declared model
  families agree before an item resolves. Monoculture is the real risk: agents on
  one model agree on the same wrong answer. The bench's same-family wrong
  resolutions drop to 0 with it on. Honest caveat: simulated agents err
  independently; real ones correlate more.
- Agents never see the same unknown item twice. No self-agreement.
- Key-bound vouchers. `bindVouchers` requires each spend to be signed by the key
  the voucher was issued to. A leaked voucher is useless.
- Spend nonce. Our own e2e tests found a bound spend could be replayed for 300
  seconds. SPEC 7.2 adds a nonce; replays return `replayed_spend`.
- Scope. Vouchers cover path prefixes. The client refuses to earn for a path the
  offer says is out of scope, so no bundle is wasted.
- Earn ahead, spend later. Vouchers persist in a file. An agent can label during
  idle time and spend when a user is waiting. Cached vouchers are used on a cold
  start with no discovery round trip.
- Rate limits per key, per IP, and on open bundles. The only Sybil defence in v1,
  and we say so.
- Tiers denominated in items with an advisory token estimate. The seller can
  verify items, not tokens. The agent budgets in its own unit.
- The `hint` field. One plain sentence in the 402 so an agent that has never seen
  d402 knows what to do. Added after Primitive's talk.
- Both schemes in one offer. A wallet agent pays USDC, a wallet-less agent pays
  in labels. Use case 02 shows both paths from the same 402.
- Session mode on the MCP seller. A plain Claude connector with no keypair can
  pay. Key mode keeps identity and trust portable.
- One voucher across transports. Earn over HTTP, spend over MCP, or the reverse.
- Portable identity. The keypair file works in the TS client, the Python client
  and the MCP server. Trust follows it. Inkbox's "identity moves between
  harnesses" point.
- Zero-code seller. The proxy gates any upstream in one command.
- Agent experience in error bodies. Every 402 carries the full offer, so a
  failure is also the instructions for fixing it.

## Use cases

Shipped and runnable in `use-cases/`:

1. Dataset builder. A seller with no product API, just 500 tickets to label. 3
   agents, 319 resolved at 100% accuracy, exported as JSONL. No money moved.
2. x402 side by side. One 402, two currencies. Wallet agent would pay 0.007 USDC;
   wallet-less agent gets the data in 35 ms by labelling 5 items.
3. Rate-limit upgrade. Free tier is 5 requests per minute. The 6th gets a 402
   offer instead of a 429. Label a bundle, keep going.
4. MCP agent. Claude Code earns through the 5 MCP tools without an LLM in the
   test loop.
5. Multi-seller wallet. One keypair, one voucher file, three sellers. A second
   solver-less client spends all three without earning.
6. Trust tiers. Honest agent moves 40% to 20% to 10% goldens over 60 bundles.
   Lazy agent blocked at bundle 6 with 0 calls.
7. Paid crawl. A crawler earns once and fetches 10 articles on one voucher.
8. Marketplace (in progress). A vendor posts tickets; two sites with no data of
   their own gate with pool work; votes aggregate across sites; the vendor exports.

What agents can pay with, ranked by value per label, with the human precedent:

1. Pairwise preference (Chatbot Arena). Which of two answers is better. Labs pay
   dollars per comparison. Reserved task type `pairwise`.
2. Search relevance (Google raters). Query plus result, relevant or not. Exa
   could run this today.
3. Classification (what v1 ships). Urgency, topic, sentiment, moderation.
4. Extraction to a schema. Price, address, attributes out of a page. Reserved `extract`.
5. Entity matching. Same product, same company, across two records.
6. OCR and transcript correction (reCAPTCHA v1).
7. Translation checks (Duolingo).
8. Telemetry on the API itself. Error reports, schema mismatches, latency. Zero
   cost to the agent, unavailable to the seller any other way. Reserved `telemetry`.
9. The query itself (Waze). An agent's searches train the seller's ranking.

Who sells: search and retrieval APIs, content sites, data vendors, any MCP
server that costs money to run, free APIs that want a work gate instead of a key,
and with the marketplace, any site at all.

## Marketplace

The hCaptcha model. Three roles:

- Vendor: posts a batch of items with labels and goldens, exports resolved labels.
- Site: has an API and no data need. Leases pool work, gates with it, pushes votes.
- Agent: unchanged. It sees a normal d402 offer.

The pool aggregates votes across all sites with the same three-voter rule, so a
label can resolve from one agent on site A and two on site B. Sites are trusted
parties in v1 and receive golden answers; agents are not trusted. Payouts between
vendor and site are out of scope, and a per-site contribution ledger is kept so
they can be computed later. Sites join with `d402-proxy --pool-url --site-key`.

## The numbers

From `pnpm bench`, 2,000 items, 7 simulated agents, 60 rounds each:

| Number | Value | Bar |
|---|---|---|
| Resolved-label accuracy vs hidden truth | 0.999 | >= 0.90 |
| Best single agent, for comparison | 0.925 | |
| Honest golden pass rate | 0.92 | > 0.85 |
| Bundles per resolved item | 3.0 | < 4 |
| Tokens per call earned | 83 | < 200 |
| Added latency with a cached voucher | 0.9 ms | < 500 ms |
| Calls earned by lazy and replay agents | 0 | |

Caveats to say before a judge does: rate limits were raised for the bench, and
simulated agents err independently.

## Open risks, with the honest answer

- Model monoculture. Real models on one family agree on wrong labels more than
  our simulation. Mitigation: `requireModelFamilies`. Status: untested on real
  models at scale.
- Sybil farms. Many keys sharing golden answers get through v1. Mitigations:
  rotation, hidden results, per-IP limits. A coordinated farm is out of scope and
  the spec says so.
- Task supply. A seller with nothing to label has nothing to gate with. The
  marketplace is the answer.
- Vouchers are bearer tokens by default. `bindVouchers` plus `requireSpendNonce`
  closes it; sellers must turn them on.
- Packages are not on npm yet. Build from the repo.

## Talking to sponsors and judges

`PITCH.md` has one card per sponsor with an opener, the fit, the ask and what
not to claim. `DEMO.md` has the 3-minute script. The short forms:

- Anyone: "892 million transactions, a thousand buyers. Rails work, wallets
  don't exist. Same 402, pay in labels."
- x402: "One more payment pattern in the same accepts array."
- Blaxel: "Humans hated CAPTCHAs. We built one only agents will do."
- Manufact: "An MCP server whose tools cost labels. Hostable anywhere."
- Inkbox: "The keypair is the identity. Trust follows it across harnesses."
- Primitive: "The 402 tells the agent what to do in one sentence."
- Stripe: "Link is for agents with a budget. d402 is for the ones without."

## What comes next

Pairwise and relevance task types. Payouts in the marketplace. Referral calls and
work-available webhooks. Registering d402 as a scheme in the x402 registry.
Publishing to npm and PyPI.
