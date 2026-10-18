import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { serve, type ServerType } from "@hono/node-server";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { z } from "zod";
import { createD402, type D402Server } from "@d402/server";
import { HEADERS, generateKeypair, signSubmit, type Bundle } from "@d402/spec";
import { createD402McpServer, decodeClaims } from "./server.js";
import { createStreamableHttpApp, type StreamableHttpApp } from "./http.js";

const LABELS = ["a", "b", "c", "d"];
const truth: Record<string, string> = { g1: "a", g2: "b", g3: "c", g4: "d" };

function seller(extra: Record<string, unknown> = {}): D402Server {
  const d = createD402({
    sellerId: "mcp-http-test",
    taskUrl: "http://127.0.0.1/.well-known/d402/tasks",
    scope: ["/search", "/mcp/search"],
    secret: "s",
    labels: LABELS,
    tiers: [{ id: "s", items: 2, est_tokens: 100, reward: { calls: 3 } }],
    ...extra,
  });
  d.tasks.load([
    { id: "g1", type: "classify", text: "x", golden: "a" },
    { id: "g2", type: "classify", text: "y", golden: "b" },
    { id: "g3", type: "classify", text: "z", golden: "c" },
    { id: "g4", type: "classify", text: "w", golden: "d" },
  ]);
  return d;
}

function answersFor(bundle: Pick<Bundle, "items">): Record<string, string> {
  const out: Record<string, string> = {};
  for (const it of bundle.items) out[it.id] = truth[it.id]!;
  return out;
}

function makeMcp(d402: D402Server) {
  const mcp = createD402McpServer({ d402 });
  mcp.gated("search", { description: "demo", inputSchema: { q: z.string() } }, async ({ q }) => ({
    content: [{ type: "text", text: `hits for ${q}` }],
    structuredContent: { q },
  }));
  return mcp.server;
}

function listen(app: StreamableHttpApp): Promise<{ server: ServerType; url: string }> {
  return new Promise((resolve) => {
    const server = serve({ fetch: app.app.fetch, port: 0, hostname: "127.0.0.1" }, (info) => {
      resolve({ server, url: `http://127.0.0.1:${info.port}` });
    });
  });
}

