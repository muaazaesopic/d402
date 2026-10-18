import { z } from "zod";
import { D402_VERSION, ERROR_CODES, SCHEME } from "./constants.js";

export const TaskType = z.enum(["classify"]);
export type TaskType = z.infer<typeof TaskType>;

export const Tier = z.object({
  id: z.string().min(1),
  items: z.number().int().positive(),
  est_tokens: z.number().int().nonnegative(),
  reward: z.object({ calls: z.number().int().positive() }),
});
export type Tier = z.infer<typeof Tier>;

export const D402Accept = z.object({
  scheme: z.literal(SCHEME),
  sellerId: z.string().min(1),
  taskUrl: z.string().url(),
  taskTypes: z.array(TaskType).min(1),
  scope: z.array(z.string().min(1)).min(1),
  voucherTtl: z.number().int().positive(),
  tiers: z.array(Tier).min(1),
  /** Plain-language instructions for an agent that has never seen d402. Optional. */
  hint: z.string().optional(),
});
export type D402Accept = z.infer<typeof D402Accept>;

/** Any other scheme (for example x402 "exact") is passed through untouched. */
export const OtherAccept = z.object({ scheme: z.string() }).passthrough();

export const Offer = z.object({
  d402: z.literal(D402_VERSION),
  accepts: z.array(z.union([D402Accept, OtherAccept])).min(1),
  error: z.enum(ERROR_CODES).optional(),
  message: z.string().optional(),
});
export type Offer = z.infer<typeof Offer>;

export const ClassifyItem = z.object({ id: z.string().min(1), text: z.string() });
export type ClassifyItem = z.infer<typeof ClassifyItem>;

export const Bundle = z.object({
  bundleId: z.string().min(1),
  tier: z.string().min(1),
  type: TaskType,
  instructions: z.string(),
  labels: z.array(z.string().min(1)).min(2),
  items: z.array(ClassifyItem).min(1),
  expiresAt: z.number().int(),
});
export type Bundle = z.infer<typeof Bundle>;

export const Answers = z.record(z.string(), z.string());
export type Answers = z.infer<typeof Answers>;

export const SubmitBody = z.object({
  answers: Answers,
  model: z.string().optional(),
  sig: z.string().min(1),
});
export type SubmitBody = z.infer<typeof SubmitBody>;

export const SubmitResult = z.object({
  voucher: z.string().min(1),
  calls: z.number().int().positive(),
  scope: z.array(z.string()),
  expiresAt: z.number().int(),
});
export type SubmitResult = z.infer<typeof SubmitResult>;

export const ErrorBody = z.object({
  error: z.enum(ERROR_CODES),
  message: z.string().optional(),
});
export type ErrorBody = z.infer<typeof ErrorBody>;

export const VoucherClaims = z.object({
  iss: z.string(),
  sub: z.string(),
  scope: z.array(z.string()),
  jti: z.string(),
  iat: z.number().int(),
  exp: z.number().int(),
});
export type VoucherClaims = z.infer<typeof VoucherClaims>;

/** One line of a seller task file (JSONL). */
export const TaskFileItem = z.object({
  id: z.string().min(1),
  type: TaskType.default("classify"),
  text: z.string(),
  golden: z.string().optional(),
});
export type TaskFileItem = z.infer<typeof TaskFileItem>;

export function findD402Accept(offer: Offer): D402Accept | undefined {
  for (const a of offer.accepts) {
    const parsed = D402Accept.safeParse(a);
    if (parsed.success) return parsed.data;
  }
  return undefined;
}
