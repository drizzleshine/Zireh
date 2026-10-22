import { fromBase64Url, toBase64Url, utf8ToBytes } from "./bytes.ts";
import { openJson, sealJson, type Sealed } from "./box.ts";
import { randomBytes } from "./random.ts";

export interface EncryptedBackup {
  readonly v: 1;
  readonly kdf: "PBKDF2-SHA256";
  readonly iterations: 600000;
  readonly salt: string;
  readonly box: Sealed;
}
const context = (salt: string) => `zireh/backup/v1:PBKDF2-SHA256:600000:${salt}`;
async function backupKey(passphrase: string, salt: string): Promise<string> {
  if (passphrase.length < 12 || passphrase.length > 1024) throw new Error("Use a passphrase between 12 and 1024 characters");
  const bytes = fromBase64Url(salt);
  if (bytes.length !== 32) throw new Error("Invalid backup salt");
  const material = await crypto.subtle.importKey("raw", new Uint8Array(utf8ToBytes(passphrase)), "PBKDF2", false, ["deriveBits"]);
  const key = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: new Uint8Array(bytes), iterations: 600000 }, material, 256);
  return toBase64Url(new Uint8Array(key));
}
export async function encryptBackup(value: unknown, passphrase: string): Promise<EncryptedBackup> {
  const salt = toBase64Url(randomBytes(32));
  const box = await sealJson(await backupKey(passphrase, salt), value, context(salt));
  return { v: 1, kdf: "PBKDF2-SHA256", iterations: 600000, salt, box };
}
export async function decryptBackup(value: unknown, passphrase: string): Promise<unknown> {
  const data = value as Partial<EncryptedBackup> | null;
  if (!data || data.v !== 1 || data.kdf !== "PBKDF2-SHA256" || data.iterations !== 600000 || typeof data.salt !== "string" || data.box?.v !== 1 || typeof data.box.iv !== "string" || typeof data.box.ct !== "string" || data.box.ct.length > 64 * 1024 * 1024) throw new Error("Invalid or unsupported backup file");
  try { return await openJson(await backupKey(passphrase, data.salt), data.box, context(data.salt)); }
  catch { throw new Error("Could not decrypt this backup. Check the passphrase and file."); }
}
