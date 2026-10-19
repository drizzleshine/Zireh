import { describe, expect, it } from "vitest";
import {
  blind,
  canonicalJson,
  generateCaseKey,
  generateMintKeypair,
  hashJson,
  hashToCurve,
  hexToBytes,
  open,
  publicKeyOf,
  seal,
  sha256Hex,
  shuffle,
  signBlinded,
  unblind,
  utf8ToBytes,
  verifyToken,
} from "../src/index.ts";

describe("hashToCurve (Cashu NUT-00 vectors)", () => {
  it.each([
    ["00".repeat(32), "024cce997d3b518f739663b757deaec95bcd9473c30a14ac2fd04023a739d1a725"],
    [`${"00".repeat(31)}01`, "022e7158e11c9506f1aa4248bf531298daa7febd6194f003edcd9b93ade6253acf"],
  ])("maps %s", (input, expected) => {
    expect(hashToCurve(hexToBytes(input)).toHex(true)).toBe(expected);
  });
});

describe("BDHKE", () => {
  it("matches the NUT-00 blinding vector", () => {
    const { B_ } = blind(utf8ToBytes("test_message"), `${"00".repeat(31)}01`);
    expect(B_).toBe("025cc16fe33b953e2ace39653efb3e7a7049711ae1d8a2f7a9108753f1cdea742b");
  });

  it("round-trips blind → sign → unblind → verify", () => {
    const mint = generateMintKeypair();
    const secret = utf8ToBytes("one-use-token-secret");
    const { B_, r } = blind(secret);
    const C = unblind(signBlinded(mint.privateKey, B_), r, mint.publicKey);
    expect(verifyToken(mint.privateKey, secret, C)).toBe(true);
  });

  it("rejects a token signed by another key or for another secret", () => {
    const mint = generateMintKeypair();
    const other = generateMintKeypair();
    const secret = utf8ToBytes("s");
    const { B_, r } = blind(secret);
    const C = unblind(signBlinded(mint.privateKey, B_), r, mint.publicKey);
    expect(verifyToken(other.privateKey, secret, C)).toBe(false);
    expect(verifyToken(mint.privateKey, utf8ToBytes("t"), C)).toBe(false);
    expect(verifyToken(mint.privateKey, secret, "02deadbeef")).toBe(false);
  });

  it("the mint never sees the same value twice (blinding is unlinkable)", () => {
    const secret = utf8ToBytes("same secret");
    expect(blind(secret).B_).not.toBe(blind(secret).B_);
  });

  it("derives the public key from the private key", () => {
    const mint = generateMintKeypair();
    expect(publicKeyOf(mint.privateKey)).toBe(mint.publicKey);
  });
});

describe("case box", () => {
  it("seals and opens with the same key and context", async () => {
    const key = generateCaseKey();
    const sealed = await seal(key, "the source is in the archive", "evidence:1");
    expect(sealed.ct).not.toContain("archive");
    expect(await open(key, sealed, "evidence:1")).toBe("the source is in the archive");
  });

  it("fails with the wrong key or a swapped context", async () => {
    const key = generateCaseKey();
    const sealed = await seal(key, "x", "evidence:1");
    await expect(open(generateCaseKey(), sealed, "evidence:1")).rejects.toThrow();
    await expect(open(key, sealed, "evidence:2")).rejects.toThrow();
  });
});

describe("hashing", () => {
  it("canonical JSON ignores key order and undefined", () => {
    expect(canonicalJson({ b: 1, a: [2, { d: 3, c: undefined }] })).toBe('{"a":[2,{"d":3}],"b":1}');
    expect(hashJson({ a: 1, b: 2 })).toBe(hashJson({ b: 2, a: 1 }));
  });

  it("sha256Hex matches a known vector", () => {
    expect(sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
});

describe("shuffle", () => {
  it("keeps all items", () => {
    const items = Array.from({ length: 50 }, (_, i) => i);
    expect(shuffle(items).sort((a, b) => a - b)).toEqual(items);
  });
});
