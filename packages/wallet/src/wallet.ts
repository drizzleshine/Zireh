import { blind, bytesToHex, hexToBytes, randomBytes, unblind } from "@zireh/crypto";
import type { BlindedMessage, BlindSignature, Keyset, Proof } from "@zireh/schema";
import { blankOutputCount, splitAmount, sum } from "./amounts.ts";

/** Secrets and blinding factors kept on the device until the mint's signatures come back. */
export interface PendingOutputs {
  readonly outputs: BlindedMessage[];
  readonly secrets: readonly { secret: string; r: string }[];
}

/** Coins at rest. Implementations: memory (tests), file (daemon). */
export interface ProofStore {
  load(): Proof[];
  save(proofs: readonly Proof[]): void;
}

export function memoryProofStore(initial: readonly Proof[] = []): ProofStore {
  let proofs = [...initial];
  return {
    load: () => [...proofs],
    save: (next) => {
      proofs = [...next];
    },
  };
}

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
  constructor(private readonly store: ProofStore) {}

  get balance(): number {
    return sum(this.store.load());
  }

  add(proofs: readonly Proof[]): void {
    this.store.save([...this.store.load(), ...proofs]);
  }

  /** Take coins covering at least `amount`: largest first, then trim coins that aren't needed. */
  take(amount: number): Proof[] {
    const all = this.store.load().sort((a, b) => b.amount - a.amount);
    if (sum(all) < amount) throw new InsufficientFunds(amount, sum(all));
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
    this.store.save(all.filter((p) => !taken.has(p.secret)));
    return chosen;
  }
}
