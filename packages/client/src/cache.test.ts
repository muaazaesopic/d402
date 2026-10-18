import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { isValidPublicKey } from "@d402/spec";
import { FileVoucherCache, MemoryVoucherCache, loadOrCreateKeypair, type StoredVoucher, type VoucherCache } from "./index.js";

const voucher = (over: Partial<StoredVoucher> = {}): StoredVoucher => ({
  jti: "v_1",
  sellerId: "api.test",
  token: "h.p.s",
  scope: ["/search"],
  calls: 3,
  expiresAt: 2000,
  sub: "key",
  taskUrl: "https://api.test/.well-known/d402/tasks",
  ...over,
});

const tmpDirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "d402-client-"));
  tmpDirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function cacheContract(name: string, make: () => VoucherCache) {
  describe(name, () => {
    it("put/list/find/setCalls/remove", async () => {
      const c = make();
      expect(await c.list()).toEqual([]);
      await c.put(voucher());
      await c.put(voucher({ jti: "v_2", sellerId: "other" }));
      expect((await c.list()).map((v) => v.jti).sort()).toEqual(["v_1", "v_2"]);

      expect((await c.find("api.test", "/search", 1000))?.jti).toBe("v_1");
      expect((await c.find("api.test", "/search/deep?x", 1000))?.jti).toBe("v_1");
      expect(await c.find("api.test", "/admin", 1000)).toBeUndefined(); // scope
      expect(await c.find("api.test", "/search", 2000)).toBeUndefined(); // expired (>= expiresAt)
      expect(await c.find("nobody", "/search", 1000)).toBeUndefined(); // seller

      await c.setCalls("v_1", 0);
      expect(await c.find("api.test", "/search", 1000)).toBeUndefined(); // no calls
      await c.setCalls("v_1", 2);
      expect((await c.find("api.test", "/search", 1000))?.calls).toBe(2);
      await c.setCalls("missing", 9); // no-op

      await c.remove("v_1");
      expect((await c.list()).map((v) => v.jti)).toEqual(["v_2"]);
      await c.remove("v_1"); // idempotent
    });

    it("put replaces a voucher with the same jti", async () => {
      const c = make();
      await c.put(voucher({ calls: 1 }));
      await c.put(voucher({ calls: 7 }));
      const all = await c.list();
      expect(all).toHaveLength(1);
      expect(all[0]!.calls).toBe(7);
    });

    it("prefers the voucher that expires soonest", async () => {
      const c = make();
      await c.put(voucher({ jti: "late", expiresAt: 5000 }));
      await c.put(voucher({ jti: "soon", expiresAt: 3000 }));
      expect((await c.find("api.test", "/search", 1000))?.jti).toBe("soon");
    });
  });
}

cacheContract("MemoryVoucherCache", () => new MemoryVoucherCache());
cacheContract("FileVoucherCache", () => new FileVoucherCache(tmp()));

describe("FileVoucherCache", () => {
  it("persists across instances and creates the directory", async () => {
    const dir = join(tmp(), "nested", "cache");
    const a = new FileVoucherCache(dir);
    await a.put(voucher());
    await a.setCalls("v_1", 2);
    const b = new FileVoucherCache(dir);
    expect(await b.list()).toEqual([voucher({ calls: 2 })]);
    await b.remove("v_1");
    expect(await a.list()).toEqual([]);
  });

  it("writes atomically (temp file + rename) and leaves no temp files behind", async () => {
    const dir = tmp();
    const c = new FileVoucherCache(dir);
    await c.put(voucher());
    await c.put(voucher({ jti: "v_2" }));
    const files = readdirSync(dir);
    expect(files).toEqual(["vouchers.json"]);
    const parsed = JSON.parse(readFileSync(join(dir, "vouchers.json"), "utf8"));
    expect(parsed.vouchers).toHaveLength(2);
    expect(statSync(join(dir, "vouchers.json")).mode & 0o777).toBe(0o600);
  });

  it("treats a corrupt file as empty", async () => {
    const dir = tmp();
    writeFileSync(join(dir, "vouchers.json"), "{not json");
    const c = new FileVoucherCache(dir);
    expect(await c.list()).toEqual([]);
    await c.put(voucher());
    expect(await c.list()).toHaveLength(1);
  });
});

describe("loadOrCreateKeypair", () => {
  it("creates a keypair file with mode 0600 and reloads the same key", () => {
    const path = join(tmp(), "deep", "dir", "agent.json");
    const kp = loadOrCreateKeypair(path);
    expect(isValidPublicKey(kp.publicKey)).toBe(true);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(kp);
    const again = loadOrCreateKeypair(path);
    expect(again).toEqual(kp);
  });

  it("rejects a malformed key file", () => {
    const path = join(tmp(), "bad.json");
    writeFileSync(path, JSON.stringify({ publicKey: "nope" }));
    expect(() => loadOrCreateKeypair(path)).toThrowError(expect.objectContaining({ code: "bad_keyfile" }));
  });
});
