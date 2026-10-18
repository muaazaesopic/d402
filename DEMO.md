# Demo and pitch plan

For the YC "Make Something Agents Want" hackathon (YC SF HQ, Oct 17 to 18, 2026).

What I could confirm about the event: it is in person, around 200 builders, the
framing is tools built for agents rather than for humans, and Manufact sponsors a
"Best MCP server for agents" track. I could not reach the YC event page or the
Luma listing from the build container, so the demo format (time limit, slides or
no slides, video or live) is unconfirmed. Assume a live demo of 2 to 3 minutes,
which is the norm for YC hackathons, and confirm with the organizers.

## The 5 points the demo has to land

1. Agents have no wallet. Micropayments assume one. Most agents today can't pay a cent.
2. d402 keeps the 402 handshake and swaps the medium: label data instead of sending money.
3. The seller gets something worth more than the cents: a labelled dataset.
4. It is cheat-resistant the way reCAPTCHA was: hidden control items, trust that ratchets.
5. It is already usable: one command for sellers, one import for agents, an MCP server for Claude.

## Demo script, 3 minutes

Two terminals side by side. Left: the seller. Right: the agent. Keep a browser
tab on the GitHub repo for the end.

**0:00 to 0:20, the problem.** One sentence: "Agents are now most of the traffic
on the web. Every pay-per-request protocol assumes the agent has money. Most don't."

**0:20 to 0:50, the gate.** Left terminal:

```sh
d402-proxy --upstream http://localhost:9000 --tasks tickets.jsonl --scope /v1 --admin-token demo
```

Right terminal:

```sh
curl -i localhost:8787/v1/search?q=rates
```

Point at the `402` and the `accepts` array. "Same shape as x402. Two ways to pay:
USDC, or label 5 of my support tickets."

**0:50 to 1:40, the earn.** Right terminal, the agent (Claude Code with the d402
MCP server registered). Ask it in plain language: "search this API for rates."
It calls `d402_fetch`, gets the offer, calls `d402_get_bundle`, labels 5 tickets,
calls `d402_submit`, gets a voucher, retries, gets the data. Narrate the one
thing the audience can't see: "one of those 5 was a control item with a known
answer. It never knows which."

**1:40 to 2:20, the seller's side.** Left terminal:

```sh
curl -H "Authorization: Bearer demo" localhost:8787/.well-known/d402/admin/stats
```

Show `resolved` climbing as 3 agents label in a loop (run `use-cases/01-dataset-builder`
in a third pane beforehand, or the bench). "Three agents agreed, so the label is
resolved and exported. The seller just got 500 tickets labelled for free."

**2:20 to 2:50, the numbers.** One slide or the README table:

- resolved-label accuracy 0.999 against hidden ground truth
- 83 tokens per API call earned, under a hundredth of a cent on a small model
- 0.9 ms added per request
- lazy agents and replay agents earned 0 calls

**2:50 to 3:00, the ask.** "Spec, 5 packages, Python client, 7 use cases, 300 tests.
MIT. github.com/napoleon1313/d402."

## If there is a track pitch for "Best MCP server for agents"

Lead with the MCP server. The pitch: every MCP server that costs money to run
needs a way to charge agents. d402 is a drop-in MCP tool set that lets any agent
pay in work, and the seller side is one command. Demo the earn flow inside
Claude Code and nothing else.

## Questions judges will ask, and the answers

- "Why wouldn't I just use x402?" You can list both. d402 is for the agent with no
  wallet and the seller who wants data more than cents. The offer carries both.
- "What stops an agent from answering randomly?" Hidden control items. A random
  agent fails 80% of bundles and is blocked after 5. The bench shows 0 calls earned.
- "What if all agents use the same model and agree on the same wrong label?"
  The seller can require 2 model families before an item resolves. The bench
  shows the wrong-resolution count drop to 0 with it on. Honest answer: real
  models are more correlated than the simulation, and that is the biggest open risk.
- "Who sets the tasks?" The seller, from a JSONL file. The v2 business is a shared
  pool where dataset buyers post tasks and any API seller draws from it.
- "Is the voucher a bearer token?" By default yes. `bindVouchers` ties spends to
  the agent's Ed25519 key. A leaked voucher is then useless.

## Pre-demo checklist

- `pnpm build && pnpm test` green on the demo laptop.
- The MCP server registered in Claude Code: `claude mcp add d402 -- d402-mcp`.
- `tickets.jsonl` loaded, `admin-token` set, a third pane ready to run the labelling loop.
- The README results table open in a tab in case the live part fails.
- Rehearse the earn once so the keypair and voucher cache exist and the first
  402 round trip is fast.
