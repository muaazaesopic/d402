# d402 bench report

Generated 2026-10-18T07:29:28.371Z. 2000 items, 15% golden, seed 42, 60 rounds per agent, tier m.

### run-A (requireModelFamilies=false)

| metric | value | bar | pass |
|---|---|---|---|
| resolvedAccuracy | 0.999 | >= 0.9 and > single-agent (0.919) | yes |
| honestGoldenPassRate | 0.956 | > 0.85 | yes |
| bundlesPerResolution | 3 | < 4 | yes |
| tokensPerCall | 83.333 | < 200 | yes |
| addedLatencyMs | 0.989 | < 500 | yes |
| bundlesUntilLazyCut | 5 | <= 5 | yes |
| singleAgentAccuracy | 0.919 | (reference) | - |
| resolvedCount | 831 | (reference) | - |
| honestBundlesAttempted | 180 | (reference) | - |
| gatedLatencyMs / baselineLatencyMs | 1.625 / 0.636 | (reference) | - |
| lazyBlocked | true | (reference) | - |
| replayAgentCalls | 0 | (reference) | - |
| monocultureWrongResolved | 1 | (reference) | - |

**GO** (run-A (requireModelFamilies=false))


### run-B (requireModelFamilies=true)

| metric | value | bar | pass |
|---|---|---|---|
| resolvedAccuracy | 0.998 | >= 0.9 and > single-agent (0.914) | yes |
| honestGoldenPassRate | 0.950 | > 0.85 | yes |
| bundlesPerResolution | 3 | < 4 | yes |
| tokensPerCall | 83.333 | < 200 | yes |
| addedLatencyMs | 1.064 | < 500 | yes |
| bundlesUntilLazyCut | 5 | <= 5 | yes |
| singleAgentAccuracy | 0.914 | (reference) | - |
| resolvedCount | 875 | (reference) | - |
| honestBundlesAttempted | 180 | (reference) | - |
| gatedLatencyMs / baselineLatencyMs | 1.505 / 0.441 | (reference) | - |
| lazyBlocked | true | (reference) | - |
| replayAgentCalls | 0 | (reference) | - |
| monocultureWrongResolved | 2 | (reference) | - |

**GO** (run-B (requireModelFamilies=true))


## Agents

### run-A

| agent | kind | model | p | received | passed | calls | blocked | server accuracy |
|---|---|---|---|---|---|---|---|---|
| honest-claude-0.92 | honest | claude | 0.92 | 60 | 56 | 3360 | false | 0.893 |
| honest-gpt-0.88 | honest | gpt | 0.88 | 60 | 56 | 3360 | false | 0.898 |
| honest-gemini-0.95 | honest | gemini | 0.95 | 60 | 60 | 3600 | false | 0.940 |
| lazy | lazy | llama | - | 5 | 0 | 0 | true | 0.288 |
| replay | replay | llama | - | 5 | 0 | 0 | true | 0.250 |
| mono-gpt-a | monoculture | gpt | 0.85 | 60 | 50 | 3000 | false | 0.860 |
| mono-gpt-b | monoculture | gpt | 0.85 | 60 | 54 | 3240 | false | 0.882 |

Pool: {"total":2000,"golden":300,"unknownOpen":869,"resolved":831,"retiredGolden":0,"agents":7,"blockedAgents":2,"openBundles":0,"vouchers":276}

### run-B

| agent | kind | model | p | received | passed | calls | blocked | server accuracy |
|---|---|---|---|---|---|---|---|---|
| honest-claude-0.92 | honest | claude | 0.92 | 60 | 56 | 3360 | false | 0.907 |
| honest-gpt-0.88 | honest | gpt | 0.88 | 60 | 56 | 3360 | false | 0.902 |
| honest-gemini-0.95 | honest | gemini | 0.95 | 60 | 59 | 3540 | false | 0.953 |
| lazy | lazy | llama | - | 5 | 0 | 0 | true | 0.231 |
| replay | replay | llama | - | 5 | 0 | 0 | true | 0.231 |
| mono-gpt-a | monoculture | gpt | 0.85 | 60 | 52 | 3120 | false | 0.859 |
| mono-gpt-b | monoculture | gpt | 0.85 | 60 | 51 | 3060 | false | 0.865 |

Pool: {"total":2000,"golden":300,"unknownOpen":825,"resolved":875,"retiredGolden":0,"agents":7,"blockedAgents":2,"openBundles":0,"vouchers":274}

## Notes

- Server constructed with bundlesPerKeyPerHour=100000, bundlesPerIpPerHour=1000000, maxOpenBundlesPerKey=50 (spec defaults 60/120/5 would rate-limit a 60-round bench within seconds).
- Agents: 3 honest (p=0.92 claude, 0.88 gpt, 0.95 gemini), 1 lazy (always the first label), 1 replay (memorises passed bundles, random otherwise), 2 monoculture (p=0.85, both family gpt, same shared error pattern).
- bundlesUntilLazyCut counts bundles handed out before the first 403 blocked. SPEC 5.2 only blocks once bundles >= 5, so the bar is set at the rule's floor of 5. The lazy agent earns 0 calls either way because it never passes a golden.
- addedLatencyMs = mean(client.fetch on gated /search with a cached voucher, signed spend) - mean(plain fetch on ungated /health), 50 samples each after a 5-request warm-up, in-process server over loopback. latency.gatedRawMean is the same probe with only the D402-Voucher header.
- bundlesPerResolution counts, per resolved unknown item, the number of PASSED bundles that contained it (runner log); it includes votes for losing labels.
- Agents were driven round-robin (one getBundle+submit at a time), so votes land before the next bundle is issued; BENCH_PARALLEL=1 issues each round's bundles concurrently instead.
