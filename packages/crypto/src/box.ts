import { bytesToUtf8, fromBase64Url, toBase64Url, utf8ToBytes } from "./bytes.ts";
import { randomBytes } from "./random.ts";

/**
 * Symmetric encryption for shared case data (AES-256-GCM via WebCrypto).
 * A case key is 32 random bytes, shared with members through the invite link fragment.
 * The sync host only ever sees `Sealed` values.
 */
export interface Sealed {
  readonly v: 1;
  readonly iv: string; // base64url, 12 bytes
  readonly ct: string; // base64url ciphertext + tag
}

/** WebCrypto wants buffers backed by a plain ArrayBuffer; copy into one. */
const buf = (bytes: Uint8Array): Uint8Array<ArrayBuffer> => new Uint8Array(bytes);

export const generateCaseKey = (): string => toBase64Url(randomBytes(32));

async function importKey(caseKey: string): Promise<CryptoKey> {
  const raw = fromBase64Url(caseKey);
  if (raw.length !== 32) throw new Error("case key must be 32 bytes");
  return crypto.subtle.importKey("raw", buf(raw), "AES-GCM", false, ["encrypt", "decrypt"]);
}

/** `context` is bound as associated data (e.g. the record id), so ciphertexts can't be swapped. */
export async function seal(caseKey: string, plaintext: string, context = ""): Promise<Sealed> {
  const iv = randomBytes(12);
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: buf(iv), additionalData: buf(utf8ToBytes(context)) },
    await importKey(caseKey),
    buf(utf8ToBytes(plaintext)),
  );
  return { v: 1, iv: toBase64Url(iv), ct: toBase64Url(new Uint8Array(ct)) };
}

export async function open(caseKey: string, sealed: Sealed, context = ""): Promise<string> {
  const pt = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: buf(fromBase64Url(sealed.iv)), additionalData: buf(utf8ToBytes(context)) },
    await importKey(caseKey),
    buf(fromBase64Url(sealed.ct)),
  );
  return bytesToUtf8(new Uint8Array(pt));
}

export const sealJson = (caseKey: string, value: unknown, context = ""): Promise<Sealed> =>
  seal(caseKey, JSON.stringify(value), context);

export const openJson = async <T>(caseKey: string, sealed: Sealed, context = ""): Promise<T> =>
  JSON.parse(await open(caseKey, sealed, context)) as T;
