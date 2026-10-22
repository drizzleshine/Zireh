import { fromBase64Url, toBase64Url, utf8ToBytes, bytesToUtf8, sha256Hex } from "@zireh/crypto";

/**
 * An invite carries the case id and the case key in the URL fragment (`#zp1.<id>.<key>`).
 * Browsers never send the fragment to a server, so the key reaches only the people the
 * link is shared with.
 */
export interface Invite {
  readonly caseId: string;
  readonly caseKey: string;
  readonly syncId?: string;
  readonly requiresSignatures?: boolean;
  readonly keyEpoch?: number;
}

export const inviteFragment = (invite: Invite): string => (invite.syncId || invite.requiresSignatures) ? `zp2.${toBase64Url(utf8ToBytes(JSON.stringify({ ...invite, syncId: invite.syncId ?? invite.caseId, keyEpoch: invite.keyEpoch ?? 0 })))}` : `zp1.${invite.caseId}.${invite.caseKey}`;

export function parseInvite(text: string): Invite | undefined {
  const v2 = /(?:^|#)zp2\.([A-Za-z0-9_-]+)$/.exec(text);
  if (v2) {
    try {
      const invite = JSON.parse(bytesToUtf8(fromBase64Url(v2[1]!))) as Invite;
      if (!/^[0-9a-f]{32}$/.test(invite.caseId) || !/^[0-9a-f]{32}$/.test(invite.syncId ?? "") || fromBase64Url(invite.caseKey).length !== 32 || !Number.isSafeInteger(invite.keyEpoch) || invite.keyEpoch! < 0) return undefined;
      return invite;
    } catch { return undefined; }
  }
  const m = /zp1\.([0-9a-f]{32})\.([A-Za-z0-9_-]{43})/.exec(text);
  if (!m) return undefined;
  try {
    if (fromBase64Url(m[2]!).length !== 32) return undefined;
  } catch {
    return undefined;
  }
  return { caseId: m[1]!, caseKey: m[2]! };
}

/**
 * Write capability for the sync host, derived one-way from the case key. The host stores
 * only its hash, so it can check members without being able to decrypt anything.
 */
export const caseToken = (caseKey: string): string => sha256Hex(`zireh/case-token/v1:${caseKey}`);
export const caseTokenHash = (token: string): string => sha256Hex(`zireh/case-token-hash/v1:${token}`);
