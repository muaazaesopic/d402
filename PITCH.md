# Booth pitches

One card per sponsor. Each has: the 20-second opener, why d402 fits their world,
the one thing to ask them, and what not to claim. Sponsors and claims come from
the 17 Oct speaker notes and public pages. Where I could not confirm a track's
rules, it says so.

## The 20-second version for anyone

"x402 has done 892 million transactions from about a thousand buyers. The rails
work. Almost no agent has a wallet. d402 is the same 402 handshake with a second
way to pay: label 5 items for the seller and get 10 calls. The seller gets a
labelled dataset, the agent needs no wallet, and hidden control items keep it
honest. It's reCAPTCHA for agents."

Then show the 402 body on your phone or laptop. It has both schemes in it.

## x402 (the creator is at the event)

Opener: "Same 402, same `accepts` array, one more payment pattern. You said x402
supports different patterns, 'charge up to a dollar' and so on. Ours is 'pay in
labels'. A seller lists USDC and d402 side by side and the agent picks."

Why it fits: his own talk said agents need paid data and tools, and that ads and
subscriptions stop working when agents cut publishers off from their users.
d402 restores a non-money incentive. His Wirecutter example works for us: instead
of 10 cents for reviews, Wirecutter asks the agent to label 5 reviews as
helpful or not. It gets training data back.

His number is our opening: 892 million transactions, roughly a thousand buyers.

Ask: "Would the Foundation take a non-monetary scheme into the registry? What
would it need to look like?" Also: "Is anyone else working on the no-wallet case?"

Don't claim: that d402 replaces x402, or that we settle anything on chain. We
don't. Use case 02 in the repo shows both paths side by side and says plainly
that the USDC leg is not settled.

## Blaxel ($1,000 for "a project people will never want")

Opener: "Humans hated CAPTCHAs. Nobody will ever label 5 support tickets to read
a web page. An agent does it in 700 tokens and doesn't mind. We built a payment
method only agents will use."

Why it fits: their prize is for something built only for agents. d402 is that by
construction. Second angle, closer to their product: an agent running in a
Blaxel sandbox has no wallet, no card, no human nearby. d402 is how that agent
buys data without any of those.

Ask: "How do we enter? Is it a form, a tag on the submission, or just telling
the judges?" The notes don't say.

Don't claim: anything about their sandboxes we haven't tried. We haven't run
d402 inside Blaxel.

## Manufact ("best MCP server for agents", $3k cash + $3k credits, Claude Connectors marketplace)

Status: this fits now. `@d402/mcp-seller` is in the repo: a remote MCP server
over Streamable HTTP whose tools are paid in labels. One voucher is valid on
both the seller's HTTP routes and its MCP tools. Session mode needs no keypair
(zero setup, trust resets per session); key mode carries the agent's Ed25519
identity and trust. Run it with `pnpm --filter @d402/mcp-seller run start`; the
binary serves a demo `search` tool out of the box. Our agent-side server
(`@d402/mcp`, local stdio) is the other half; pitch the seller side to Manufact.

Opener: "An MCP server where the tools cost labels instead of
money. The agent calls `search`, gets 'payment required' with instructions,
calls `d402_get_bundle`, labels 5 items, calls `d402_submit`, then calls
`search` again with the voucher. Zero signup, zero card, hostable anywhere a
Streamable HTTP MCP server runs, including Manufact."

Why it fits: their brief says infrastructure agents use to complete end-to-end
tasks. A paid tool with its own built-in way to pay is exactly end to end. And
every MCP server that costs money to run needs a way to charge agents that
don't have wallets.

Ask: "What does admission to the Connectors marketplace require from the server
side? OAuth? A manifest?" And: "Can we deploy from our repo today to show it
running on Manufact?" If yes, do it before judging.

Don't claim: that it's built with mcp-use. It uses the official MCP SDK. If they
ask, say it's plain Streamable HTTP and would port to mcp-use in an afternoon.

## Inkbox (persistent identity for agents)

Opener: "Our agent identity is an Ed25519 keypair in a file. The seller remembers
a trust score against it: fewer control items and bigger rewards over time. The
same file works in our TS client, Python client and MCP server, so the identity
and its reputation move between harnesses. You said that's what users ask for."

Why it fits: their talk's third trend was identities moving between harnesses,
and their second was agents signing up for themselves. d402 is a way for a
self-signed-up agent to buy things with nothing but its key.

Ask: "Could an Inkbox identity carry a d402 keypair, so the reputation an agent
earns labelling data rides along with its email and phone number?"

Don't claim: an integration. There isn't one.

## Primitive (agents as primary customers, obsess over agent experience)

Opener: "You said ask the agent what it wants. We did. The 402 body now carries
one plain sentence telling an agent that has never seen d402 where to get a
bundle, how many items, what it earns and how to sign. Agents get through a 402
far more often when the body says what to do."

Why it fits: his whole talk was agent experience. Our bench simulates 7 agents
including lazy, replay and same-model-family ones, which is his "simulate
everything, then fix what breaks".

Ask: "What did your agents trip on first when you rebuilt email for them?
We want the same list for payments."

Don't claim: that we've watched real LLM agents at scale. The bench is
simulated; say so.

## Stripe (Link agent wallet, Stripe Projects track)

Opener: "Link is the wallet for agents that have a human and a budget. d402 is
for the ones that don't. The same 402 can list both."

Why it fits, loosely: Stripe's talk was about agents that build and run
businesses and need to buy services themselves. Those agents start with no
money. d402 is how they get their first data before they have revenue.

Their track wants Stripe Projects used in your stack and shared with the
hashtag. We don't use it. Don't pretend to. If there is spare time, `stripe
projects add` for the demo host and share the URL; otherwise skip the track.

Ask: "Does Link expose spend limits per merchant to the agent? We'd like the
agent to choose 'pay' or 'label' based on its remaining budget."

## Things every booth will ask

- "What stops a random agent?" Hidden control items. A random agent fails 80%
  of bundles and is blocked after 5. The bench shows it earned 0 calls.
- "Same model, same wrong answer?" `requireModelFamilies` makes 2 model families
  agree before a label resolves. Honest caveat: real models are more correlated
  than our simulation. That's the open risk.
- "Who writes the tasks?" The seller, from a JSONL file. The v2 business is a
  shared pool where dataset buyers post work and any API seller draws from it.
- "Is it real?" 5 packages, Python client, 7 use cases, 434 tests, CI green,
  MIT. github.com/napoleon1313/d402.
