import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { generateKeypair, isValidPublicKey, type Keypair } from "@d402/spec";
import { D402Error } from "./errors.js";

/**
 * Load an Ed25519 keypair from a JSON file ({ publicKey, privateKey }), or
 * generate one and write it there (mode 0600, parent directories created).
 */
export function loadOrCreateKeypair(path: string): Keypair {
  if (existsSync(path)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(path, "utf8"));
    } catch (err) {
      throw new D402Error("bad_keyfile", `could not parse keypair file ${path}`, { cause: err });
    }
    const kp = parsed as Partial<Keypair> | null;
    if (
      !kp ||
      typeof kp.publicKey !== "string" ||
      typeof kp.privateKey !== "string" ||
      !isValidPublicKey(kp.publicKey)
    ) {
      throw new D402Error("bad_keyfile", `keypair file ${path} is not a valid {publicKey, privateKey}`);
    }
    return { publicKey: kp.publicKey, privateKey: kp.privateKey };
  }
  const kp = generateKeypair();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(kp, null, 2) + "\n", { mode: 0o600 });
  try {
    chmodSync(path, 0o600);
  } catch {
    // best effort (e.g. platforms without POSIX modes)
  }
  return kp;
}
