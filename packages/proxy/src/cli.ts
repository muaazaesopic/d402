#!/usr/bin/env node
/**
 * d402-proxy: one command to put a d402 gate in front of an existing API.
 *
 *   d402-proxy --upstream https://api.example.com --tasks ./tasks.jsonl --labels a,b,c
 */
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { serve } from "@hono/node-server";
import { HelpRequested, USAGE, createProxyApp, parseArgs, DEFAULT_PORT } from "./index.js";

export function main(argv: string[]): void {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (e) {
    if (e instanceof HelpRequested) {
      process.stdout.write(USAGE + "\n");
      process.exitCode = 0;
      return;
    }
    process.stderr.write(`${(e as Error).message}\n`);
    process.exitCode = 2;
    return;
  }

  const port = opts.port ?? DEFAULT_PORT;
  let built: ReturnType<typeof createProxyApp>;
  try {
    built = createProxyApp({ ...opts, port });
  } catch (e) {
    process.stderr.write(`${(e as Error).message}\n`);
    process.exitCode = 2;
    return;
  }
  const { app, d402 } = built;

  const server = serve({ fetch: app.fetch, port }, (info) => {
    const stats = d402.tasks.stats();
    const publicUrl = (opts.publicUrl ?? `http://localhost:${info.port}`).replace(/\/+$/, "");
    const lines = [
      `d402-proxy listening on http://localhost:${info.port}`,
      `  upstream: ${opts.upstream}`,
      `  scope:    ${(opts.scope ?? ["/"]).join(", ")}${opts.open?.length ? `  (open: ${opts.open.join(", ")})` : ""}`,
      `  pool:     ${stats.total} items (${stats.golden} golden)`,
      `  offer:    ${publicUrl}/.well-known/d402`,
    ];
    if (opts.adminToken) lines.push(`  admin:    ${publicUrl}/.well-known/d402/admin/stats`);
    process.stderr.write(lines.join("\n") + "\n");
  });

  const shutdown = () => {
    server.close(() => {
      d402.close();
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 1000).unref();
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

const isMain = (() => {
  try {
    const entry = process.argv[1];
    return !!entry && import.meta.url === pathToFileURL(realpathSync(entry)).href;
  } catch {
    return false;
  }
})();

if (isMain) main(process.argv.slice(2));
