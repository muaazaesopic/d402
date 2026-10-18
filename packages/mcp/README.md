# @d402/mcp

An MCP server (stdio) that lets an LLM agent pay for API access with labelled
data instead of money. The agent is its own solver: it reads a bundle, labels
the items, and this server holds the Ed25519 keypair, signs the submission,
stores the voucher and spends it on later requests.

## Install and register

```sh
pnpm add -g @d402/mcp   # provides the `d402-mcp` binary
```

Claude Code (`.mcp.json` in your project, or `~/.claude.json`) and Claude
Desktop (`claude_desktop_config.json`) use the same shape:

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

With Claude Code you can also run `claude mcp add d402 -e D402_HOME=~/.d402 -- d402-mcp`.

### Environment

| Variable | Default | Meaning |
|---|---|---|
| `D402_HOME` | `~/.d402` | Keypair at `$D402_HOME/keypair.json` (created on first run); vouchers cached in the same directory. |
| `D402_MODEL` | unset | Model family sent as `D402-Model` (for example `claude`). Helps sellers meet the diversity rule. |
| `D402_TIER` | unset | Default tier id when a tool call does not name one. |
| `D402_SOLVER_CMD` | unset | Shell command used by `d402_fetch { autoEarn: true }`: bundle JSON on stdin, answers JSON on stdout. |

## Tools

| Tool | Input | Output |
|---|---|---|
| `d402_discover` | `{ baseUrl }` | `sellerId`, `taskUrl`, `tiers`, `scope`, or an error if the seller does not offer d402. |
| `d402_get_bundle` | `{ taskUrl?, tier?, baseUrl? }` | `bundleId`, `labels`, `items`, `instructions`, `expiresAt` and a hint. Give `tier`, or `baseUrl` so the smallest tier is picked. The bundle is remembered for validation. |
| `d402_submit` | `{ taskUrl, bundleId, answers }` | Voucher summary `{ jti, calls, scope, expiresAt, sellerId }`. Answers are checked locally first (every item answered, labels valid). A `quality` failure means: get another bundle. |
| `d402_fetch` | `{ url, method?, headers?, body?, autoEarn? }` | `{ status, headers, body }` (body truncated at 64KB). On a 402 with a d402 offer it returns the offer and tells you how to earn; with `autoEarn: true` and `D402_SOLVER_CMD` set it earns and retries. |
| `d402_status` | `{}` | Cached vouchers and the agent's public key. |

## Earning in three steps

1. `d402_discover { baseUrl: "https://api.example.com" }` (or just call `d402_fetch`; a 402 reply carries the same offer). Note the `taskUrl` and a tier id.
2. `d402_get_bundle { taskUrl, tier: "s" }`. Label every item with exactly one of `labels`.
3. `d402_submit { taskUrl, bundleId, answers: { "i_1": "tech", "i_2": "sports" } }`. The voucher is stored; `d402_fetch` on any path in `scope` now spends it and reports `D402-Calls-Remaining`.

## Programmatic use

```ts
import { createMcpServer, createClientFromEnv } from "@d402/mcp";

const server = createMcpServer({ client: createClientFromEnv(), defaultTier: "s" });
// connect `server` to any MCP transport
```

`createMcpServer` only needs an object with the `D402Client` shape
(`keypair`, `fetch`, `discover`, `getBundle`, `submit`, `earn`, `status`), so
it can be driven with a fake in tests.
