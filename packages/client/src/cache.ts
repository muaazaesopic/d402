import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface StoredVoucher {
  jti: string;
  sellerId: string;
  token: string;
  scope: string[];
  calls: number;
  expiresAt: number;
  sub: string;
  taskUrl: string;
}

export interface VoucherCache {
  list(): Promise<StoredVoucher[]>;
  /** An unexpired voucher for this seller with calls > 0 whose scope covers `path`. */
  find(sellerId: string, path: string, now: number): Promise<StoredVoucher | undefined>;
  put(v: StoredVoucher): Promise<void>;
  setCalls(jti: string, calls: number): Promise<void>;
  remove(jti: string): Promise<void>;
}

/** True when `path` starts with one of the scope prefixes. */
export function scopeMatches(scope: string[], path: string): boolean {
  return scope.some((prefix) => path.startsWith(prefix));
}

export function isUsable(v: StoredVoucher, sellerId: string, path: string, now: number): boolean {
  return v.sellerId === sellerId && v.calls > 0 && v.expiresAt > now && scopeMatches(v.scope, path);
}

function pickBest(candidates: StoredVoucher[]): StoredVoucher | undefined {
  // Prefer the voucher that expires soonest so nothing goes to waste.
  let best: StoredVoucher | undefined;
  for (const v of candidates) {
    if (!best || v.expiresAt < best.expiresAt) best = v;
  }
  return best;
}

export class MemoryVoucherCache implements VoucherCache {
  private readonly vouchers = new Map<string, StoredVoucher>();

  async list(): Promise<StoredVoucher[]> {
    return [...this.vouchers.values()].map((v) => ({ ...v, scope: [...v.scope] }));
  }

  async find(sellerId: string, path: string, now: number): Promise<StoredVoucher | undefined> {
    const hit = pickBest([...this.vouchers.values()].filter((v) => isUsable(v, sellerId, path, now)));
    return hit ? { ...hit, scope: [...hit.scope] } : undefined;
  }

  async put(v: StoredVoucher): Promise<void> {
    this.vouchers.set(v.jti, { ...v, scope: [...v.scope] });
  }

  async setCalls(jti: string, calls: number): Promise<void> {
    const v = this.vouchers.get(jti);
    if (v) v.calls = calls;
  }

  async remove(jti: string): Promise<void> {
    this.vouchers.delete(jti);
  }
}

interface FileShape {
  version: 1;
  vouchers: StoredVoucher[];
}

/**
 * Vouchers in one JSON file (`<dir>/vouchers.json`). Every write goes to a temp
 * file first and is then renamed over the real one, so readers never see a torn file.
 * The file is re-read on every operation, so several instances (or processes) can share it.
 */
export class FileVoucherCache implements VoucherCache {
  readonly file: string;
  private readonly dir: string;
  private seq = 0;

  constructor(dir: string) {
    this.dir = dir;
    this.file = join(dir, "vouchers.json");
  }

  private read(): StoredVoucher[] {
    let text: string;
    try {
      text = readFileSync(this.file, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
    try {
      const parsed = JSON.parse(text) as Partial<FileShape>;
      if (!parsed || !Array.isArray(parsed.vouchers)) return [];
      return parsed.vouchers.filter((v) => v && typeof v.jti === "string");
    } catch {
      return [];
    }
  }

  private write(vouchers: StoredVoucher[]): void {
    mkdirSync(this.dir, { recursive: true });
    const tmp = join(this.dir, `.vouchers.${process.pid}.${Date.now()}.${this.seq++}.tmp`);
    const data: FileShape = { version: 1, vouchers };
    writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
    renameSync(tmp, this.file);
  }

  async list(): Promise<StoredVoucher[]> {
    return this.read();
  }

  async find(sellerId: string, path: string, now: number): Promise<StoredVoucher | undefined> {
    return pickBest(this.read().filter((v) => isUsable(v, sellerId, path, now)));
  }

  async put(v: StoredVoucher): Promise<void> {
    const vouchers = this.read().filter((x) => x.jti !== v.jti);
    vouchers.push({ ...v, scope: [...v.scope] });
    this.write(vouchers);
  }

  async setCalls(jti: string, calls: number): Promise<void> {
    const vouchers = this.read();
    const v = vouchers.find((x) => x.jti === jti);
    if (!v) return;
    v.calls = calls;
    this.write(vouchers);
  }

  async remove(jti: string): Promise<void> {
    const vouchers = this.read();
    const next = vouchers.filter((x) => x.jti !== jti);
    if (next.length !== vouchers.length) this.write(next);
  }
}
