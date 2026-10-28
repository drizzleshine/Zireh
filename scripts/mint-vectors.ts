/**
 * Writes host/tests/fixtures/mint-vectors.json: what the TypeScript wallet and relay compute for
 * fixed inputs. The Rust mint must reproduce every value, because browsers keep using the TS code.
 *   pnpm exec tsx scripts/mint-vectors.ts
 */
import { writeFileSync } from "node:fs";
import { blind, bytesToHex, canonicalJson, hashToCurve, hexToBytes, publicKeyOf, sha256Hex, signBlinded, unblind, verifyToken } from "../packages/crypto/src/index.ts";
import { actualCost, blankOutputCount, inputTokenBound, maxCost, publicKeyset, splitAmount, DENOMINATIONS } from "../packages/wallet/src/index.ts";

const hex32 = (seed: string) => sha256Hex(seed); // a valid scalar for every seed used below (checked by publicKeyOf)
const out: Record<string, unknown> = {};

out.hashToCurve = ["00".repeat(32), "00".repeat(31) + "01", "00".repeat(31) + "02", hex32("a"), hex32("b"), hex32("coin")].map((secret) => ({
  secret,
  Y: hashToCurve(hexToBytes(secret)).toHex(true),
}));

out.bdhke = [0, 1, 2, 3, 4].map((i) => {
  const k = hex32(`k${i}`);
  const secret = hex32(`secret${i}`);
  const r = hex32(`r${i}`);
  const K = publicKeyOf(k);
  const { B_ } = blind(hexToBytes(secret), r);
  const C_ = signBlinded(k, B_);
  const C = unblind(C_, r, K);
  return { k, K, secret, r, B_, C_, C, valid: verifyToken(k, hexToBytes(secret), C), wrongKeyValid: verifyToken(hex32("other"), hexToBytes(secret), C) };
});

const pairs = Object.fromEntries(DENOMINATIONS.map((d) => { const k = hex32(`denom${d}`); return [String(d), { privateKey: k, publicKey: publicKeyOf(k) }]; }));
const keysetId = `zr${sha256Hex(DENOMINATIONS.map((d) => pairs[String(d)]!.publicKey).join("")).slice(0, 14)}`;
out.keyset = { privateKeys: Object.fromEntries(Object.entries(pairs).map(([a, p]) => [a, p.privateKey])), id: keysetId, json: JSON.stringify(publicKeyset({ id: keysetId, pairs })), mintKeysFile: JSON.stringify({ id: keysetId, pairs }) };

out.splitAmount = [0, 1, 2, 3, 13, 1000, 2 ** 24 - 1, 2 ** 24, 2 ** 25 - 1, 2 ** 25, 2 ** 25 + 5, 3 * 2 ** 24 + 7, 100_000_000].map((total) => ({ total, coins: splitAmount(total) }));
out.blankOutputCount = [0, 1, 2, 3, 7, 8, 1000, 2 ** 24, 100_000_000].map((max) => ({ max, count: blankOutputCount(max) }));

const prices = [
  { model: "a", inputPerMTok: 360_000, outputPerMTok: 1_080_000 },
  { model: "b", inputPerMTok: 720_000, outputPerMTok: 2_160_000 },
  { model: "c", inputPerMTok: 1, outputPerMTok: 3 },
  { model: "d", inputPerMTok: 0.5, outputPerMTok: 333_333.3 },
];
const texts = ["", "a", "Hello world", "naïve café", "😀😀 emoji", "汉字测试", "x".repeat(10_001), "line\nbreak\ttab"];
out.pricing = prices.flatMap((price) =>
  [[0], [1, 2], [3, 4, 5], [6], [7, 0]].flatMap((ix) => {
    const messages = ix.map((i, n) => ({ role: n % 2 ? "assistant" : "user", content: texts[i]! })) as { role: "user" | "assistant"; content: string }[];
    return [1, 64, 4096].map((maxTokens) => ({
      price, messages, maxTokens,
      inputTokenBound: inputTokenBound(messages),
      maxCost: maxCost(price, messages, maxTokens),
      actualCost: actualCost(price, { prompt_tokens: Math.floor(inputTokenBound(messages) / 3), completion_tokens: Math.floor(maxTokens / 2) }),
      usage: { prompt_tokens: Math.floor(inputTokenBound(messages) / 3), completion_tokens: Math.floor(maxTokens / 2) },
    }));
  }),
);

const values: unknown[] = [
  null, true, 0, -0, 1, -1, 0.1, 1.5e-7, 1e21, 123456789012345680000, 2 ** 53, "plain", "quote\" back\\ slash / ctl\u0001\u001f nl\n", "é😀  ",
  [], {}, [1, "a", null, { z: 1, a: [true, false] }],
  { b: 1, a: 2, A: 3, "10": "x", "2": "y", é: "u", c: undefined, nested: { y: [{ k: "v" }], x: null } },
  [{ amount: 1, B_: "02ab", keysetId: "zr1" }, { amount: 0, B_: "03cd", keysetId: "zr1" }],
];
out.canonicalJson = values.map((value) => ({ value: value === undefined ? null : value, text: canonicalJson(value), sha256: sha256Hex(canonicalJson(value)) }));

writeFileSync(new URL("../host/tests/fixtures/mint-vectors.json", import.meta.url), JSON.stringify(out, null, 1) + "\n");
console.log("wrote", Object.entries(out).map(([k, v]) => `${k}:${Array.isArray(v) ? v.length : 1}`).join(" "));
void bytesToHex;
