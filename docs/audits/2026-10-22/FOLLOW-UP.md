# Follow-up issues after the audit fixes

Review of commits `25d03fa..6623b32` (30 commits). `pnpm check` passes (179 tests) and the web
build passes. The audit findings are fixed. These four issues remain. Same ground rules as
`FIX-PLAN.md`: write a failing test first, keep the package layering, commit only when
`pnpm check` is green, record design decisions in `context/decisions.md`, and update
`context/progress.md` when done.

Suggested order: G1, G2, G3, G4.

---

## G1 · Sequential sending creates a linkable timing pattern (medium)

**Where:** `apps/daemon/src/research.ts` (`const CONCURRENCY = 1`, the `pool(...)` send loop,
~line 105), `packages/wallet/src/wallet.ts` (coin selection), `packages/inference/src/client.ts`.

**Problem:** F12 was fixed by sending pieces strictly one at a time so change from one call can
fund the next. Each request now starts right after the previous one settles. The relay (and
anyone watching it) sees "request ends → next request starts within milliseconds", on a fresh
circuit each time. That chain links the pieces as one task, undoing much of what splitting and
decoys are for. It's also slow: a Paranoid run is 8 Tor round trips in a row.

**Fix:**
1. **Allocate coins for the whole plan before sending anything.** In one money-store
   transaction, take a coin set for every piece (each covering that piece's `maxCost`). If the
   wallet's denominations can't cover every piece separately, first do a **swap**: add
   `POST /v1/swap` to the relay (redeem large coins, return exact power-of-two change as blind
   signatures, no upstream call, zero fee) and a `RelayClient.swap(amounts)` that journals the
   blinded outputs like a top-up (same recovery rules as F06). Re-check, then allocate.
2. **Send in parallel with random jitter.** Restore concurrency (all pieces of the plan, or
   a cap like 4 to avoid the onion-rendezvous failures noted in `context/decisions.md`). Before
   each send, wait an independent random delay (e.g. uniform 0–3 s; make the range a constant and
   record the choice). Real and decoy pieces are scheduled the same way, so timing doesn't
   distinguish them.
3. Keep the existing guarantees: if allocation fails, **nothing** is sent; cancellation still
   stops unsent pieces; submitted pieces still settle.

**Tests:**
- One 1,048,576-credit coin and a 4-piece Paranoid plan: a swap happens first, then all pieces
  are prepared before the first send, and all settle.
- With a fake clock/scheduler, the send start times are not a strict chain (no send starts at
  the instant the previous one settles), and several sends overlap.
- Allocation failure → zero relay chat calls.

**Done when:** a Paranoid run on the local-dev stack completes with overlapping sends, and the
README/decisions describe the scheduling.

---

## G2 · Disputed settlements are resent every 60 seconds forever (low)

**Where:** `packages/inference/src/client.ts` (`recover()`, `settle()`),
`apps/daemon/src/main.ts` (60 s recovery interval), `apps/daemon/src/api.ts` (receipts/disputes),
web privacy log UI.

**Problem:** a call marked `disputed` stays in the pending list, and `recover()` resends every
pending call, including disputed ones, every minute with no backoff and no end. The relay just
replays the same stored settlement, so it stays disputed. That's endless background Tor traffic
(an activity signal) and the user has no way to resolve it.

**Fix:**
1. `recover()` skips calls with `status: "disputed"`.
2. Add exponential backoff for other pending calls that keep failing (store `attempts` and
   `nextRetryAt` on the pending record; e.g. 1 min, 2, 4 … capped at 1 hour).
3. Give disputes a resolution path in the API and UI:
   - `POST /api/disputes/:requestId/retry`: one manual re-check against the relay.
   - `POST /api/disputes/:requestId/write-off`: the user accepts the loss; in one money-store
     transaction, move the record to a `written-off` journal entry (kept for the privacy log)
     and remove it from pending.
   - Show disputes in the Privacy log with the reason, amount at stake, and these two actions.

**Tests:** a disputed call is not resent by `recover()`; a failing non-disputed call is retried on
the backoff schedule; write-off removes it from pending and keeps a log entry; manual retry calls
the relay exactly once.

---

## G3 · Invite sync hosts accept loopback on any port (low)

**Where:** `packages/schema/src/location.ts` (`SyncHost`), `apps/daemon/src/api.ts`
(`/api/sync/*` routes use `body.host`), `packages/cases/src/invite.ts`.

**Problem:** `SyncHost` accepts `http://127.0.0.1:<any port>` and `http://localhost:<any port>`.
An invite carries a host, and the daemon connects to it. In direct (no-Tor) dev mode, a crafted
invite can make the daemon POST/GET to any local port on the fixed `/v1/cases/<id>/records`
path, and the sync error message includes the response text, which goes back to the page. Tor
mode is unaffected (exits refuse loopback). Also, a loopback host in an invite is meaningless on
another person's machine.

**Fix:**
1. Invites may only carry **onion** hosts: add `InviteSyncHost` (onion-only) and use it in
   `inviteFragment`/`parseInvite`. A loopback host is never written into an invite.
2. The daemon accepts a client-supplied `host` only if it is an onion URL or exactly equal to
   its configured `syncUrl` (`deps.syncUrl`); anything else → 400.
3. Don't echo upstream response bodies in sync errors: `SyncError` keeps the status and a short
   generic message; log details server-side only.

**Tests:** `parseInvite` rejects an invite with `http://127.0.0.1:11434`; `/api/sync/pull` with a
loopback host that isn't the configured one → 400 and no request made; a sync host error reply
body doesn't appear in the API response.

---

## G4 · README timing numbers are stale (docs)

**Where:** `README.md` ("Measured on an M1 MacBook" table), `context/decisions.md`.

**Problem:** "Private-level question, local-dev upstream: 40–180 s" was measured when pieces
were sent in parallel. Sending changed (and will change again with G1), and the numbers weren't
re-measured.

**Fix:** after G1 lands, run `pnpm dev`, top up, and time one Standard, one Private and one
Paranoid question (local-dev upstream), plus `pnpm smoke:tor`. Update the table with the new
numbers and the date, and note in `context/decisions.md` how they were measured. Don't publish
numbers that weren't measured.
