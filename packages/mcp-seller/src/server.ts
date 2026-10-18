/**
 * The seller side of d402 as an MCP server.
 *
 * Four tools do the earning (`d402_offer`, `d402_get_bundle`, `d402_submit`,
 * `d402_status`) and `gated()` registers the seller's own paid tools. The
 * vouchers are the same HS256 JWTs the HTTP routes mint and check, so one
 * voucher works on both the HTTP routes and the MCP tools of a seller whose
 * `scope` lists both prefixes (for example `["/search", "/mcp/search"]`).
 *
 * Two identity modes:
 *
 * - key mode: the agent passes its own base64url Ed25519 public key as `key`
 *   and signs its submission (`sig`). Trust (fewer goldens, bigger rewards)
 *   follows that key across sellers, sessions and harnesses.
 * - session mode (default, `sessionKeys: true`): the agent passes no key. The
 *   server generates a real Ed25519 keypair per MCP session, earns on its
 *   behalf and signs submissions and bound spends with it. Zero setup, but
 *   trust resets with every session.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { CallToolResult, ServerNotification, ServerRequest, ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import type { ShapeOutput, ZodRawShapeCompat } from "@modelcontextprotocol/sdk/server/zod-compat.js";
import { z } from "zod";
import { TaskError, type D402Server, type SpendInput } from "@d402/server";
import { findD402Accept, generateKeypair, newNonce, signSpend, signSubmit, type Keypair, type VoucherClaims } from "@d402/spec";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface D402McpServerOptions {
  d402: D402Server;
  /** MCP server name. Default "d402-seller". */
  name?: string;
  version?: string;
  /** Server instructions shown to the model. A default explains the earn/spend flow. */
  instructions?: string;
  /**
   * Generate an Ed25519 keypair per MCP session for agents that pass no `key`.
   * Default true. With false, every earning tool requires `key` (and `sig`).
   */
  sessionKeys?: boolean;
  /** Clock in unix seconds; pass the same one as the `d402` server in tests. */
  now?: () => number;
}

export type ToolExtra = RequestHandlerExtra<ServerRequest, ServerNotification>;

export interface GatedToolConfig<Args extends ZodRawShapeCompat> {
  title?: string;
  description?: string;
  /** The tool's own arguments. `d402_voucher` and the bound-spend args are added. */
  inputSchema?: Args;
  /**
   * Scope path the spend is checked against. Default `/mcp/<tool name>`. It must
   * be inside the seller's `scope` for a voucher to cover it.
   */
  scope?: string;
  annotations?: ToolAnnotations;
}

export type GatedToolHandler<Args extends ZodRawShapeCompat> = (
  args: ShapeOutput<Args>,
  extra: ToolExtra,
) => CallToolResult | Promise<CallToolResult>;

export interface D402McpServer {
  server: McpServer;
  /** Register a tool that costs one voucher call per invocation. */
  gated<Args extends ZodRawShapeCompat>(name: string, config: GatedToolConfig<Args>, handler: GatedToolHandler<Args>): void;
  /** The session keypairs minted so far, keyed by MCP session id ("" for stdio / in-memory). */
  sessions: { get(id: string): { publicKey: string } | undefined; readonly size: number };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export const SERVER_NAME = "d402-seller";
export const SERVER_VERSION = "0.1.0";

export const HOW = "Call d402_get_bundle, label the items, call d402_submit, then call the paid tool with the voucher.";

const DEFAULT_INSTRUCTIONS =
  "Tools on this server are paid for in labelled data, not money (d402). " +
  "Call d402_offer to see the price (a bundle of items to label) and what it earns (a voucher worth N calls). " +
  "Then: d402_get_bundle returns items and labels; label every item; d402_submit returns a voucher; " +
  "pass that voucher as d402_voucher to any paid tool until its calls run out, then earn again. " +
  "d402_status shows the calls left on a voucher.";

interface LastVoucher {
  token: string;
  jti: string;
  calls: number;
  scope: string[];
  expiresAt: number;
}

interface Session {
  keypair: Keypair;
  /** Bundles issued to this session's key and not yet submitted. */
  bundles: Set<string>;
  lastVoucher?: LastVoucher;
}

function ok(data: Record<string, unknown>): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }], structuredContent: data };
}

function fail(code: string, message: string, extra: Record<string, unknown> = {}): CallToolResult {
  const data = { error: true, code, message, ...extra };
  return { isError: true, content: [{ type: "text", text: JSON.stringify(data, null, 2) }], structuredContent: data };
}

function failFrom(err: unknown): CallToolResult {
  if (err instanceof TaskError) {
    const extra: Record<string, unknown> = { status: err.status };
    if (err.retryAfter !== undefined) extra.retryAfter = err.retryAfter;
    return fail(err.code, err.message, extra);
  }
  const message = err instanceof Error ? err.message : String(err);
  return fail("internal", message);
}

