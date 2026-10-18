# Changelog

## 0.1.0

First release.

- Protocol spec v1 (`spec/SPEC.md`): 402 offer, bundles, golden grading, trust bands, HS256 vouchers, bound spending.
- `@d402/spec`: schemas, headers, defaults, Ed25519 signing helpers.
- `@d402/server`: Hono middleware, SQLite store, `d402-tasks` CLI.
- `@d402/client`: fetch wrapper with voucher cache, LLM and lookup solvers.
- `@d402/mcp`: MCP server with 5 tools so an LLM agent is its own solver.
- `@d402/proxy`: `d402-proxy` CLI to gate any upstream API with one command.
- Python client and curl walkthrough under `clients/`.
- Example gated search API, 7 runnable use cases, benchmark with simulated agents.
