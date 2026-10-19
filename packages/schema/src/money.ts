import { z } from "zod";

/**
 * Ecash wire formats (Cashu NUT-00 style). Amounts are in credits: 1 credit = 1 µUSD.
 * Each amount (a power of two) has its own mint key, so a signature also fixes its value.
 */
export const Hex = z.string().regex(/^[0-9a-f]+$/);
export const PointHex = z.string().regex(/^0[23][0-9a-f]{64}$/);

export const Amount = z.number().int().positive().refine((n) => (n & (n - 1)) === 0, "power of two");

export const BlindedMessage = z.object({
  amount: z.number().int().nonnegative(), // 0 = blank output; the mint assigns the amount (change)
  B_: PointHex,
  keysetId: z.string().min(1),
});
export type BlindedMessage = z.infer<typeof BlindedMessage>;

export const BlindSignature = z.object({
  amount: Amount,
  C_: PointHex,
  keysetId: z.string().min(1),
});
export type BlindSignature = z.infer<typeof BlindSignature>;

/** A spendable coin. `secret` is hex; the mint marks it spent on first use. */
export const Proof = z.object({
  amount: Amount,
  secret: Hex.length(64),
  C: PointHex,
  keysetId: z.string().min(1),
});
export type Proof = z.infer<typeof Proof>;

export const Keyset = z.object({
  id: z.string().min(1),
  unit: z.literal("credit"),
  keys: z.record(z.string(), PointHex), // amount → public key
});
export type Keyset = z.infer<typeof Keyset>;

/** µUSD per one million tokens, as published by the relay for each model. */
export const ModelPrice = z.object({
  model: z.string().min(1),
  inputPerMTok: z.number().nonnegative(),
  outputPerMTok: z.number().nonnegative(),
});
export type ModelPrice = z.infer<typeof ModelPrice>;