/** Reads a JWT's claims without verifying it. `d402.spend` is what verifies. */
export function decodeClaims(token: string): VoucherClaims | undefined {
  const parts = token.split(".");
  if (parts.length !== 3) return undefined;
  try {
    const payload = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8"));
    if (!payload || typeof payload !== "object") return undefined;
    const c = payload as Partial<VoucherClaims>;
    if (typeof c.jti !== "string" || typeof c.sub !== "string" || !Array.isArray(c.scope) || typeof c.exp !== "number") return undefined;
    return c as VoucherClaims;
  } catch {
    return undefined;
  }
}

function headerOf(extra: ToolExtra, name: string): string | undefined {
  const headers = extra.requestInfo?.headers as Record<string, string | string[] | undefined> | undefined;
  const v = headers?.[name] ?? headers?.[name.toLowerCase()];
  return Array.isArray(v) ? v[0] : v;
}

/** Client IP for the per-IP rate limit: X-Forwarded-For when a proxy sets it, else "unknown" like the HTTP server. */
function ipOf(extra: ToolExtra): string {
  const xff = headerOf(extra, "x-forwarded-for");
  if (xff) {
    const first = xff.split(",")[0]!.trim();
    if (first) return first;
  }
  return headerOf(extra, "x-real-ip") || "unknown";
}

// ---------------------------------------------------------------------------
// createD402McpServer
// ---------------------------------------------------------------------------

