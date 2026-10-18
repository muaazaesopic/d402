import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign as nodeSign,
  verify as nodeVerify,
  type KeyObject,
} from "node:crypto";
import { canonicalJSON } from "./canonical.js";
import { SIGN_PREFIX } from "./constants.js";

export interface Keypair {
  /** base64url of the 32 raw public key bytes. This is the agent's identity. */
  publicKey: string;
  /** base64url of the 32 raw private key seed bytes. */
  privateKey: string;
}

// Ed25519 DER prefixes (SPKI for public, PKCS8 for private)
const SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

export function b64u(buf: Uint8Array | Buffer): string {
  return Buffer.from(buf).toString("base64url");
}
export function fromB64u(s: string): Buffer {
  return Buffer.from(s, "base64url");
}

export function generateKeypair(): Keypair {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const spki = publicKey.export({ type: "spki", format: "der" }) as Buffer;
  const pkcs8 = privateKey.export({ type: "pkcs8", format: "der" }) as Buffer;
  return {
    publicKey: b64u(spki.subarray(SPKI_PREFIX.length)),
    privateKey: b64u(pkcs8.subarray(PKCS8_PREFIX.length)),
  };
}

export function isValidPublicKey(publicKey: string): boolean {
  try {
    const raw = fromB64u(publicKey);
    if (raw.length !== 32) return false;
    toPublicKeyObject(publicKey);
    return true;
  } catch {
    return false;
  }
}

function toPublicKeyObject(publicKey: string): KeyObject {
  const raw = fromB64u(publicKey);
  if (raw.length !== 32) throw new Error("public key must be 32 bytes");
  return createPublicKey({ key: Buffer.concat([SPKI_PREFIX, raw]), type: "spki", format: "der" });
}

function toPrivateKeyObject(privateKey: string): KeyObject {
  const raw = fromB64u(privateKey);
  if (raw.length !== 32) throw new Error("private key must be 32 bytes");
  return createPrivateKey({ key: Buffer.concat([PKCS8_PREFIX, raw]), type: "pkcs8", format: "der" });
}

export function signBytes(privateKey: string, message: Uint8Array | string): string {
  const msg = typeof message === "string" ? Buffer.from(message, "utf8") : Buffer.from(message);
  return b64u(nodeSign(null, msg, toPrivateKeyObject(privateKey)));
}

export function verifyBytes(publicKey: string, message: Uint8Array | string, sig: string): boolean {
  try {
    const msg = typeof message === "string" ? Buffer.from(message, "utf8") : Buffer.from(message);
    return nodeVerify(null, msg, toPublicKeyObject(publicKey), fromB64u(sig));
  } catch {
    return false;
  }
}

/** Message the agent signs when submitting a bundle. */
export function submitMessage(bundleId: string, answers: Record<string, string>): string {
  return `${SIGN_PREFIX.submit}\n${bundleId}\n${canonicalJSON(answers)}`;
}

export function signSubmit(privateKey: string, bundleId: string, answers: Record<string, string>): string {
  return signBytes(privateKey, submitMessage(bundleId, answers));
}

export function verifySubmit(
  publicKey: string,
  bundleId: string,
  answers: Record<string, string>,
  sig: string,
): boolean {
  return verifyBytes(publicKey, submitMessage(bundleId, answers), sig);
}

/** Message the agent signs on a bound spend (section 7.1). */
export function spendMessage(method: string, path: string, jti: string, timestamp: number): string {
  return `${SIGN_PREFIX.spend}\n${method.toUpperCase()}\n${path}\n${jti}\n${timestamp}`;
}

export function signSpend(privateKey: string, method: string, path: string, jti: string, timestamp: number): string {
  return signBytes(privateKey, spendMessage(method, path, jti, timestamp));
}

export function verifySpend(
  publicKey: string,
  method: string,
  path: string,
  jti: string,
  timestamp: number,
  sig: string,
): boolean {
  return verifyBytes(publicKey, spendMessage(method, path, jti, timestamp), sig);
}
