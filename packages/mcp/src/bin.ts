#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createMcpServerFromEnv } from "./config.js";

async function main(): Promise<void> {
  const server = createMcpServerFromEnv(process.env);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stdout is the MCP channel; log to stderr only.
  process.stderr.write("d402-mcp: listening on stdio\n");
}

main().catch((err) => {
  process.stderr.write(`d402-mcp: fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exit(1);
});
