/**
 * Process plumbing shared by the use cases: a port-0 listener whose handler is
 * bound after the port is known (the seller needs its absolute taskUrl before
 * it can build the Hono app), a small logger, and an isMain() check.
 *
 * No package imports here (see gen.ts); the use case passes `serve` from
 * @hono/node-server into listen().
 */
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

/** The node-server passes (request, env) where env is { incoming, outgoing }; keep both. */
export type Handler = (req: Request, env: object) => Response | Promise<Response>;

export interface ServeLike {
  (
    options: { fetch: Handler; port: number; hostname: string },
    onListening: (info: { port: number }) => void,
  ): { close(cb?: (err?: Error) => void): unknown; closeAllConnections?(): void };
}

export interface Listening {
  baseUrl: string;
  port: number;
  /** Swap in the real app once it exists. Requests before that get 503. */
  setHandler(h: Handler): void;
  close(): Promise<void>;
}

/** Listen on 127.0.0.1:0 and resolve with the base URL. */
export function listen(serve: ServeLike): Promise<Listening> {
  let handler: Handler = () => new Response("starting", { status: 503 });
  return new Promise((resolveListening) => {
    const server = serve({ fetch: (req, env) => handler(req, env), port: 0, hostname: "127.0.0.1" }, (info) => {
      resolveListening({
        baseUrl: `http://127.0.0.1:${info.port}`,
        port: info.port,
        setHandler: (h) => {
          handler = h;
        },
        close: () =>
          new Promise<void>((done) => {
            server.closeAllConnections?.();
            server.close(() => done());
          }),
      });
    });
  });
}

export interface Log {
  header(title: string, subtitle?: string): void;
  step(n: number, text: string): void;
  line(text?: string): void;
  result(text: string): void;
}

/** Console logger. `silent` turns it into a no-op (used by the tests). */
export function createLog(silent = false): Log {
  const out = (s: string) => {
    if (!silent) console.log(s);
  };
  return {
    header: (title, subtitle) => {
      out(`=== ${title} ===`);
      if (subtitle) out(subtitle);
      out("");
    },
    step: (n, text) => out(`${n}. ${text}`),
    line: (text = "") => out(text ? `   ${text}` : ""),
    result: (text) => {
      out("");
      out(`RESULT: ${text}`);
    },
  };
}

export function isMain(importMetaUrl: string): boolean {
  try {
    return process.argv[1] !== undefined && fileURLToPath(importMetaUrl) === resolve(process.argv[1]);
  } catch {
    return false;
  }
}

export function ms(start: number): string {
  return `${(performance.now() - start).toFixed(0)} ms`;
}

/** Run a use case as a CLI: print, then exit 0, or print the error and exit 1. */
export function runMain(fn: () => Promise<unknown>): void {
  fn().then(
    () => process.exit(0),
    (err) => {
      console.error(err instanceof Error ? err.stack ?? err.message : String(err));
      process.exit(1);
    },
  );
}
