import { DEFAULTS } from "@d402/spec";

/** The per-key counters SPEC 5.2 is computed from. */
export interface TrustCounters {
  goldenSeen: number;
  goldenCorrect: number;
  bundles: number;
}

/** Laplace-smoothed accuracy estimate (SPEC 5.2). */
export function accuracy(a: TrustCounters): number {
  return (a.goldenCorrect + 1) / (a.goldenSeen + 2);
}

/** Golden ratio for the agent's next bundle (SPEC 5.2). */
export function goldenRatio(a: TrustCounters): number {
  if (a.bundles < 5) return 0.4;
  const acc = accuracy(a);
  if (a.bundles >= 50 && acc >= 0.95) return 0.1;
  if (a.bundles >= 10 && acc >= 0.9) return 0.2;
  return 0.4;
}

/** Golden count per bundle: max(1, round(items * ratio)). */
export function goldenCount(items: number, a: TrustCounters): number {
  return Math.max(1, Math.round(items * goldenRatio(a)));
}

/** A key with bundles >= 5 and accuracy < 0.6 is blocked (SPEC 5.2). */
export function isBlocked(a: TrustCounters): boolean {
  return a.bundles >= DEFAULTS.blockMinBundles && accuracy(a) < DEFAULTS.blockAccuracyFloor;
}

/** Grading rule (SPEC 5.1). */
export function passes(golden: number, correct: number): boolean {
  if (golden <= 0) return false;
  if (golden === 1) return correct === 1;
  return correct / golden >= DEFAULTS.passRatio;
}
