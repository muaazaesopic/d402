# Changelog

## 0.1.0

First release.

- Protocol spec v1 (`spec/SPEC.md`): 402 offer, bundles, golden grading, trust bands, HS256 vouchers, bound spending.
- `@d402/spec`: schemas, headers, defaults, Ed25519 signing helpers.
- `@d402/server`: Hono middleware, SQLite store, `d402-tasks` CLI.
- `@d402/client`: fetch wrapper with voucher cache, LLM and lookup solvers.
- `@d402/mcp`: MCP server with 5 tools so an LLM agent is its own solver.
- `@d402/proxy`: `d402-proxy` CLI to gate any upstream API with one command.
- `@d402/mcp-seller`: the seller as a remote Streamable HTTP MCP server (`d402-mcp-seller`): `d402_offer`/`d402_get_bundle`/`d402_submit`/`d402_status` plus `gated()` paid tools, session or key identity, one voucher across HTTP and MCP. `@d402/server` gains `issueBundle`, `submitBundle`, `spend` and exports `TaskError`; routes and gate are thin wrappers over them.
- Python client and curl walkthrough under `clients/`.
- Example gated search API, 7 runnable use cases, benchmark with simulated agents.
