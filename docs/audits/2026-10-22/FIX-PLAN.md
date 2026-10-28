# Zireh fix plan for the 2026-10-22 audit

This is the work order for fixing every finding in `docs/audits/2026-10-22/README.md`. Read that
audit first; this file says **how** to fix each item, in what order, and how to prove it's fixed.
All findings were re-verified against the code at commit `25d03fa` and are real.

## Ground rules for whoever does this

1. **Repo:** `/Users/kelvx/Dev/projects/hackathons/zireh` (pnpm monorepo, TypeScript, Node 26).
   Read `context/architecture.md`, `context/decisions.md` and `context/progress.md` before
   starting. All project notes go in `context/`, nowhere else.
2. **Architecture is enforced.** Packages live in strict layers (`pnpm check:layers`): a package
   may only import from lower layers; packages in the same layer never import each other; apps
   compose packages and never import other apps. Keep fixes inside the package that owns the
   behavior. Keep the code clean, small and readable; match the surrounding style.
3. **Test first, per finding.** For each finding, first write a regression test that fails on
   the current code (the audit's `reproduce-*.mts` scripts show the scenarios), then fix, then
   make it pass. The existing 110 tests passed with all these bugs present: they mostly use
   scripted models and skip these paths. New tests must exercise the real path.
4. **Definition of done for each step:** `pnpm check` passes (layers + typecheck + tests),
   `pnpm --filter @zireh/web build` passes, one commit per finding with a message naming it
   (e.g. `F01: derive privacy level from zireh/<level> model ids`). Only commit when the check
   is green (chain with `&&`, never `;`).
5. **Don't change behavior beyond the finding.** If a fix forces a design decision, record it in
   `context/decisions.md` (dated, with the reason).
6. **Fail closed.** When unsure whether something may leave the device or whether money is
   settled, the answer is "no": block the send, keep the pending record.
7. Update `context/progress.md` after each phase.

## Order of work

| Phase | Findings | Why this order |
|---|---|---|
| 1. Nothing identifying leaves | F01, F03, F02, F04 | Core privacy promise; small, contained changes |
| 2. Publishing is safe | F05 | Can expose sources in a shared file |
| 3. Money is never lost | F09, F08, F07, F06, F12 | Shared ledger/journal design; do F09 first because the others build on it |
| 4. Logs tell the truth | F13 | Depends on the journal from phase 3 |
| 5. Browser state is correct | F14, F10, F15, F11 | F14 (immutable snapshots) first; F10 and F11 build on it |
| 6. Side items | relay exposure, fonts, Tor dispatchers, Node engine, README claims | Low effort, real risk |
| 7. Product gaps | backup/import, review-before-send, etc. | After defects are gone |

---

## Phase 1 — Nothing identifying leaves the device

### F01 · `zireh/local` is routed to the cloud
- **Where:** `apps/daemon/src/api.ts` (`openAiChat`, ~line 65).
- **Fix:** derive the level from the request: if `model` matches `zireh/<level>` with a valid
  `PrivacyLevel`, use it. The `x-zireh-level` header may override only when it is a valid level;
  if both are present and disagree, return 400. An unknown `model` (not `zireh/*` and not an
  offered relay model) returns 400 instead of silently picking the first cloud model. For level
  `local`, never call `cloudModel()`.
- **Tests (daemon.test.ts):** `model: "zireh/local"` with no header makes **zero** relay calls
  (`seen.length === 0`) and returns `model: "zireh/local"`; contradictory header → 400; unknown
  model → 400.

### F03 · Decoys bypass the final privacy checks
- **Where:** `packages/shield/src/shield.ts` (decoy loop, ~149).
- **Fix:** add one **final outbound gate** in `shield` that runs on every serialized piece (real
  and decoy) right before the plan is returned: scrub with `applyTable` + `withHints` (as real
  questions already are), then require `findLeaks(wireText, table).length === 0`. A decoy that
  fails is dropped and replaced (ask `makeDecoys` for more); if the level's decoy count can't be
  met, fail closed (throw, send nothing). Make the gate the single place this is enforced so
  future piece types can't skip it.
- **Tests (shield.test.ts):** with `Lagos` in the table, a decoy containing `Lagos` never appears
  in `plan.pieces`; if all decoys are unsafe, `compile` throws and returns no pieces.

### F02 · Lowercase and non-Latin names are discarded
- **Where:** `packages/redact/src/redact.ts` (`plausible`, ~38).
- **Fix:** drop the capital-letter requirement for person/org/place. Keep only checks that don't
  depend on script or casing: the entity must occur in the text (already enforced), have at
  least 2 characters, not be a common stop word (reuse the `COMMON` list from `detect.ts`; move
  it to a shared module if needed), and for id/money/date keep the digit/month rule. The
  over-redaction this filter was added for ("records were altered") is better handled by
  rejecting model entities of 3+ words that contain a verb-like stop word, or by length limits;
  write a test for that case so it doesn't regress.
- **Tests (redact.test.ts):** model returns `ada obi` (person) → hidden; `张伟` (person) → hidden;
  `records were altered` (id) → not hidden. Add a daemon-level test that `/api/search` with
  `ada obi` never sends it to the relay.

### F04 · Stop doesn't stop disclosure or spending
- **Where:** `apps/daemon/src/api.ts` (research SSE route), `apps/daemon/src/research.ts`,
  `packages/shield/src/shield.ts`, `apps/web/src/components/ResearchPanel.tsx`.
- **Fix:** give each run an id and an `AbortController` in the daemon. Thread an `AbortSignal`
  through `compile`/`finish` (check `signal.aborted` between stages and pass it to `local.chat`)
  and through the send loop (no new piece is prepared or sent once aborted). Abort when the SSE
  client disconnects **before any piece is sent**; once pieces are in flight, stop preparing new
  ones, let submitted calls settle (money safety), record their results, and report
  `cancelled` with partial results. Add `POST /api/research/:runId/cancel` and have the Stop
  button call it (the stream's first event should carry the run id). UI copy must state what
  was already sent.
- **Tests:** abort during redaction → zero relay calls; abort after one piece is submitted → that
  piece settles, no further pieces are sent, final event is `cancelled`.

---

## Phase 2 — Publishing is safe

### F05 · Hidden-name export misses fields and can export raw names
- **Where:** `apps/web/src/components/ConcludePanel.tsx`, `packages/cases/src/publication.ts`.
- **Fix:**
  1. Add `publicationTexts(publication)` in `packages/cases` that returns **every** string field of
     a `Publication` (title, question, conclusion fields, statements, uncertainty, observation
     text, evidence titles, author names). The scan uses exactly this list, so scan input and
     export can't drift apart again. Unit-test that every string in the snapshot is covered.
  2. Track scan state: store a hash of the publication snapshot (built with names shown) at scan
     time. The page counts as "reviewed" only if the current snapshot hash equals the scanned
     one; any edit invalidates it.
  3. When hiding is on: disable **Download** until a scan has run for the current snapshot and
     the user has looked at the full final output (render the complete hidden page in the preview,
     not just a summary) and pressed "Looks right". Only then may the export say `namesHidden:
     true` / "Names and places are generalized".
  4. Add a final deterministic check before export: `findLeaks(allTexts, table)` must be empty.
- **Tests:** `cases` unit test with a source named only in an evidence title → appears in the scan
  input and is hidden in the export. Component-level or store-level test that download is
  blocked with an empty table.

---

## Phase 3 — Money is never lost

Design first (record in `context/decisions.md`): **one durable journal per side**.

- **Client:** replace the separate `coins.json` + `pending.json` with one store whose writes
  are atomic across both (e.g. a single JSON document written atomically, or `node:sqlite` in
  the daemon). Every money movement is one transaction: "take coins + create pending record"
  and "settle: remove pending + add change" must each commit together or not at all.
- **Relay:** in `apps/relay/src/storage.ts` + `packages/relay-core`, make "mark secrets spent" and
  "write REDEEMED marker for requestId" one SQLite transaction. Settlement responses that carry
  money (change signatures, refunds) are kept until acknowledged, not 15 minutes.

### F09 · Recovery records aren't atomic with money movements
- **Where:** `packages/wallet/src/wallet.ts`, `packages/inference/src/client.ts` (`prepare`,
  `settle`), `apps/daemon/src/stores.ts`, `packages/relay-core/src/relay.ts` (~117),
  `apps/relay/src/storage.ts`.
- **Fix:** introduce a `MoneyStore` interface (L4 `wallet`) with `atomically(fn)` semantics, and
  implement it in the daemon over one SQLite file. `prepare` = take coins and save the pending
  call in one transaction; `settle` = credit change and remove the pending call in one
  transaction. Relay: extend `SpentStore` to `redeem(secrets, requestId, amount)` that inserts
  spent secrets and the REDEEMED marker in one transaction.
- **Tests:** inject a failure in the pending write → coins are still in the wallet (balance
  unchanged); inject a failure between spend and marker on the relay → neither is committed.

### F08 · Bill audit doesn't verify change was returned
- **Where:** `packages/inference/src/client.ts` (`settle`, `send`), `packages/wallet/src/pricing.ts`.
- **Fix:** before crediting, check `settlement.requestId === call.requestId` and conservation:
  `sum(call.proofs) - sum(change amounts) === settlement.charged`, `change.length <=
  call.blanks.outputs.length`, every change keyset id matches. Optionally verify each unblinded
  coin is well-formed (a valid curve point). On any mismatch: **do not** remove the pending
  record; mark it `disputed`, keep it, and surface it in the UI and privacy log. Extend
  `checkBill` (or a new `checkSettlement`) so `overcharged` includes missing change.
- **Tests:** response with change removed → flagged, pending kept, wallet not silently drained;
  honest response → passes.

### F07 · Recovery window expires while spent coins stay spent
- **Where:** `apps/relay/src/storage.ts` (`sqliteResponseStore`),
  `packages/relay-core/src/relay.ts`, `packages/inference/src/client.ts` (~199–205).
- **Fix:** split relay retention: answer text may expire (privacy), but the settlement (charged,
  usage, change signatures) and REDEEMED markers are kept until the client acknowledges them
  (`POST /v1/settlement/ack {requestId}`) or for a long window (e.g. 30 days). A replay after
  answer expiry returns the settlement without the answer text. Client: `token_spent` on a call
  that's still pending must **not** delete the pending record; treat it as "needs settlement
  lookup" and keep retrying.
- **Tests:** lost reply + 16-minute clock jump → recovery returns the settlement, change is
  credited, wallet ends at balance − actual cost.

### F06 · A lost top-up reply strands the top-up
- **Where:** `packages/inference/src/client.ts` (`redeemTopup`), `packages/relay-core/src/relay.ts`
  (mint route ~200), `packages/zcash`, relay storage.
- **Fix:** client: before calling mint, persist `{quote, outputs, blinding secrets}` in the money
  store as a pending top-up; on success, credit coins and delete it in one transaction; retries
  resend the **same** outputs. Relay: store `quoteId → {outputs hash, signatures}` in the same
  transaction that marks the quote minted; a retry with the same outputs returns the stored
  signatures; different outputs for a minted quote → 409. Daemon recovery loop also retries
  pending top-ups.
- **Tests:** drop the mint reply → retry yields the coins; balance equals the quote credits.

### F12 · Enough total balance, not enough coins for parallel pieces
- **Where:** `apps/daemon/src/research.ts` (~69–78), `packages/wallet/src/wallet.ts`.
- **Fix:** take coins for **all** pieces up front in one money-store transaction (an allocation
  per piece) before sending anything. If the coin set can't be split that way, first do a relay
  "swap" (spend large coins, receive exact denominations as change; add `POST /v1/swap`), or run
  the pieces sequentially, using returned change. Move `prepareChat` inside the per-piece error
  handling so a failure never aborts other in-flight pieces; keep and return partial results.
- **Tests:** a single 1,048,576-credit coin + a 2-piece private plan → both pieces sent and
  settled, or the plan fails before **any** call is sent.

---

## Phase 4 — The privacy log tells the truth

### F13 · Some payloads that left aren't logged
- **Where:** `apps/daemon/src/research.ts`, `apps/daemon/src/main.ts` (recovery),
  `packages/ledger`.
- **Fix:** write the receipt **before** sending, with the full serialized request body (or store
  the body so the hash can be recomputed), state `attempted`; update it to `delivered` /
  `failed` / `settled` / `recovered` with cost afterwards. Recovery updates the same receipt (by
  requestId). The UI shows attempted-but-failed rows. Store enough to recompute
  `payloadSha256` exactly.
- **Tests:** upstream receives the prompt then throws → one receipt with state `failed`;
  recovery → the same receipt becomes `settled`.

---

## Phase 5 — Browser state is correct

### F14 · Store mutation leaves the board stale
- **Where:** `apps/web/src/store.ts` (`apply`, `save`, sync), `BoardPanel.tsx`.
- **Fix:** make updates immutable: every change to a case produces a new `Records` object (and
  new arrays for changed collections); same for workspaces. Then `useStore` selections change
  identity when content changes, and `useMemo([rec])` works. Remove the ConcludePanel memo
  workaround comment once fixed.
- **Tests:** add a store-level test (Vitest + fake IndexedDB, e.g. `fake-indexeddb`) that selector
  results change identity after a pulled record is applied.

### F10 · Separate tabs overwrite each other's unsynced evidence
- **Where:** `apps/web/src/store.ts` (persistence).
- **Fix:** persist records and outbox entries **individually** (one IndexedDB key per record and
  per outbox envelope, written in one IDB transaction per save), not whole-case blobs. Use
  `navigator.locks` (Web Locks API) for sync so only one tab syncs at a time, and a
  `BroadcastChannel` to tell other tabs to reload changed records.
- **Tests:** two store instances over the same fake IndexedDB, both offline, each saves different
  evidence → both records and both outbox entries survive a reload.

### F15 · Large sync batches get stuck forever
- **Where:** `apps/web/src/store.ts` (~229), `apps/sync-host/src/host.ts` (limit 4 MiB),
  `packages/schema` (evidence max size).
- **Fix:** batch by serialized byte size (stay under ~3.5 MiB) as well as count; if a single
  envelope exceeds the host limit, refuse to save it as syncable evidence with a clear message
  (lower the image/document size limit in `schema` to something that fits after encryption and
  base64, or raise the host limit consistently). On 413, split the batch and retry.
- **Tests:** two near-limit documents → pushed in two requests, both succeed.

### F11 · An untrusted host can replay old records
- **Where:** `packages/sync/src/index.ts`, `apps/web/src/store.ts`.
- **Fix (minimum viable):** add an authenticated `rev` (monotonic per record: a counter or
  `{lamport, deviceId}`) inside the sealed payload and in the AEAD context
  (`collection:id:rev`). Devices keep the highest rev seen per record id and **reject** any
  envelope with a lower or equal rev (count rejections and show a tamper warning). Repair must
  compare revs, not just ids. Document in `context/decisions.md` that a brand-new device can still
  be rolled back by a host until it sees a newer rev from a teammate (needs a trusted checkpoint
  or member-signed heads: future work).
- **Tests:** sync draft then accepted revision, replay the old envelope → the observation stays
  accepted and a replay is reported.

---

## Phase 6 — Side items (small, do them)

1. **Public relay abuse (real risk):** the relay always uses the simulated payment watcher
   (`apps/relay/src/main.ts`). Refuse to start with `NEBIUS_API_KEY` or `TAVILY_API_KEY` set
   while the watcher is simulated, unless `RELAY_DEMO=1` is set; in demo mode add a per-quote
   and global daily credit ceiling and bind to 127.0.0.1 or the onion address only. Document in
   the README.
2. **Google Fonts leak the user's IP:** self-host Public Sans and Newsreader (woff2 in
   `apps/web/public/fonts`, `@font-face` in `styles.css`), remove the Google links from
   `index.html`.
3. **Tor dispatchers grow forever:** in `packages/tor/src/transport.ts`, close and delete a
   dispatcher when its call finishes (return a `release()` with `fetchFor`, or use an LRU with
   a cap).
4. **Node engine:** set `engines.node` in the root `package.json` to the version the locked
   dependencies actually need (check `pnpm-lock.yaml` engines; likely `>=22.12`) and say so in
   the README.
5. **README accuracy:** after fixes, update the claims: OpenAI endpoint is a non-streaming text
   adapter (no tools, `stream` ignored); citations are checked for existence, not for factual
   support; list what the privacy log records. Update test counts.

## Phase 7 — Product gaps (after all defects)

Priority order, each as its own small feature with tests:
1. **Review before send** (highest privacy value): a "prepared" state that shows every outbound
   piece and the hidden list, with add/remove "always hide this phrase" controls and an explicit
   Send button. Default on for Paranoid.
2. **Encrypted case backup and import** (export workspace key + records as an encrypted file
   protected by a passphrase; import restores it).
3. **Persistent research history**: store runs and results per case in IndexedDB; show recovered
   results from the daemon.
4. **Full evidence viewer** (expand/download long documents) and align the 100,000-character
   evidence limit with the 20,000-character research context limit (truncate with a visible
   notice, or chunk).
5. **Member removal and key rotation** (new case key, re-seal records for remaining members).
6. **Signed authorship** (per-member signing keys so reviews can't be forged by other members).
7. **Sync-host location in invites** (include the onion URL in the invite fragment, validated on
   join).

## Final acceptance

- Each audit reproduction scenario has a regression test asserting the **correct** behavior.
- `pnpm check` green, web build green, `pnpm smoke:tor` still works.
- Live check with `pnpm dev`: zireh/local makes no relay call; Stop during redaction sends
  nothing; export with hiding on is blocked until reviewed; a dropped mint/settlement reply
  recovers the full balance.
- `context/progress.md` and `context/decisions.md` updated; README claims match behavior.
