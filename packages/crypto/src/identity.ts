import { canonicalJson, sha256Hex } from "./hash.ts";
import { fromBase64Url, toBase64Url, utf8ToBytes } from "./bytes.ts";

export interface MemberKeys {
  readonly memberId: string;
  readonly publicKey: string;
  readonly privateKey: JsonWebKey;
}
export const memberIdForKey = (publicKey: string): string => sha256Hex(`zireh/member/v1:${publicKey}`).slice(0, 32);
export async function generateMemberKeys(): Promise<MemberKeys> {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const publicKey = toBase64Url(new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey)));
  return { memberId: memberIdForKey(publicKey), publicKey, privateKey: await crypto.subtle.exportKey("jwk", pair.privateKey) };
}
export async function signValue(keys: MemberKeys, value: unknown): Promise<string> {
  const key = await crypto.subtle.importKey("jwk", keys.privateKey, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  return toBase64Url(new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, new Uint8Array(utf8ToBytes(canonicalJson(value))))));
}
export async function verifyValue(publicKey: string, signature: string, value: unknown): Promise<boolean> {
  try {
    const key = await crypto.subtle.importKey("raw", new Uint8Array(fromBase64Url(publicKey)), { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
    return await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, new Uint8Array(fromBase64Url(signature)), new Uint8Array(utf8ToBytes(canonicalJson(value))));
  } catch { return false; }
}
