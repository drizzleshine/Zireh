import type { PrivacyLevel } from "@zireh/schema";

/** Plain-language names for the privacy levels (policy itself lives in @zireh/schema LEVELS). */
export const LEVEL_COPY: Record<PrivacyLevel, { name: string; note: string }> = {
  local: { name: "Local only", note: "Answered on this computer. Nothing is sent." },
  standard: { name: "Direct", note: "Sent as you wrote it, in one question. Names are not hidden." },
  private: { name: "Private", note: "Split into separate questions, each with a decoy." },
  paranoid: { name: "Paranoid", note: "Three decoys per question and the strictest check. Slowest." },
};
