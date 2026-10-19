import { generateMintKeypair, hexToBytes, sha256Hex, signBlinded, verifyToken, type MintKeypair } from "@zireh/crypto";
import type { BlindedMessage, BlindSignature, Keyset, Proof } from "@zireh/schema";
import { DENOMINATIONS, splitAmount, sum } from "./amounts.ts";

/** Relay side. Private keys per denomination; a spent-secret set prevents double spends. */
export interface MintKeys {
  readonly id: string;
  readonly pairs: Readonly<Record<string, MintKeypair>>; // amount → keypair
}

export function generateMintKeys(): MintKeys {
  const pairs: Record<string, MintKeypair> = {};
  for (const d of DENOMINATIONS) pairs[String(d)] = generateMintKeypair();
  return { id: keysetIdOf(pairs), pairs };
}

const keysetIdOf = (pairs: Readonly<Record<string, MintKeypair>>): string =>
  `zp${sha256Hex(DENOMINATIONS.map((d) => pairs[String(d)]!.publicKey).join("")).slice(0, 14)}`;

export const publicKeyset = (keys: MintKeys): Keyset => ({
  id: keys.id,
  unit: "credit",
  keys: Object.fromEntries(Object.entries(keys.pairs).map(([a, p]) => [a, p.publicKey])),
});

/** Spent secrets must be stored durably and checked atomically by the relay. */
export interface SpentStore {
  /** Marks all secrets spent; returns false (and marks nothing) if any was already spent. */
  markSpent(secrets: readonly string[]): boolean;
}

export function memorySpentStore(): SpentStore {
  const spent = new Set<string>();
  return {
    markSpent(secrets) {
      if (secrets.some((s) => spent.has(s)) || new Set(secrets).size !== secrets.length) return false;
      for (const s of secrets) spent.add(s);
      return true;
    },
  };
}

export class MintError extends Error {
  constructor(
    readonly code: "token_invalid" | "token_spent" | "bad_request",
    message: string,
  ) {
    super(message);
    this.name = "MintError";
  }
}

export class Mint {
  constructor(
    private readonly keys: MintKeys,
    private readonly spent: SpentStore,
  ) {}

  get keyset(): Keyset {
    return publicKeyset(this.keys);
  }

  private pair(amount: number, keysetId: string): MintKeypair {
    if (keysetId !== this.keys.id) throw new MintError("bad_request", "unknown keyset");
    const pair = this.keys.pairs[String(amount)];
    if (!pair) throw new MintError("bad_request", `no key for amount ${amount}`);
    return pair;
  }

  /** Issue coins for a paid top-up. The outputs must add up to exactly `credits`. */
  issue(outputs: readonly BlindedMessage[], credits: number): BlindSignature[] {
    if (sum(outputs) !== credits) throw new MintError("bad_request", `outputs total ${sum(outputs)}, expected ${credits}`);
    return outputs.map((o) => ({ amount: o.amount, keysetId: o.keysetId, C_: signBlinded(this.pair(o.amount, o.keysetId).privateKey, o.B_) }));
  }

  /** Verify and burn coins. Returns their total. All-or-nothing. */
  redeem(proofs: readonly Proof[]): number {
    for (const p of proofs) {
      if (!verifyToken(this.pair(p.amount, p.keysetId).privateKey, hexToBytes(p.secret), p.C)) {
        throw new MintError("token_invalid", "a coin failed verification");
      }
    }
    if (!this.spent.markSpent(proofs.map((p) => p.secret))) throw new MintError("token_spent", "a coin was already spent");
    return sum(proofs);
  }

  /** Fill blank outputs with `change` (binary decomposition). Unused blanks stay unsigned. */
  change(blanks: readonly BlindedMessage[], change: number): BlindSignature[] {
    const amounts = splitAmount(change);
    if (amounts.length > blanks.length) throw new MintError("bad_request", "not enough blank outputs for change");
    return amounts.map((amount, i) => {
      const blank = blanks[i]!;
      return { amount, keysetId: blank.keysetId, C_: signBlinded(this.pair(amount, blank.keysetId).privateKey, blank.B_) };
    });
  }
}
