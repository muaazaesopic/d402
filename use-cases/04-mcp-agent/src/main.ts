/**
 * 04 MCP agent: the LLM-side flow, driven by the real @d402/mcp server over stdio.
 *
 * Start a seller, spawn `node --import tsx packages/mcp/src/bin.ts` with
 * D402_HOME in a temp dir, connect with the MCP SDK's stdio client, and call
 * the tools an LLM would call: d402_discover -> d402_get_bundle -> (label the
 * items) -> d402_submit -> d402_fetch -> d402_status. No model is involved: the
 * hidden truth map stands in for the model's answers.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { createD402 } from "@d402/server";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import { DOMAINS, generateDataset, mulberry32, toTaskFile, truthMap } from "../../_shared/gen.js";
import { createLog, isMain, listen, runMain } from "../../_shared/harness.js";

const SEED = 4040;
const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(HERE, "..", "..", "..");
export const MCP_BIN = join(REPO_ROOT, "packages", "mcp", "src", "bin.ts");

export interface Summary {
  tools: string[];
  discover: { sellerId: string; taskUrl: string };
  bundleItems: number;
  submit: { calls: number };
  fetch: { status: number; callsRemaining: string | undefined; body: unknown };
  vouchers: number;
}

type ToolResult = { content?: { type: string; text?: string }[]; isError?: boolean };

export async function run(opts: { silent?: boolean } = {}): Promise<Summary> {
  const log = createLog(opts.silent);
  const domain = DOMAINS.news;
  log.header("04 MCP agent", "The real d402-mcp server over stdio, driven tool by tool the way an LLM would.");

  // 1. Seller: a glossary API gated by d402.
  const items = generateDataset("news", 60, SEED);
  const truth = truthMap(items);
  const site = await listen(serve);
  const d402 = createD402({
    sellerId: "docs.example",
    taskUrl: `${site.baseUrl}/.well-known/d402/tasks`,
    scope: ["/lookup"],
    secret: "uc04-secret",
    labels: domain.labels,
    instructions: domain.instructions,
    tiers: [{ id: "s", items: 5, est_tokens: 800, reward: { calls: 10 } }],
    random: mulberry32(SEED),
  });
  d402.tasks.load(toTaskFile(items, 15, SEED));
  const app = new Hono();
  app.route("/", d402.routes);
  app.use("/lookup", d402.gate);
  app.get("/lookup", (c) => {
    const term = c.req.query("term") ?? "d402";
    return c.json({ term, definition: `${term}: pay for API access with labelled data instead of micropayments.` });
  });
  site.setHandler((req, env) => app.fetch(req, env));
  log.step(1, `seller up at ${site.baseUrl}: GET /lookup?term=... gated (5 snippets -> 10 calls)`);

  // 2. Spawn the MCP server binary with the SDK's stdio transport.
  const home = mkdtempSync(join(tmpdir(), "d402-uc04-home-"));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", "tsx", MCP_BIN],
    cwd: REPO_ROOT,
    env: { ...getDefaultEnvironment(), D402_HOME: home, D402_MODEL: "claude" },
    stderr: "pipe",
  });
  const mcp = new Client({ name: "uc04-agent", version: "0.1.0" });
  await mcp.connect(transport);
  transport.stderr?.on("data", () => {}); // "d402-mcp: listening on stdio"
  const tools = (await mcp.listTools()).tools.map((t) => t.name);
  log.step(2, `spawned: node --import tsx packages/mcp/src/bin.ts (D402_HOME=${home}); tools: ${tools.join(", ")}`);

  const trim = (s: string, n = 300) => {
    const flat = s.replace(/\s+/g, " ").trim();
    return flat.length > n ? flat.slice(0, n) + " ..." : flat;
  };
  async function call(name: string, args: Record<string, unknown>): Promise<Record<string, any>> {
    const r = (await mcp.callTool({ name, arguments: args })) as ToolResult;
    const text = r.content?.find((c) => c.type === "text")?.text ?? "";
    log.line(`-> ${name}(${JSON.stringify(args).slice(0, 80)}${JSON.stringify(args).length > 80 ? "..." : ""})`);
    log.line(`   ${trim(text)}`);
    if (r.isError) throw new Error(`${name} failed: ${text}`);
    return JSON.parse(text) as Record<string, any>;
  }

  // 3. The tool calls, in the order the server's instructions describe.
  log.step(3, "tool calls:");
  const disc = await call("d402_discover", { baseUrl: site.baseUrl });
  const bundle = await call("d402_get_bundle", { taskUrl: disc.taskUrl, tier: "s" });
  const answers: Record<string, string> = {};
  for (const it of bundle.items as { id: string; text: string }[]) answers[it.id] = truth[it.id]!;
  log.line(`   (the agent reads the ${bundle.items.length} items and labels them; here the hidden truth map answers for it)`);
  const sub = await call("d402_submit", { taskUrl: disc.taskUrl, bundleId: bundle.bundleId, answers });
  const got = await call("d402_fetch", { url: `${site.baseUrl}/lookup?term=d402` });
  const status = await call("d402_status", {});

  await mcp.close();
  await site.close();
  d402.close();
  rmSync(home, { recursive: true, force: true });

  const body = (() => {
    try {
      return JSON.parse(got.body as string);
    } catch {
      return got.body;
    }
  })();
  log.result(
    `d402_submit earned ${sub.calls} calls, d402_fetch got HTTP ${got.status} with ${got.headers?.["D402-Calls-Remaining"]} calls left, ` +
      `${status.vouchers.length} voucher in ${status.publicKey.slice(0, 8)}...'s cache`,
  );
  return {
    tools,
    discover: { sellerId: disc.sellerId, taskUrl: disc.taskUrl },
    bundleItems: bundle.items.length,
    submit: { calls: sub.calls },
    fetch: { status: got.status, callsRemaining: got.headers?.["D402-Calls-Remaining"], body },
    vouchers: status.vouchers.length,
  };
}

if (isMain(import.meta.url)) runMain(run);
