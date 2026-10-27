import { RelayCallError, type PendingCall, type RelayClient } from "@zireh/inference";
import type { Ledger } from "@zireh/ledger";

/** Install the same audit path for normal sends and daemon recovery. Writes precede network IO. */
export function observePayments(relay: RelayClient, ledger: Ledger): void {
  const ensure = (call: PendingCall, circuit?: string) => {
    if (ledger.receipts().some((receipt) => receipt.id === call.requestId)) return;
    ledger.record({ requestId: call.requestId, state: "attempted", destination: call.kind === "search" ? "search" : "relay",
      role: call.audit?.role ?? "real", ...(call.audit?.caseId ? { caseId: call.audit.caseId } : {}),
      payload: JSON.stringify(call.body), preview: call.messages?.at(-1)?.content ?? String(call.body.query ?? ""),
      ...(circuit ? { circuit } : {}) });
  };
  relay.observe({
    attempt(call, circuit) {
      ensure(call, circuit);
      const current = ledger.receipts().find((receipt) => receipt.id === call.requestId);
      if (current?.state !== "settled" && current?.state !== "recovered") ledger.updateReceipt(call.requestId, { state: "attempted", circuit });
    },
    result(call, result, recovered) {
      ensure(call);
      ledger.updateReceipt(call.requestId, { state: recovered ? "recovered" : "settled", charged: result.charged,
        ...(result.kind === "chat" ? { expectedCharge: result.bill.expected, overcharged: result.bill.overcharged } : {}) });
    },
    writtenOff(call, amount) {
      ensure(call);
      ledger.updateReceipt(call.requestId, { state: "written-off", charged: amount, error: call.dispute ?? "Dispute written off by the user" });
    },
    failure(call, error, charged) {
      ensure(call);
      ledger.updateReceipt(call.requestId, { state: error.message.includes("disputed") || error instanceof RelayCallError && error.code === "settlement_disputed" ? "disputed" : "failed",
        error: error.message, ...(charged !== undefined ? { charged } : {}) });
    },
  });
}
