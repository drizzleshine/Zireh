import { describe, expect, it } from "vitest";
import { decryptBackup, encryptBackup } from "../src/index.ts";

describe("passphrase-encrypted backups", () => {
  it("round-trips confidential case data and rejects wrong passwords or tampering", async () => {
    const source = { key: "private case key", evidence: "confidential source" };
    const backup = await encryptBackup(source, "a long unique passphrase");
    expect(JSON.stringify(backup)).not.toContain("private case key");
    expect(await decryptBackup(backup, "a long unique passphrase")).toEqual(source);
    await expect(decryptBackup(backup, "a different long passphrase")).rejects.toThrow();
    await expect(decryptBackup({ ...backup, salt: "A".repeat(43) }, "a long unique passphrase")).rejects.toThrow();
  });
});
