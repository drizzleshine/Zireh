import { blind, bytesToHex, hexToBytes, randomBytes, unblind } from "@zireh/crypto";
import type { BlindedMessage, BlindSignature, Keyset, Proof } from "@zireh/schema";
import { blankOutputCount, splitAmount, sum } from "./amounts.ts";

/** Secrets and blinding factors kept on the device until the mint's signatures come back. */
export interface PendingOutputs {
  readonly outputs: BlindedMessage[];
  readonly secrets: readonly { secret: string; r: string }[];
}

export type { MoneyStore as ProofStore } from "./store.ts";
export { memoryMoneyStore as memoryProofStore } from "./store.ts";
import type { MoneyStore } from "./store.ts";

export class InsufficientFunds extends Error {
  constructor(
    readonly needed: number,
    readonly available: number,
  ) {
    super(`need ${needed} credits, have ${available}`);
    this.name = "InsufficientFunds";
  }
}

/** Blinded outputs for the given amounts (0 = blank output for change). */
export function prepareOutputs(keyset: Keyset, amounts: readonly number[]): PendingOutputs {
  const secrets = amounts.map(() => {
    const secret = bytesToHex(randomBytes(32));
    return { secret, r: blind(hexToBytes(secret)).r };
  });
  const outputs = amounts.map((amount, i) => ({
    amount,
    keysetId: keyset.id,
    B_: blind(hexToBytes(secrets[i]!.secret), secrets[i]!.r).B_,
  }));
  return { outputs, secrets };
}

export const prepareTopup = (keyset: Keyset, credits: number): PendingOutputs => prepareOutputs(keyset, splitAmount(credits));

export const prepareChange = (keyset: Keyset, maxChange: number): PendingOutputs =>
  prepareOutputs(keyset, Array.from({ length: blankOutputCount(maxChange) }, () => 0));

/** Turn the mint's signatures into spendable coins. Signature i belongs to output i. */
export function unblindAll(keyset: Keyset, pending: PendingOutputs, signatures: readonly BlindSignature[]): Proof[] {
  return signatures.map((sig, i) => {
    const s = pending.secrets[i];
    if (!s) throw new Error("more signatures than outputs");
    const K = keyset.keys[String(sig.amount)];
    if (!K) throw new Error(`no public key for amount ${sig.amount}`);
    return { amount: sig.amount, keysetId: sig.keysetId, secret: s.secret, C: unblind(sig.C_, s.r, K) };
  });
}

/**
 * Client wallet. Coins are removed from the store *before* they are sent, so a crash never
 * leads to sending the same coin twice; change is added when the settlement arrives.
 */
export class Wallet {
  constructor(readonly money: MoneyStore) {}

  get balance(): number {
    return sum(this.money.load());
  }

  /** Add coins; a coin already held (same secret) is ignored. */
  add(proofs: readonly Proof[]): void {
    const held = this.money.load();
    const seen = new Set(held.map((p) => p.secret));
    const fresh = proofs.filter((p) => !seen.has(p.secret) && seen.add(p.secret));
    this.money.save([...held, ...fresh]);
  }

  /** Take coins covering at least `amount`: largest first, then trim coins that aren't needed. */
  take(amount: number): Proof[] {
    const all = this.money.load().sort((a, b) => b.amount - a.amount);
    if (sum(all) < amount) throw new InsufficientFunds(amount, sum(all));
    // Prefer an exact subset. With binary denominations, descending exact selection is
    // complete; it preserves the independent holds made by a whole-plan swap.
    const exact: Proof[] = [];
    let remaining = amount;
    for (const proof of all) if (proof.amount <= remaining) { exact.push(proof); remaining -= proof.amount; }
    if (remaining === 0) {
      const taken = new Set(exact.map((p) => p.secret));
      this.money.save(all.filter((p) => !taken.has(p.secret)));
      return exact;
    }
    const chosen: Proof[] = [];
    let total = 0;
    for (const p of all) {
      if (total >= amount) break;
      chosen.push(p);
      total += p.amount;
    }
    // Drop the largest picks if the smaller ones alone still cover the amount.
    while (chosen.length > 1 && total - chosen[0]!.amount >= amount) total -= chosen.shift()!.amount;
    const taken = new Set(chosen.map((p) => p.secret));
    this.money.save(all.filter((p) => !taken.has(p.secret)));
    return chosen;
  }
}
