import { bytesToHex } from "./bytes.ts";

export const randomBytes = (length: number): Uint8Array => crypto.getRandomValues(new Uint8Array(length));

/** 128-bit random id, hex. Unguessable and safe to use as an opaque identifier. */
export const randomId = (): string => bytesToHex(randomBytes(16));

/** 256-bit random salt, hex. Used to make per-case prompt prefixes unprobeable. */
export const randomSalt = (): string => bytesToHex(randomBytes(32));

/** Uniform integer in [0, max). */
export function randomInt(max: number): number {
  if (!Number.isInteger(max) || max <= 0) throw new RangeError("max must be a positive integer");
  const limit = Math.floor(0x1_0000_0000 / max) * max;
  for (;;) {
    const [n] = crypto.getRandomValues(new Uint32Array(1));
    if (n! < limit) return n! % max;
  }
}

/** Fisher–Yates shuffle with a cryptographic RNG; returns a new array. */
export function shuffle<T>(items: readonly T[]): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}
