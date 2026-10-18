/** Thrown for protocol-level failures (never for an ordinary non-2xx from a gated route). */
export class D402Error extends Error {
  code: string;
  status: number;
  body?: unknown;

  constructor(
    code: string,
    message: string,
    options: { status?: number; body?: unknown; cause?: unknown } = {},
  ) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "D402Error";
    this.code = code;
    this.status = options.status ?? 0;
    if (options.body !== undefined) this.body = options.body;
  }
}