export function createD402McpServer(opts: D402McpServerOptions): D402McpServer {
  const d402 = opts.d402;
  const sessionKeys = opts.sessionKeys ?? true;
  const now = opts.now ?? (() => Math.floor(Date.now() / 1000));
  const sessions = new Map<string, Session>();

  const server = new McpServer(
    { name: opts.name ?? SERVER_NAME, version: opts.version ?? SERVER_VERSION },
    { instructions: opts.instructions ?? DEFAULT_INSTRUCTIONS },
  );

  const sessionIdOf = (extra: ToolExtra): string => extra.sessionId ?? "";

  function session(extra: ToolExtra): Session {
    const id = sessionIdOf(extra);
    let s = sessions.get(id);
    if (!s) {
      s = { keypair: generateKeypair(), bundles: new Set() };
      sessions.set(id, s);
    }
    return s;
  }

  const modeText = sessionKeys
    ? "Identity: pass `key` (your base64url Ed25519 public key) to earn under your own identity, so the trust you build " +
      "(fewer control items, bigger rewards) follows you across sellers, sessions and harnesses; you then sign the " +
      "submission yourself. Omit `key` for session mode: this server keeps an Ed25519 keypair for your MCP session and " +
      "signs for you. Zero setup, but trust resets every session."
    : "Identity: `key` (your base64url Ed25519 public key) is required on this server; session keys are disabled.";

  const noKeyError = () =>
    fail("missing_key", "This server has session keys disabled: pass key (your base64url Ed25519 public key) and sign submissions with sig.");

  // -- d402_offer -------------------------------------------------------------

  server.registerTool(
    "d402_offer",
    {
      title: "d402 offer",
      description:
        "What the paid tools on this server cost and what a bundle earns. Same JSON as GET /.well-known/d402: " +
        "tiers (items to label, calls earned), scope, voucherTtl and a plain-language hint. " + HOW,
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => ok({ ...d402.offer(), how: HOW }),
  );

  // -- d402_get_bundle --------------------------------------------------------

  server.registerTool(
    "d402_get_bundle",
    {
      title: "Get a bundle to label",
      description:
        "Get a bundle of items to label. Returns bundleId, labels, items [{id, text}] and expiresAt (unix seconds). " +
        "Label every item with exactly one label and call d402_submit. Some items are control items with known answers; " +
        "you are not told which, so label all of them honestly. " + modeText,
      inputSchema: {
        tier: z.string().min(1).optional().describe("Tier id from d402_offer. Default: the first tier."),
        key: z.string().min(1).optional().describe("Your base64url Ed25519 public key (key mode). Omit for session mode."),
        model: z.string().min(1).optional().describe("Your model family, e.g. claude, gpt, gemini, llama."),
      },
    },
    async ({ tier, key, model }, extra) => {
      let agentKey: string;
      if (key) agentKey = key;
      else if (sessionKeys) agentKey = session(extra).keypair.publicKey;
      else return noKeyError();
      try {
        const bundle = d402.issueBundle({ key: agentKey, tier, ip: ipOf(extra), model });
        if (!key) session(extra).bundles.add(bundle.bundleId);
        const hint = key
          ? `Label every item, then call d402_submit { bundleId, answers: { <id>: <label> }, key, sig } where sig is your Ed25519 ` +
            `signature over "d402:submit\\n{bundleId}\\n{canonical JSON of answers}" (base64url).`
          : "Label every item, then call d402_submit { bundleId, answers: { <id>: <label> } }. This server signs for your session.";
        return ok({ ...bundle, mode: key ? "key" : "session", hint });
      } catch (err) {
        return failFrom(err);
      }
    },
  );

  // -- d402_submit ------------------------------------------------------------

  server.registerTool(
    "d402_submit",
    {
      title: "Submit bundle answers",
      description:
        "Submit labels for a bundle from d402_get_bundle. On success returns { voucher, calls, scope, expiresAt }: pass " +
        "voucher as d402_voucher to a paid tool. On a quality failure (error code quality) the server does not say which " +
        "items were wrong; get a new bundle. Key mode: pass key and sig (your Ed25519 signature over " +
        '"d402:submit\\n{bundleId}\\n{canonical JSON of answers}", keys sorted, no whitespace). ' +
        "Session mode: omit both; only bundles issued to this session can be submitted.",
      inputSchema: {
        bundleId: z.string().min(1).describe("bundleId from d402_get_bundle."),
        answers: z.record(z.string(), z.string()).describe("Map of item id to one label."),
        sig: z.string().min(1).optional().describe("Key mode: base64url Ed25519 signature over the submit message."),
        key: z.string().min(1).optional().describe("Key mode: the public key the bundle was issued to."),
        model: z.string().min(1).optional().describe("Your model family, e.g. claude, gpt, gemini, llama."),
      },
    },
    async ({ bundleId, answers, sig, key, model }, extra) => {
      try {
        if (key) {
          if (!sig) return fail("bad_request", "sig is required in key mode: sign the submit message with the private key of `key`.");
          const result = await d402.submitBundle({ key, bundleId, answers, sig, model });
          return ok({
            ...result,
            mode: "key",
            hint: `Voucher worth ${result.calls} calls on ${result.scope.join(", ")}. Pass it as d402_voucher to a paid tool.`,
          });
        }
        if (!sessionKeys) return noKeyError();
        const s = sessions.get(sessionIdOf(extra));
        if (!s || !s.bundles.has(bundleId)) {
          return fail(
            "unknown_bundle",
            `Bundle ${bundleId} was not issued to this session. Call d402_get_bundle first, or pass key and sig to submit under your own key.`,
            { status: 404 },
          );
        }
        let result;
        try {
          result = await d402.submitBundle({
            key: s.keypair.publicKey,
            bundleId,
            answers,
            sig: signSubmit(s.keypair.privateKey, bundleId, answers),
            model,
          });
        } catch (err) {
          // These codes mean the bundle is spent either way.
          if (err instanceof TaskError && (err.code === "quality" || err.code === "already_submitted" || err.code === "expired_bundle")) {
            s.bundles.delete(bundleId);
          }
          throw err;
        }
        s.bundles.delete(bundleId);
        const claims = decodeClaims(result.voucher);
        s.lastVoucher = { token: result.voucher, jti: claims?.jti ?? "", calls: result.calls, scope: result.scope, expiresAt: result.expiresAt };
        return ok({
          ...result,
          mode: "session",
          hint: `Voucher worth ${result.calls} calls on ${result.scope.join(", ")}. Pass it as d402_voucher to a paid tool.`,
        });
      } catch (err) {
        return failFrom(err);
      }
    },
  );

  // -- d402_status ------------------------------------------------------------

  server.registerTool(
    "d402_status",
    {
      title: "d402 status",
      description:
        "Calls left on a voucher. Pass voucher to inspect any voucher from this seller; omit it for the last voucher " +
        "earned in this session. Also reports this session's public key (session mode) and pending bundles.",
      inputSchema: {
        voucher: z.string().min(1).optional().describe("A voucher JWT from d402_submit. Default: the session's last voucher."),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ voucher }, extra) => {
      const s = sessionKeys ? session(extra) : sessions.get(sessionIdOf(extra));
      const base: Record<string, unknown> = {
        mode: sessionKeys ? "session" : "key",
        now: now(),
        pendingBundles: s ? [...s.bundles] : [],
      };
      if (s) base.publicKey = s.keypair.publicKey;
      const token = voucher ?? s?.lastVoucher?.token;
      if (!token) return ok({ ...base, voucher: null, hint: `No voucher yet. ${HOW}` });
      const claims = decodeClaims(token);
      if (!claims) return fail("voucher_invalid", "voucher is not a JWT");
      const rec = d402.vouchers.get(claims.jti);
      if (!rec || rec.sub !== claims.sub) return fail("voucher_invalid", "unknown voucher");
      const t = now();
      return ok({
        ...base,
        voucher: {
          jti: rec.jti,
          sub: rec.sub,
          scope: rec.scope,
          callsLeft: rec.callsLeft,
          expiresAt: rec.exp,
          expired: rec.exp <= t,
          token,
        },
      });
    },
  );

  // -- gated ------------------------------------------------------------------

  const SPEND_ARGS = {
    d402_voucher: z.string().min(1).optional().describe("A voucher from d402_submit. Without it this tool returns the d402 offer instead of a result."),
    d402_key: z
      .string()
      .min(1)
      .optional()
      .describe("Bound spending (key mode only): your public key, equal to the voucher's sub. Omit in session mode; the server signs."),
    d402_timestamp: z.number().int().optional().describe("Bound spending (key mode only): unix seconds, within 300s of the server clock."),
    d402_sig: z
      .string()
      .min(1)
      .optional()
      .describe('Bound spending (key mode only): Ed25519 signature over "d402:spend\\nTOOL\\n{scope path}\\n{jti}\\n{timestamp}\\n{nonce}".'),
    d402_nonce: z.string().min(8).max(128).optional().describe("Bound spending (key mode only): 16 random bytes, base64url. Never reuse one."),
  };

  function gated<Args extends ZodRawShapeCompat>(name: string, config: GatedToolConfig<Args>, handler: GatedToolHandler<Args>): void {
    const path = config.scope ?? `/mcp/${name}`;
    const inputSchema = { ...(config.inputSchema ?? {}), ...SPEND_ARGS } as ZodRawShapeCompat;
    const description =
      (config.description ? config.description + " " : "") +
      `Paid: 1 voucher call per invocation (scope ${path}). Pass d402_voucher; without it you get the d402 offer. ${HOW}`;

    const paymentRequired = (error?: Parameters<typeof d402.offer>[0], message?: string): CallToolResult => {
      const offer = d402.offer(error, message);
      const hint = findD402Accept(offer)?.hint ?? "";
      const lead = error ? `Payment required (${error}: ${message}). ` : "Payment required. ";
      const data: Record<string, unknown> = { d402: offer, paymentRequired: true, how: HOW };
      if (error) {
        data.error = error;
        data.message = message;
      }
      return { content: [{ type: "text", text: `${lead}${hint}\n${HOW}` }], structuredContent: data };
    };

    const cb = async (rawArgs: Record<string, unknown>, extra: ToolExtra): Promise<CallToolResult> => {
      const { d402_voucher, d402_key, d402_timestamp, d402_sig, d402_nonce, ...rest } = rawArgs as Record<string, unknown> & {
        d402_voucher?: string;
        d402_key?: string;
        d402_timestamp?: number;
        d402_sig?: string;
        d402_nonce?: string;
      };
      if (!d402_voucher) return paymentRequired();

      let input: SpendInput = { token: d402_voucher, path, method: "TOOL" };
      if (d402_key) {
        input = { ...input, key: d402_key, timestamp: d402_timestamp, sig: d402_sig, nonce: d402_nonce };
      } else {
        // Session mode: a voucher earned by this session's key is bound to it,
        // so the server signs the spend itself (SPEC 7.1 with a 7.2 nonce).
        const s = sessions.get(sessionIdOf(extra));
        const claims = decodeClaims(d402_voucher);
        if (s && claims && claims.sub === s.keypair.publicKey) {
          const timestamp = now();
          const nonce = newNonce();
          input = {
            ...input,
            key: s.keypair.publicKey,
            timestamp,
            nonce,
            sig: signSpend(s.keypair.privateKey, "TOOL", path, claims.jti, timestamp, nonce),
          };
        }
      }

      const r = await d402.spend(input);
      if ("error" in r) return paymentRequired(r.error, r.message);

      const result = await handler(rest as ShapeOutput<Args>, extra);
      return {
        ...result,
        content: [...result.content, { type: "text", text: `calls remaining: ${r.remaining}` }],
        structuredContent: { ...(result.structuredContent ?? {}), d402_calls_remaining: r.remaining },
      };
    };

    const toolConfig: { title?: string; description: string; inputSchema: ZodRawShapeCompat; annotations?: ToolAnnotations } = {
      description,
      inputSchema,
    };
    if (config.title) toolConfig.title = config.title;
    if (config.annotations) toolConfig.annotations = config.annotations;
    server.registerTool(name, toolConfig, cb as never);
  }

  return {
    server,
    gated,
    sessions: {
      get: (id) => {
        const s = sessions.get(id);
        return s ? { publicKey: s.keypair.publicKey } : undefined;
      },
      get size() {
        return sessions.size;
      },
    },
  };
}
