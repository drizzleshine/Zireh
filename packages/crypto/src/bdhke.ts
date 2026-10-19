import { secp256k1 } from "@noble/curves/secp256k1.js";
import { bytesToHex, concatBytes, hexToBytes, utf8ToBytes } from "./bytes.ts";
import { sha256 } from "./hash.ts";
import { randomBytes } from "./random.ts";

/**
 * Blind Diffie-Hellman key exchange, as specified by Cashu NUT-00.
 *
 *   Y  = hashToCurve(secret)
 *   B_ = Y + r·G          (client blinds)
 *   C_ = k·B_             (mint signs, never sees Y)
 *   C  = C_ − r·K = k·Y   (client unblinds)
 *   verify: C == k·Y      (mint checks a spent token)
 *
 * Points travel as compressed hex; scalars as 32-byte hex.
 */
const Point = secp256k1.Point;
const N = Point.Fn.ORDER;
const DOMAIN = utf8ToBytes("Secp256k1_HashToCurve_Cashu_");

type PointT = InstanceType<typeof Point>;

export function hashToCurve(secret: Uint8Array): PointT {
  const msgHash = sha256(concatBytes(DOMAIN, secret));
  const counter = new Uint8Array(4);
  const view = new DataView(counter.buffer);
  for (let i = 0; i < 2 ** 16; i++) {
    view.setUint32(0, i, true);
    try {
      return Point.fromBytes(concatBytes(new Uint8Array([0x02]), sha256(concatBytes(msgHash, counter))));
    } catch {
      // not on the curve; try the next counter
    }
  }
  throw new Error("hashToCurve: no valid point found");
}

function randomScalar(): bigint {
  for (;;) {
    const k = BigInt(`0x${bytesToHex(randomBytes(32))}`);
    if (k > 0n && k < N) return k;
  }
}

const scalarToHex = (k: bigint): string => k.toString(16).padStart(64, "0");
const scalarFromHex = (hex: string): bigint => {
  const k = BigInt(`0x${hex}`);
  if (k <= 0n || k >= N) throw new Error("scalar out of range");
  return k;
};
const pointFromHex = (hex: string): PointT => Point.fromBytes(hexToBytes(hex));

export interface MintKeypair {
  readonly privateKey: string; // k
  readonly publicKey: string; // K = k·G
}

export function generateMintKeypair(): MintKeypair {
  const k = randomScalar();
  return { privateKey: scalarToHex(k), publicKey: Point.BASE.multiply(k).toHex(true) };
}

export const publicKeyOf = (privateKey: string): string =>
  Point.BASE.multiply(scalarFromHex(privateKey)).toHex(true);

export interface Blinded {
  readonly B_: string; // sent to the mint
  readonly r: string; // kept by the client
}

export function blind(secret: Uint8Array, r: string = scalarToHex(randomScalar())): Blinded {
  const B_ = hashToCurve(secret).add(Point.BASE.multiply(scalarFromHex(r)));
  return { B_: B_.toHex(true), r };
}

/** Mint side: C_ = k·B_. */
export const signBlinded = (privateKey: string, B_: string): string =>
  pointFromHex(B_).multiply(scalarFromHex(privateKey)).toHex(true);

/** Client side: C = C_ − r·K. */
export const unblind = (C_: string, r: string, publicKey: string): string =>
  pointFromHex(C_).subtract(pointFromHex(publicKey).multiply(scalarFromHex(r))).toHex(true);

/** Mint side: a token (secret, C) is valid iff C == k·hashToCurve(secret). */
export function verifyToken(privateKey: string, secret: Uint8Array, C: string): boolean {
  try {
    return hashToCurve(secret).multiply(scalarFromHex(privateKey)).equals(pointFromHex(C));
  } catch {
    return false;
  }
}