async function connect(url: string) {
  const client = new Client({ name: "http-test-client", version: "0.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(`${url}/mcp`));
  await client.connect(transport);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const res = await client.callTool({ name, arguments: args });
    const text = (res.content as { type: string; text: string }[])
      .filter((c) => c.type === "text")
      .map((c) => c.text)
      .join("\n");
    return { isError: res.isError === true, structured: (res.structuredContent ?? {}) as Record<string, any>, text };
  };
  return { client, transport, call };
}

describe("Streamable HTTP", () => {
  let d402: D402Server;
  let app: StreamableHttpApp;
  let server: ServerType;
  let url: string;
  const events: string[] = [];

  beforeAll(async () => {
    d402 = seller();
    app = createStreamableHttpApp({ d402, mcp: () => makeMcp(d402), onSession: (e, id) => events.push(`${e}:${id}`) });
    ({ server, url } = await listen(app));
  });

  afterAll(async () => {
    await app.close();
    await new Promise<void>((r) => server.close(() => r()));
    d402.close();
  });

  it("serves the d402 offer and the MCP endpoint on the same listener", async () => {
    const offer = await fetch(`${url}/.well-known/d402`);
    expect(offer.status).toBe(200);
    expect(((await offer.json()) as { accepts: { scheme: string }[] }).accepts[0]!.scheme).toBe("d402");

    const c = await connect(url);
    expect(c.transport.sessionId).toBeTruthy();
    expect(app.sessions.has(c.transport.sessionId!)).toBe(true);
    expect(events).toContain(`open:${c.transport.sessionId}`);
    const { tools } = await c.client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(["d402_get_bundle", "d402_offer", "d402_status", "d402_submit", "search"]);
    const instructions = c.client.getInstructions();
    expect(instructions).toContain("d402_get_bundle");
    await c.transport.terminateSession();
    expect(app.sessions.has(c.transport.sessionId!)).toBe(false);
    await c.client.close();
  });

  it("runs the full earn/spend flow in session mode over real HTTP", async () => {
    const c = await connect(url);
    const paid = await c.call("search", { q: "x" });
    expect(paid.isError).toBe(false);
    expect(paid.structured.paymentRequired).toBe(true);

    const b = await c.call("d402_get_bundle");
    expect(b.isError).toBe(false);
    const sub = await c.call("d402_submit", { bundleId: b.structured.bundleId, answers: answersFor(b.structured as Bundle) });
    expect(sub.isError).toBe(false);
    const voucher = sub.structured.voucher as string;

    const one = await c.call("search", { q: "rates", d402_voucher: voucher });
    expect(one.isError).toBe(false);
    expect(one.structured.q).toBe("rates");
    expect(one.structured.d402_calls_remaining).toBe(2);

    const st = await c.call("d402_status");
    expect(st.structured.voucher.callsLeft).toBe(2);
    expect(decodeClaims(voucher)!.sub).toBe(st.structured.publicKey);
    await c.client.close();
  });

  it("two concurrent sessions get different session keys and cannot submit each other's bundles", async () => {
    const [a, b] = await Promise.all([connect(url), connect(url)]);
    expect(a.transport.sessionId).not.toBe(b.transport.sessionId);
    const [sa, sb] = await Promise.all([a.call("d402_status"), b.call("d402_status")]);
    expect(sa.structured.publicKey).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(sb.structured.publicKey).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(sa.structured.publicKey).not.toBe(sb.structured.publicKey);

    const bundle = await a.call("d402_get_bundle");
    const wrongSession = await b.call("d402_submit", { bundleId: bundle.structured.bundleId, answers: answersFor(bundle.structured as Bundle) });
    expect(wrongSession.isError).toBe(true);
    expect(wrongSession.structured.code).toBe("unknown_bundle");
    const right = await a.call("d402_submit", { bundleId: bundle.structured.bundleId, answers: answersFor(bundle.structured as Bundle) });
    expect(right.isError).toBe(false);
    await Promise.all([a.client.close(), b.client.close()]);
  });

  it("a voucher earned over the HTTP task routes spends on the MCP tool over HTTP", async () => {
    const kp = generateKeypair();
    const b = (await (await fetch(`${url}/.well-known/d402/tasks?tier=s`, { headers: { [HEADERS.key]: kp.publicKey } })).json()) as Bundle;
    const answers = answersFor(b);
    const res = await fetch(`${url}/.well-known/d402/tasks/${b.bundleId}`, {
      method: "POST",
      headers: { [HEADERS.key]: kp.publicKey, "content-type": "application/json" },
      body: JSON.stringify({ answers, sig: signSubmit(kp.privateKey, b.bundleId, answers) }),
    });
    expect(res.status).toBe(200);
    const { voucher } = (await res.json()) as { voucher: string };
    const c = await connect(url);
    const r = await c.call("search", { q: "via-http", d402_voucher: voucher });
    expect(r.isError).toBe(false);
    expect(r.structured.d402_calls_remaining).toBe(2);
    await c.client.close();
  });

  it("rejects requests without a session (unless initialize) and unknown sessions", async () => {
    const noSession = await fetch(`${url}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(noSession.status).toBe(400);
    const unknown = await fetch(`${url}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-session-id": "nope" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(unknown.status).toBe(404);
    const get = await fetch(`${url}/mcp`, { headers: { accept: "text/event-stream" } });
    expect(get.status).toBe(400);
    const notJson = await fetch(`${url}/mcp`, { method: "POST", headers: { "content-type": "application/json" }, body: "{" });
    expect(notJson.status).toBe(400);
  });

  it("a single McpServer instance serves one session and refuses a second", async () => {
    const d = seller();
    const single = createStreamableHttpApp({ d402: d, mcp: makeMcp(d), path: "/rpc" });
    const { server: srv, url: u } = await listen(single);
    try {
      const client = new Client({ name: "one", version: "0" });
      await client.connect(new StreamableHTTPClientTransport(new URL(`${u}/rpc`)));
      expect((await client.listTools()).tools.length).toBe(5);
      const second = new Client({ name: "two", version: "0" });
      await expect(second.connect(new StreamableHTTPClientTransport(new URL(`${u}/rpc`)))).rejects.toThrow(/503|factory/);
      await client.close();
    } finally {
      await single.close();
      await new Promise<void>((r) => srv.close(() => r()));
      d.close();
    }
  });
});
