export const D402_VERSION = "1" as const;
export const SCHEME = "d402" as const;

export const HEADERS = {
  key: "D402-Key",
  voucher: "D402-Voucher",
  model: "D402-Model",
  timestamp: "D402-Timestamp",
  sig: "D402-Sig",
  callsRemaining: "D402-Calls-Remaining",
} as const;

export const WELL_KNOWN_PATH = "/.well-known/d402" as const;
export const WELL_KNOWN_TASKS_PATH = "/.well-known/d402/tasks" as const;

export const ERROR_CODES = [
  "bad_tier",
  "no_tasks",
  "rate_limited",
  "blocked",
  "missing_key",
  "bad_key",
  "unknown_bundle",
  "expired_bundle",
  "bad_signature",
  "already_submitted",
  "incomplete",
  "bad_label",
  "quality",
  "voucher_invalid",
  "voucher_expired",
  "voucher_exhausted",
  "scope_mismatch",
  "stale_timestamp",
  "missing_voucher",
  "bad_request",
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

export const DEFAULTS = {
  voucherTtl: 86_400,
  bundleTtl: 600,
  goldenMaxExposures: 200,
  bundlesPerKeyPerHour: 60,
  bundlesPerIpPerHour: 120,
  maxOpenBundlesPerKey: 5,
  resolveWeight: 2.0,
  resolveMinKeys: 2,
  blockAccuracyFloor: 0.6,
  blockMinBundles: 5,
  spendTimestampSkew: 300,
  passRatio: 0.8,
} as const;

export const SIGN_PREFIX = {
  submit: "d402:submit",
  spend: "d402:spend",
} as const;
