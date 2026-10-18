/**
 * One Hono app that serves the d402 HTTP routes (`/.well-known/d402*`) and
 * the MCP Streamable HTTP endpoint (default `/mcp`).
 *
 * The MCP side uses the SDK's `WebStandardStreamableHTTPServerTransport`,
 * which takes a web-standard `Request` and returns a `Response`, so Hono's
 * `c.req.raw` goes straight in: no Node `req`/`res` conversion, no
 * `fetch-to-node`, and the same code runs under `@hono/node-server`,
 * Cloudflare Workers, Deno or Bun. Sessions follow the SDK's recommended
 * pattern: one transport and one `McpServer` per session, created on the
 * `initialize` request and looked up by the `Mcp-Session-Id` header after.
 */
import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import type { D402Server } from "@d402/server";

export interface StreamableHttpAppOptions {
  d402: D402Server;
  /**
   * The MCP server to serve. A factory is called once per session, which is
   * what the SDK recommends. A single `McpServer` instance can only be
   * connected to one transport, so passing an instance serves the first
   * session and refuses the next.
   */
  mcp: McpServer | (() => McpServer | Promise<McpServer>);
  /** Path of the MCP endpoint. Default "/mcp". */
  path?: string;
  /** Called when a session starts or ends. */
  onSession?: (event: "open" | "close", sessionId: string) => void;
}

export interface McpSession {
  transport: WebStandardStreamableHTTPServerTransport;
  server: McpServer;
}

export interface StreamableHttpApp {
  app: Hono;
  /** Live MCP sessions by session id. */
  sessions: Map<string, McpSession>;
  /** The MCP endpoint path. */
  path: string;
  /** Closes every live session. */
  close(): Promise<void>;
}

export const DEFAULT_MCP_PATH = "/mcp";

function rpcError(code: number, message: string) {
  return { jsonrpc: "2.0" as const, error: { code, message }, id: null };
}

export function createStreamableHttpApp(opts: StreamableHttpAppOptions): StreamableHttpApp {
  const { d402 } = opts;
  const path = opts.path ?? DEFAULT_MCP_PATH;
  const sessions = new Map<string, McpSession>();

  let instanceUsed = false;
  const makeServer = async (): Promise<McpServer> => {
    if (typeof opts.mcp === "function") return await opts.mcp();
    if (instanceUsed) {
      throw new Error("d402-mcp-seller: a single McpServer instance serves one session; pass a factory `() => McpServer` for more");
    }
    instanceUsed = true;
    return opts.mcp;
  };

  const app = new Hono();

  // d402 offer and task routes: the same voucher an agent earns here spends on the MCP tools.
  app.route("/", d402.routes);

  app.all(path, async (c) => {
    const sid = c.req.header("mcp-session-id");
    if (sid) {
      const s = sessions.get(sid);
      if (!s) return c.json(rpcError(-32001, "Session not found"), 404);
      return s.transport.handleRequest(c.req.raw);
    }
    if (c.req.method !== "POST") {
      return c.json(rpcError(-32000, "Bad Request: Mcp-Session-Id header is required"), 400);
    }
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json(rpcError(-32700, "Parse error: body must be JSON"), 400);
    }
    if (!isInitializeRequest(body)) {
      return c.json(rpcError(-32000, "Bad Request: no valid session ID provided; send an initialize request first"), 400);
    }

    let server: McpServer;
    try {
      server = await makeServer();
    } catch (e) {
      return c.json(rpcError(-32000, (e as Error).message), 503);
    }
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => {
        sessions.set(id, { transport, server });
        opts.onSession?.("open", id);
      },
      onsessionclosed: (id) => {
        if (sessions.delete(id)) opts.onSession?.("close", id);
      },
    });
    transport.onclose = () => {
      const id = transport.sessionId;
      if (id && sessions.delete(id)) opts.onSession?.("close", id);
    };
    await server.connect(transport);
    return transport.handleRequest(c.req.raw, { parsedBody: body });
  });

  const close = async () => {
    const live = [...sessions.values()];
    sessions.clear();
    await Promise.all(
      live.map(async (s) => {
        await s.transport.close().catch(() => {});
        await s.server.close().catch(() => {});
      }),
    );
  };

  return { app, sessions, path, close };
}
