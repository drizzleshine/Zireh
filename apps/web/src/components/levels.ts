import type { PrivacyLevel } from "@zireh/schema";

/** Plain-language names for the privacy levels (policy itself lives in @zireh/schema LEVELS). */
export const LEVEL_COPY: Record<PrivacyLevel, { name: string; note: string }> = {
  local: { name: "Local only", note: "Answered by the model on this computer. Nothing is sent anywhere." },
  standard: { name: "Standard", note: "Names and places hidden, then sent as one question over Tor." },
  private: { name: "Private", note: "Also split into separate questions, each with a decoy, each on its own circuit." },
  paranoid: { name: "Paranoid", note: "Stricter leak check and three decoys per question. Slowest and costs most." },
};
