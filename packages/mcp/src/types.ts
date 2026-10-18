import type { Bundle, D402Accept, Keypair, Offer, Answers } from "@d402/spec";

/**
 * Structural mirror of the `@d402/client` API this package relies on.
 *
 * `createMcpServer` is typed against these shapes rather than the client's own
 * exports so the server stays testable with a hand-written fake and does not
 * need the client package at type-check time. The real `D402Client` from
 * `@d402/client` satisfies `D402ClientLike`.
 */
export interface StoredVoucherLike {
  jti: string;
  sellerId: string;
  token: string;
  scope: string[];
  calls: number;
  expiresAt: number;
  sub: string;
  taskUrl: string;
}

export type SolverLike = (bundle: Bundle) => Promise<Answers>;

export interface D402ClientLike {
  keypair: Keypair;
  fetch: typeof fetch;
  discover(baseUrlOrOfferUrl: string): Promise<Offer>;
  getBundle(taskUrl: string, tier: string): Promise<Bundle>;
  submit(taskUrl: string, bundle: Bundle, answers: Answers, accept?: D402Accept): Promise<StoredVoucherLike>;
  earn(accept: D402Accept, tier?: string): Promise<StoredVoucherLike>;
  status(): Promise<StoredVoucherLike[]>;
}

/** Shape of `D402Error` from `@d402/client`, matched structurally. */
export interface D402ErrorLike extends Error {
  code: string;
  status: number;
  body?: unknown;
}

export function isD402ErrorLike(err: unknown): err is D402ErrorLike {
  return (
    typeof err === "object" &&
    err !== null &&
    typeof (err as { code?: unknown }).code === "string" &&
    typeof (err as { status?: unknown }).status === "number"
  );
}
