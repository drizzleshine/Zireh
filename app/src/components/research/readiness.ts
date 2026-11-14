import type { AppStatus, PrivacyLevel } from "@zireh/schema";

export function readinessNote(status: AppStatus, level: PrivacyLevel): string {
  const cloud = status.relay.sealed ? "NEAR AI" : "the AI behind the relay";
  if (level === "local") return status.localModel.ok ? "" : "Local only needs on-device AI. Direct does not.";
  if (!status.relay.ok) return status.localModel.ok ? "The relay can't be reached right now. Local only still works." : "The relay can't be reached right now. Try again in a moment.";
  if (status.relay.upstreamOk === false) return `The relay is up, but ${cloud} isn't answering. Try again in a moment. The on-device download is not required.`;
  if (status.walletBusy) return "Zireh is open in another tab, which holds the wallet. Close it to send from here.";
  return "";
}
