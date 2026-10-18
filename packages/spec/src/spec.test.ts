import { describe, expect, it } from "vitest";
import {
  Bundle,
  Offer,
  canonicalJSON,
  findD402Accept,
  generateKeypair,
  isValidPublicKey,
  newNonce,
  signSpend,
  signSubmit,
  verifySpend,
  verifySubmit,
} from "./index.js";

describe("canonicalJSON", () => {
  it("sorts keys recursively and strips whitespace", () => {
    expect(canonicalJSON({ b: 1, a: { d: 2, c: [3, { f: 1, e: 2 }] } })).toBe(
      '{"a":{"c":[3,{"e":2,"f":1}],"d":2},"b":1}',
    );
  });
});

describe("keys and signatures", () => {
  it("generates a 32-byte key and round-trips a submit signature", () => {
    const kp = generateKeypair();
    expect(isValidPublicKey(kp.publicKey)).toBe(true);
    const answers = { i_2: "b", i_1: "a" };
    const sig = signSubmit(kp.privateKey, "b_1", answers);
    expect(verifySubmit(kp.publicKey, "b_1", { i_1: "a", i_2: "b" }, sig)).toBe(true);
    expect(verifySubmit(kp.publicKey, "b_1", { i_1: "a", i_2: "c" }, sig)).toBe(false);
    expect(verifySubmit(kp.publicKey, "b_2", answers, sig)).toBe(false);
    const other = generateKeypair();
    expect(verifySubmit(other.publicKey, "b_1", answers, sig)).toBe(false);
  });

  it("rejects malformed public keys", () => {
    expect(isValidPublicKey("")).toBe(false);
    expect(isValidPublicKey("abc")).toBe(false);
    expect(isValidPublicKey(Buffer.alloc(31).toString("base64url"))).toBe(false);
  });

  it("round-trips a spend signature with a nonce and keeps the 5-line form without one", () => {
    const kp = generateKeypair();
    const n = newNonce();
    expect(n).toHaveLength(22);
    const sig = signSpend(kp.privateKey, "GET", "/search", "v_1", 1700000000, n);
    expect(verifySpend(kp.publicKey, "GET", "/search", "v_1", 1700000000, sig, n)).toBe(true);
    expect(verifySpend(kp.publicKey, "GET", "/search", "v_1", 1700000000, sig)).toBe(false);
    expect(verifySpend(kp.publicKey, "GET", "/search", "v_1", 1700000000, sig, newNonce())).toBe(false);
    const plain = signSpend(kp.privateKey, "GET", "/search", "v_1", 1700000000);
    expect(verifySpend(kp.publicKey, "GET", "/search", "v_1", 1700000000, plain)).toBe(true);
    expect(verifySpend(kp.publicKey, "GET", "/search", "v_1", 1700000000, plain, n)).toBe(false);
  });

  it("round-trips a spend signature", () => {
    const kp = generateKeypair();
    const sig = signSpend(kp.privateKey, "get", "/search", "v_1", 1700000000);
    expect(verifySpend(kp.publicKey, "GET", "/search", "v_1", 1700000000, sig)).toBe(true);
    expect(verifySpend(kp.publicKey, "GET", "/search", "v_1", 1700000001, sig)).toBe(false);
    expect(verifySpend(kp.publicKey, "GET", "/other", "v_1", 1700000000, sig)).toBe(false);
  });
});

describe("schemas", () => {
  const offer = {
    d402: "1",
    accepts: [
      { scheme: "exact", network: "base", amount: "7000" },
      {
        scheme: "d402",
        sellerId: "api.example.com",
        taskUrl: "https://api.example.com/.well-known/d402/tasks",
        taskTypes: ["classify"],
        scope: ["/search"],
        voucherTtl: 86400,
        tiers: [{ id: "s", items: 5, est_tokens: 1000, reward: { calls: 10 } }],
      },
    ],
  };

  it("parses an offer with mixed schemes and finds the d402 accept", () => {
    const parsed = Offer.parse(offer);
    const d = findD402Accept(parsed);
    expect(d?.sellerId).toBe("api.example.com");
    expect(d?.tiers[0]?.reward.calls).toBe(10);
  });

  it("rejects a bundle with fewer than 2 labels", () => {
    const r = Bundle.safeParse({
      bundleId: "b", tier: "s", type: "classify", instructions: "x",
      labels: ["only"], items: [{ id: "i", text: "t" }], expiresAt: 1,
    });
    expect(r.success).toBe(false);
  });
});
