# 04 MCP agent

The flow an LLM agent runs, without the LLM. The story starts a glossary API
gated by d402, spawns the real MCP server binary
(`node --import tsx packages/mcp/src/bin.ts`, `D402_HOME` in a temp dir) with
the SDK's `StdioClientTransport`, connects a `Client`, lists the tools, and
calls them in the order the server's own instructions give:
`d402_discover` -> `d402_get_bundle` -> (label the items; here the hidden truth
map answers in place of the model) -> `d402_submit` -> `d402_fetch` ->
`d402_status`. Every tool result is printed, trimmed. The keypair and the voucher
cache live in `$D402_HOME`, which is deleted at the end.

```sh
pnpm --filter d402-uc-mcp-agent run start
```

What you will see (abridged):

```
2. spawned: node --import tsx packages/mcp/src/bin.ts (D402_HOME=/tmp/d402-uc04-home-...); tools: d402_discover, d402_get_bundle, d402_submit, d402_fetch, d402_status
3. tool calls:
   -> d402_discover({"baseUrl":"http://127.0.0.1:42391"})
      { "sellerId": "docs.example", "taskUrl": ".../.well-known/d402/tasks", "scope": [ "/lookup" ], "tiers": [ { "id": "s", "items": 5, ... } ], "hint": ... }
   -> d402_get_bundle({"taskUrl":"...","tier":"s"})
      { "bundleId": "b_...", "labels": [ "sports", "business", "tech", "world" ], "items": [ { "id": "n_0 ...
   -> d402_submit({"taskUrl":"...","bundleId":"b_...","answers":{...}})
      { "jti": "v_...", "sellerId": "docs.example", "calls": 10, "scope": [ "/lookup" ], "hint": "Voucher stored. ..." }
   -> d402_fetch({"url":"http://127.0.0.1:42391/lookup?term=d402"})
      { "status": 200, "ok": true, "headers": { "D402-Calls-Remaining": "9" }, "body": "{\"term\":\"d402\",...}" }
   -> d402_status({})
      { "publicKey": "...", "vouchers": [ { "jti": "v_...", "sellerId": "docs.example", "calls": 9, ... } ] }

RESULT: d402_submit earned 10 calls, d402_fetch got HTTP 200 with 9 calls left, 1 voucher in ...'s cache
```

## Wiring the same server into a real agent

Claude Code, with the published binary (`pnpm add -g @d402/mcp`):

```sh
claude mcp add d402 -e D402_HOME=~/.d402 -- d402-mcp
```

From this checkout, without installing:

```sh
claude mcp add d402 -e D402_HOME=~/.d402 -- node --import tsx /ABSOLUTE/PATH/d402/packages/mcp/src/bin.ts
```

Claude Desktop (`claude_desktop_config.json`), same shape as `.mcp.json` for
Claude Code:

```json
{
  "mcpServers": {
    "d402": {
      "command": "d402-mcp",
      "env": { "D402_HOME": "~/.d402" }
    }
  }
}
```

What the agent says, once it has the tools (a 5-line transcript):

```
User:  Look up "d402" on http://127.0.0.1:42391/lookup.
Agent: d402_fetch returned 402: the seller wants a d402 voucher. I'll earn one. d402_discover: taskUrl ..., tier s is 5 items for 10 calls.
Agent: d402_get_bundle gave me 5 news snippets to label as sports/business/tech/world. Labelling: n_0012 tech, n_0041 world, n_0007 sports, n_0033 business, n_0019 tech.
Agent: d402_submit: voucher stored, 10 calls on /lookup. Retrying d402_fetch.
Agent: 200 OK, 9 calls remaining. "d402: pay for API access with labelled data instead of micropayments."
```
