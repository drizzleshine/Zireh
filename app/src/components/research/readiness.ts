import type { AppStatus, PrivacyLevel } from "@zireh/schema";

export function readinessNote(status: AppStatus, level: PrivacyLevel): string {
  if (level === "local") return status.localModel.ok ? "" : "Local only needs on-device AI.";
  if (!status.relay.ok) return status.localModel.ok ? "The relay can't be reached right now. Local only still works." : "The relay can't be reached right now. Try again in a moment.";
  if (status.relay.upstreamOk === false) return status.localModel.ok ? "The relay is up, but the AI behind it isn't answering. Local only still works." : "The relay is up, but the AI behind it isn't answering. Try again in a moment.";
  if (status.walletBusy) return "Zireh is open in another tab, which holds the wallet. Close it to send from here.";
  return "";
}
