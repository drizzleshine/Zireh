import type { ModelPrice } from "@zireh/schema";
import { describe, expect, it } from "vitest";
import {
  actualCost,
  blankOutputCount,
  checkBill,
  generateMintKeys,
  InsufficientFunds,
  maxCost,
  memoryProofStore,
  memorySpentStore,
  Mint,
  MintError,
  prepareChange,
  prepareTopup,
  splitAmount,
  sum,
  unblindAll,
  Wallet,
} from "../src/index.ts";

const newMint = () => new Mint(generateMintKeys(), memorySpentStore());

function fundedWallet(mint: Mint, credits: number) {
  const pending = prepareTopup(mint.keyset, credits);
  const wallet = new Wallet(memoryProofStore());
  wallet.add(unblindAll(mint.keyset, pending, mint.issue(pending.outputs, credits)));
  return wallet;
}

describe("amounts", () => {
  it("splits into powers of two", () => {
    expect(splitAmount(13)).toEqual([8, 4, 1]);
    expect(splitAmount(0)).toEqual([]);
    expect(sum(splitAmount(123_456_789).map((amount) => ({ amount })))).toBe(123_456_789);
  });

  it("sizes blank outputs to carry any change up to the max", () => {
    expect(blankOutputCount(0)).toBe(0);
    expect(blankOutputCount(1)).toBe(1);
    expect(blankOutputCount(255)).toBe(8);
    expect(blankOutputCount(256)).toBe(9);
  });
});

describe("top-up → spend → change", () => {
  it("pays the max, gets exact change back, and ends with balance − actual", () => {
    const mint = newMint();
    const wallet = fundedWallet(mint, 10_000);
    expect(wallet.balance).toBe(10_000);

    const hold = 700;
    const proofs = wallet.take(hold);
    const paid = sum(proofs);
    expect(paid).toBeGreaterThanOrEqual(hold);
    const blanks = prepareChange(mint.keyset, paid);

    const received = mint.redeem(proofs);
    const actual = 137;
    const change = unblindAll(mint.keyset, blanks, mint.change(blanks.outputs, received - actual));
    wallet.add(change);

    expect(wallet.balance).toBe(10_000 - actual);
  });

  it("change coins are themselves spendable", () => {
    const mint = newMint();
    const wallet = fundedWallet(mint, 64);
    const proofs = wallet.take(64);
    const blanks = prepareChange(mint.keyset, 64);
    wallet.add(unblindAll(mint.keyset, blanks, mint.change(blanks.outputs, mint.redeem(proofs) - 10)));
    expect(mint.redeem(wallet.take(54))).toBe(54);
  });
});

describe("mint safety", () => {
  it("rejects double spends, all-or-nothing", () => {
    const mint = newMint();
    const wallet = fundedWallet(mint, 3);
    const [a, b] = wallet.take(3);
    mint.redeem([a!]);
    expect(() => mint.redeem([b!, a!])).toThrow(MintError);
    expect(mint.redeem([b!])).toBe(b!.amount); // b was not burned by the failed attempt
  });

  it("rejects forged coins and coins from another mint", () => {
    const mint = newMint();
    const other = newMint();
    const [coin] = fundedWallet(other, 1).take(1);
    expect(() => mint.redeem([{ ...coin!, keysetId: mint.keyset.id }])).toThrow(/verification/);
    expect(() => mint.redeem([coin!])).toThrow(/unknown keyset/);
  });

  it("issues only exactly the paid amount", () => {
    const mint = newMint();
    const pending = prepareTopup(mint.keyset, 100);
    expect(() => mint.issue(pending.outputs, 99)).toThrow(/expected 99/);
  });
});

describe("wallet selection", () => {
  it("takes coins and removes them from the store first", () => {
    const wallet = fundedWallet(newMint(), 15); // 8 + 4 + 2 + 1
    const taken = wallet.take(5);
    expect(sum(taken)).toBeGreaterThanOrEqual(5);
    expect(wallet.balance).toBe(15 - sum(taken));
    expect(() => wallet.take(100)).toThrow(InsufficientFunds);
  });
});

describe("pricing and bill check", () => {
  const price: ModelPrice = { model: "m", inputPerMTok: 300_000, outputPerMTok: 900_000 }; // $0.30 / $0.90
  const messages = [{ role: "user" as const, content: "x".repeat(400) }];

  it("max cost bounds actual cost for honest usage", () => {
    const hold = maxCost(price, messages, 500);
    const real = actualCost(price, { prompt_tokens: 110, completion_tokens: 500 });
    expect(hold).toBeGreaterThanOrEqual(real);
  });

  it("flags overcharges and inflated usage", () => {
    const usage = { prompt_tokens: 100, completion_tokens: 20 };
    const fair = actualCost(price, usage);
    expect(checkBill(price, messages, "y".repeat(60), usage, fair).overcharged).toBe(false);
    expect(checkBill(price, messages, "y".repeat(60), usage, fair + 5).overcharged).toBe(true);
    expect(checkBill(price, messages, "y".repeat(60), { prompt_tokens: 5000, completion_tokens: 20 }, fair).reason).toMatch(/input/);
    expect(checkBill(price, messages, "short", { prompt_tokens: 100, completion_tokens: 900 }, fair).reason).toMatch(/output/);
  });

  it("accepts hidden reasoning tokens up to the cap, and no further", () => {
    const usage = { prompt_tokens: 100, completion_tokens: 420, reasoning_tokens: 400 };
    const fair = actualCost(price, usage);
    expect(checkBill(price, messages, "y".repeat(20), usage, fair, 500).overcharged).toBe(false);
    expect(checkBill(price, messages, "y".repeat(20), usage, fair, 300).reason).toMatch(/cap/);
  });
});
