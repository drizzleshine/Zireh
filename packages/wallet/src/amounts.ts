/** Coin denominations: powers of two from 1 to 2^MAX_EXP credits (1 credit = 1 µUSD). */
export const MAX_EXP = 24; // largest coin ≈ $16.78
export const DENOMINATIONS: readonly number[] = Array.from({ length: MAX_EXP + 1 }, (_, i) => 2 ** i);

/** Binary decomposition: 13 → [8, 4, 1]. Larger amounts repeat the top coin. */
export function splitAmount(total: number): number[] {
  if (!Number.isInteger(total) || total < 0) throw new RangeError("amount must be a non-negative integer");
  const out: number[] = [];
  const top = 2 ** MAX_EXP;
  let rest = total;
  while (rest >= top * 2) {
    out.push(top);
    rest -= top;
  }
  for (let i = MAX_EXP; i >= 0 && rest > 0; i--) {
    const d = 2 ** i;
    if (rest >= d) {
      out.push(d);
      rest -= d;
    }
  }
  return out;
}

/** Number of blank outputs that can carry any change up to `maxChange`. */
export const blankOutputCount = (maxChange: number): number =>
  maxChange <= 0 ? 0 : Math.max(1, Math.ceil(Math.log2(maxChange + 1)));

export const sum = (xs: readonly { amount: number }[]): number => xs.reduce((n, x) => n + x.amount, 0);
