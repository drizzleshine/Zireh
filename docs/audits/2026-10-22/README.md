# Zireh repository audit — 22 October 2026

Reviewed commit: `25d03fa58edc3f46353fe9aad75e1e88e32e5838`.

The review found **11 high-priority defects and 4 additional reliability defects**. The most serious failures concern the product's central promises: selecting local inference, preventing identifying text from leaving, protecting published sources, preserving evidence, and recovering payments. These should be addressed before using the app with sensitive source material.

## Scope and verification

All **148 tracked files** were covered individually: application and package source, tests, manifests, configuration, scripts, documentation, the lockfile, and four reference screenshots. Source was read statement by statement and traced across callers and storage boundaries. See the separate [file-by-file checklist](/Users/kelvx/Dev/projects/hackathons/zireh/docs/audits/2026-10-22/file-by-file.md) for individual notes and file hashes. Dependencies, generated builds, Git internals, ignored credentials, and private runtime data were excluded.

- `pnpm check`: layer check, typecheck, and **110/110 tests passed**. The initial sandboxed attempt could not open the local socket needed by the SOCKS test; the complete run with local socket access passed. [Recorded output](/Users/kelvx/Dev/projects/hackathons/zireh/docs/audits/2026-10-22/baseline-check.txt).
- `pnpm --filter @zireh/web build`: passed.
- Ran isolated reproductions against the actual privacy, payment, daemon, sync-host, and browser-store code. Scripted models, simulated credits, an in-memory sync host, and disposable cases were used. No real payment or paid provider request was made.
- Inspected the built app in the browser: demo case, evidence entry, finding reviews, board, conclusion/export, and privacy log. Confirmed the stale board and unsafe export state in the running UI.
- Live Ollama/Nemotron behavior, a live Tor connection, Nebius/Tavily availability, real Zcash intake, and dependency vulnerability advisories were not assessed. This is a source and behavior audit, not a guarantee that every possible defect has been found.

P1 means a high-priority fix because it can expose information, lose data/credits, or break the stated trust model. P2 means a material reliability problem. No P0 emergency or demonstrated real-world compromise was established.

## Findings

### F01 · P1 — `zireh/local` requests are routed to the cloud

**Location:** [daemon API](/Users/kelvx/Dev/projects/hackathons/zireh/apps/daemon/src/api.ts:65), lines 65–71.

The compatibility endpoint derives privacy level only from `x-zireh-level`, defaulting to `standard`. It does not interpret the advertised `model: "zireh/local"`. The model string is passed to `cloudModel()`, which does not recognize it as an offered upstream model and silently selects the first cloud model. A client following the README's model-selection instructions can therefore send material outside the device while explicitly selecting local inference.

**Reproduction:** a funded compatibility request with `model: "zireh/local"`, no level header, and a plaintext message generated **one cloud call** and returned `model: "zireh/standard"` (R3).

**Fix:** derive level from supported `zireh/<level>` model IDs, validate any header override, and reject contradictory/unknown selections. Add a test proving that the advertised local model makes zero relay calls.

### F02 · P1 — Correctly identified lowercase and uncased names are discarded

**Location:** [redaction plausibility filter](/Users/kelvx/Dev/projects/hackathons/zireh/packages/redact/src/redact.ts:38), lines 38–40 and 74–79.

Person, organization, and place entities require an uppercase Unicode character. Even when the local model correctly identifies `ada obi` or `张伟` as a person, the code discards the detection. The capitalized-phrase fallback cannot recover those inputs. They also never enter the pseudonym table, so the deterministic leak floor cannot protect them. The search route sends the redactor's result directly to the relay.

**Reproduction:** a model returning the correct person entity for either input produced an empty table and unchanged identifying text (R1). This establishes a deterministic filter defect; it does not assume every cloud rewrite will preserve the name.

**Fix:** do not use capitalization as an identity requirement. Retain validated model detections across writing systems and casing, and test the search and cloud paths with such names.

### F03 · P1 — Decoys bypass the final privacy checks

**Location:** [piece construction](/Users/kelvx/Dev/projects/hackathons/zireh/packages/shield/src/shield.ts:149), lines 149–150.

Only real questions pass redaction and leak checking. Generated decoys are placed directly into outbound messages. The decoy filters check length, similarity, and placeholders, but never check the case's hidden values. An ordinary generated question can therefore contain a value already marked sensitive, bypassing the deterministic guard entirely.

**Reproduction:** with `Lagos` in the hidden-value table, a generated travel decoy containing `Lagos` was accepted into the outbound plan unchanged (R2). This is a missing guard, not a claim about how often Nano generates that particular decoy.

**Fix:** run the same final hidden-value check on every serialized outbound piece, including decoys. Reject/regenerate unsafe decoys before sending any part of the plan.

### F04 · P1 — Stop does not stop future disclosure or spending

**Location:** [daemon research stream](/Users/kelvx/Dev/projects/hackathons/zireh/apps/daemon/src/api.ts:142), lines 142–155; [Stop button](/Users/kelvx/Dev/projects/hackathons/zireh/apps/web/src/components/ResearchPanel.tsx:185).

Stop aborts the browser's fetch. The server deliberately continues `runResearch()` after a disconnect and has no cancellation signal or cancellation endpoint. This also applies while the first local redaction call is still running, before any paid call has been prepared. The explanation that calls are already paid does not hold at that point. The app can send and spend after the user has pressed Stop, and the answer is then detached from the UI.

**Reproduction:** cancelled the response stream while the first redaction step was paused; after releasing that step, **one cloud call still executed** (X1).

**Fix:** give runs an explicit cancellation lifecycle. Stop local work and prevent unsent pieces from being submitted. Settle already-submitted calls separately, retain their results, and explain that distinction in the interface.

### F05 · P1 — Hidden-name export misses fields and can export unhidden sources

**Location:** [publication scan](/Users/kelvx/Dev/projects/hackathons/zireh/apps/web/src/components/ConcludePanel.tsx:137), lines 137–139; [exported evidence titles](/Users/kelvx/Dev/projects/hackathons/zireh/packages/cases/src/publication.ts:58).

The scan collects case/conclusion/finding/observation text but omits cited evidence titles, even though those titles are included in the export. A source named only in an evidence title is never presented to the scanner. In addition, hiding defaults to enabled and download remains enabled when the pseudonym table is empty. A case that has never run research can export raw names while the JSON says `namesHidden: true` and the HTML says names were generalized.

**Reproduction:** `Confidential interview with Ada Obi` was absent from all scan inputs but remained in an export marked `namesHidden: true` (X2). In the browser, a new conclusion containing `Mara Venn` and `Harbor Ledger` remained unhidden with hiding checked and download enabled.

**Fix:** scan every text field in the exact publication snapshot, including evidence titles; invalidate the scan after edits; show the complete final output; distinguish a requested hiding option from a completed redaction review. Require explicit review before exporting a page represented as anonymized.

![Hiding checked, source names visible, export enabled](/Users/kelvx/Dev/projects/hackathons/zireh/docs/audits/2026-10-22/publication-unhidden.png)

### F06 · P1 — A lost top-up mint reply permanently strands the top-up

**Location:** [top-up client](/Users/kelvx/Dev/projects/hackathons/zireh/packages/inference/src/client.ts:134), lines 134–143; [mint route](/Users/kelvx/Dev/projects/hackathons/zireh/packages/relay-core/src/relay.ts:200), lines 200–210.

Top-up blinding secrets exist only in memory. The relay marks the quote minted before the response arrives, but does not persist an idempotent mapping from the mint request to its signatures. If the reply is lost, retrying creates fresh blinded outputs and is rejected because the quote is already minted. Unlike paid inference, there is no pending top-up journal or recovery path.

**Reproduction:** dropped one successful mint response. Wallet balance stayed **0**, quote state became `minted`, retry returned `quote_unpaid`, and there were no pending calls to recover (R5).

**Fix:** persist quote, outputs, and blinding secrets before minting; replay the same mint request; atomically store quote state and the matching signature response on the relay.

### F07 · P1 — Recovery expires while the spent-coin rejection remains permanent

**Location:** [response retention](/Users/kelvx/Dev/projects/hackathons/zireh/apps/relay/src/storage.ts:57), lines 57–69; [client handling](/Users/kelvx/Dev/projects/hackathons/zireh/packages/inference/src/client.ts:199), lines 199–205.

Settlement responses and crash markers expire after 15 minutes. Spent secrets are retained indefinitely. A laptop sleeping or staying offline past the response TTL cannot recover a lost reply: replay finds no response, then fails because the original coins are spent. The client removes the pending entry after that error, losing its automated recovery path. The loss can be far larger than the actual call cost because coin selection overpays the hold.

**Reproduction:** after a lost response and a simulated 16-minute delay, recovery returned `token_spent`, removed the pending call, and failed to restore **524,288 credits** from a 1,000,000-credit wallet (R4).

**Fix:** separate short-lived answer retention from durable settlement/refund obligations. Keep replayable settlement material or an acknowledged claim until recovery is complete; retain unresolved client records.

### F08 · P1 — The bill audit does not check whether change was returned

**Location:** [client settlement](/Users/kelvx/Dev/projects/hackathons/zireh/packages/inference/src/client.ts:190), lines 190–193 and 212–215.

The client accepts any schema-valid change array and checks the relay's declared `charged` value against reported usage. It never verifies `sum(input proofs) - sum(change) === charged`. A faulty or malicious relay can omit all change, report a small honest charge, and still pass the audit. The advertised protection against overcharging therefore misses the largest part of the monetary transfer.

**Reproduction:** removed change signatures from an otherwise valid response. The wallet lost **524,288 credits**, the relay reported a **4-credit** charge, and `bill.overcharged` remained **false** (R6).

**Fix:** validate request/settlement identity and conservation of value before removing pending state or crediting outputs. Treat invalid, missing, or mismatched change as unresolved settlement. Cryptographic validation of returned signatures is also needed for a stronger untrusted-mint model.

### F09 · P1 — Wallet and relay recovery records are not atomic with money movements

**Location:** [client preparation](/Users/kelvx/Dev/projects/hackathons/zireh/packages/inference/src/client.ts:177), lines 177–181; [client settlement](/Users/kelvx/Dev/projects/hackathons/zireh/packages/inference/src/client.ts:213), lines 213–215; [relay burn/marker](/Users/kelvx/Dev/projects/hackathons/zireh/packages/relay-core/src/relay.ts:117), lines 117–118.

The client removes coins before saving the pending call, and removes the pending call before saving change. Atomic replacement of each JSON file does not make those cross-file changes atomic. A crash or write failure between the operations can leave no coins and no recovery record. The relay also commits spent secrets separately from its crash marker. A failure between those writes leaves burned coins with no refund obligation recorded.

**Reproduction:** injected a pending-store write failure after coin selection. A **1,048,576-credit** wallet became **0**, with **zero** pending calls (R8). The settlement and relay windows are directly visible in the ordering above.

**Fix:** use transactions covering wallet proofs and pending calls, and transactions covering relay spends and request state. Preserve the recovery journal until the corresponding wallet update has committed durably.

### F10 · P1 — Separate tabs can overwrite unsynced evidence and its outbox

**Location:** [browser persistence](/Users/kelvx/Dev/projects/hackathons/zireh/apps/web/src/store.ts:59), lines 59–71 and 149–157.

Each tab loads its own in-memory copy, then replaces whole workspace and case values in IndexedDB. There is no version check, merge transaction, single-writer lock, or cross-tab state notification. Two tabs editing while sync is unavailable can overwrite each other's persisted case and outbox. Closing the tab with the overwritten in-memory change loses that evidence permanently.

**Reproduction:** tab A saved offline evidence; tab B, loaded earlier, saved different offline evidence. Reload showed **only tab B's evidence**, and tab A's encrypted outbox entry was absent (S1). The reproduction uses cloned in-memory IndexedDB values to model the actual read/write behavior, without relying on shared object references.

**Fix:** persist records/outbox entries individually in transactions and coordinate tabs using revisions plus a lock or a single writer. Merge concurrent writes and notify other tabs.

### F11 · P1 — An untrusted sync host can replay old valid records to undo reviews

**Location:** [record encryption context](/Users/kelvx/Dev/projects/hackathons/zireh/packages/sync/src/index.ts:27), lines 27–41; [last-arrival application](/Users/kelvx/Dev/projects/hackathons/zireh/apps/web/src/store.ts:140), lines 140–145 and 250–258.

AES-GCM binds a record to collection and ID, but not to an authenticated version or causal history. The browser treats the last server-ordered instance of that ID as current. A host does not need the case key to append an older ciphertext with a new sequence number. This can undo an acceptance/rejection or restore an older case value without any tamper warning, contradicting the explicit untrusted-host model. The ID-only repair algorithm also cannot detect a missing newer revision if an older instance of the ID exists.

**Reproduction:** synced a draft and then its accepted revision; replayed the original encrypted draft through the actual store sync path. The observation changed from **accepted** back to **draft** (S3).

**Fix:** authenticate versions and causal predecessors, reject known stale/replayed operations, and detect divergent histories. Merely trusting a new server sequence number is insufficient; a fresh-device rollback defense also needs a trusted checkpoint or peer verification.

### F12 · P2 — Sufficient total balance does not guarantee enough coins for parallel pieces

**Location:** [plan funding check](/Users/kelvx/Dev/projects/hackathons/zireh/apps/daemon/src/research.ts:69), lines 69–78; [largest-first selection](/Users/kelvx/Dev/projects/hackathons/zireh/packages/wallet/src/wallet.ts:87).

The plan checks the sum of holds against total balance, but each call takes whole coins, largest first. A wallet represented by one large coin can fund only the first concurrent call until change arrives. Another worker then throws outside the per-call error handler, aborting the plan while the first call continues and incurs cost.

**Reproduction:** a 1,048,576-credit wallet attempting a two-piece private plan failed with `need 718 credits, have 0`, while **one cloud request still ran and charged** (R9).

**Fix:** reserve a feasible coin allocation for the whole plan, split/swap coins first, or schedule based on available denominations and returned change. Preserve completed partial answers instead of discarding the whole run.

### F13 · P2 — The privacy log omits some payloads that actually left

**Location:** [recording after success](/Users/kelvx/Dev/projects/hackathons/zireh/apps/daemon/src/research.ts:89), lines 89–111; [background recovery](/Users/kelvx/Dev/projects/hackathons/zireh/apps/daemon/src/main.ts:63).

Receipts are written only after a successful reply. If an upstream sees a prompt and then fails, the call produces no receipt. Background recovery also does not update receipts or the research result. This makes “Everything this computer has sent” and the call/spend summary incomplete, especially after network failures. The current receipt stores a preview rather than the complete serialized request, so it also does not independently establish every claimed wire byte.

**Reproduction:** upstream received one prompt and then threw; the ledger contained **zero receipts** (R7).

**Fix:** durably record the intended serialized payload and request identity before sending, distinguish attempted/confirmed delivery, and update the same record on failure, settlement, and recovery. Keep enough payload data to recompute the displayed hash.

### F14 · P2 — Store mutation leaves the open board stale after sync

**Location:** [store snapshots](/Users/kelvx/Dev/projects/hackathons/zireh/apps/web/src/store.ts:51), lines 51–55 and 127–145; [board memo](/Users/kelvx/Dev/projects/hackathons/zireh/apps/web/src/components/BoardPanel.tsx:34).

Records mutate in place. A selector returning a case or workspace keeps the same snapshot identity, so `useSyncExternalStore` does not trigger a render for those changes. Status polling masks some of the problem by causing unrelated parent renders, but the board memo depends on the unchanged case object and never rebuilds its cards.

**Reproduction:** added evidence in a second browser tab. The first tab's header updated to **Evidence 4**, but its already-open board still showed the original **three evidence cards** and no new card. The store reproduction also confirmed identical snapshot references (S2).

**Fix:** produce immutable, versioned snapshots for changed cases/workspaces and derive board cards from changing collection references or versions.

### F15 · P2 — Large queued sync batches get stuck permanently

**Location:** [count-only batching](/Users/kelvx/Dev/projects/hackathons/zireh/apps/web/src/store.ts:228), lines 228–231; [host body limit](/Users/kelvx/Dev/projects/hackathons/zireh/apps/sync-host/src/host.ts:70).

The client batches up to 200 envelopes without measuring bytes, while the host rejects bodies over 4 MiB. Multiple individually valid documents/images accumulated offline can exceed that limit. Every retry sends the same oversized batch, so it blocks all subsequent outbox records too. Encryption/base64 expansion makes this threshold easier to cross.

**Reproduction:** two sealed documents, each below the evidence schema's body limit, produced a **4,267,753-byte** batch and HTTP **413**. A single envelope succeeded with HTTP **200** (Y1).

**Fix:** batch by serialized byte size as well as record count, detect/recover from 413, and validate the maximum individual envelope size before saving it as syncable evidence.

## Important functionality missing from the app

These are product gaps rather than claims that an already-documented prototype feature is secretly implemented incorrectly.

| Gap | Why it matters | Evidence / suggested direction |
|---|---|---|
| Encrypted case backup, import, and key recovery | Browser storage and the case key are the only local recovery path; clearing a profile or losing a device can make ciphertext unrecoverable. | Store exposes create/join/save/sync, with no workspace backup/import workflow. Findings HTML is a publication, not a restorable case backup. |
| Member removal, invite revocation/expiry, and key rotation | An invite grants the same enduring shared case key; there is no way to stop a former member receiving future case material. | Invite contains only case ID/key; sync capability is derived from that same key. Rotation can protect future data, but cannot erase copies already received. |
| Authenticated authorship and edit history | Everyone holding a case key can write a review or observation claiming another member's ID. Sensitive findings need attributable review decisions. | Shared symmetric encryption authenticates membership, not an individual author. Consider per-member signing keys and explicit revision history. |
| Cross-device shared-host setup | Invites contain no sync-host location; generated URLs use the sender's loopback origin. Independently running the documented dev stack creates separate sync hosts. | `SYNC_URL` can be configured manually, but the app supplies no host-selection/join setup workflow. Include a validated host locator in the invitation/setup experience. |
| Persistent research history and recovery results | Refreshing loses the latest answer/draft in the module-level `slots` map; daemon recovery returns counts and balance, while the recovered answer is discarded. | Persist runs/results with case association and surface recovery, partial completion, and retry status. |
| Review/edit before sending and a manual “always hide this phrase” control | Automatic extraction inevitably misses some values; users currently see the prepared plan while it proceeds to send. | Provide a reviewable prepared state with add/remove redaction controls and a clear send action, especially at the highest privacy level. |
| Full evidence viewer/export | The evidence list truncates document bodies after 900 characters and has no expand/open/download control. | Users can store and ask about text that they cannot inspect in full through the UI. Also align the 100,000-character evidence input with the research API's 20,000-character context limit. |
| Production payment/abuse controls | The relay always uses the simulated watcher, including when real Nebius/Tavily keys are set. Anyone who can reach that demo relay can mint simulated credit and consume the operator's paid API quota. | Real Zcash intake is already disclosed as unbuilt. Add an explicit demo/public mode boundary, spending ceilings and admission controls before offering a publicly reachable paid-provider relay. |
| Clear compatibility contract for AI tools | The endpoint always returns a non-streaming text result; it ignores `stream`, role semantics, tool calls, and most generation options, while advertising general OpenAI compatibility. | Implement the supported client requirements or clearly document the narrower text adapter. F01 must be fixed regardless. |
| Browser integration and privacy evaluation tests | Existing tests are green while these user-visible failures remain. Most privacy tests use scripted model replies, and there are no web-store or component integration tests. | Add regression tests for the findings, cross-tab/offline synchronization, export coverage, model-level routing, cancellation, and real local-model multilingual redaction evaluation. |

Other review observations: self-host the Google Fonts assets if the interface is meant to avoid direct third-party browser requests; dispose old Tor dispatchers rather than retaining every circuit tag forever; align the declared Node engine with the stricter versions required by the locked dependencies. These were not counted among the high-priority defects.

The README already discloses simulated Zcash, manual image hiding, plaintext storage on the trusted device, topic/timing leakage, and union-only pseudonym merging. Those explicit prototype limits were not counted as newly discovered bugs. Citation validation checks label existence, not whether the cited answer actually supports a claim; avoid presenting that as factual verification.

## Reproductions and next steps

Run the diagnostic scripts from the repository root. They use only test data and existing installed dependencies. Their assertions intentionally confirm the audited defects; after a fix, replace the relevant assertions with tests for the desired behavior.

```sh
node --import tsx docs/audits/2026-10-22/reproduce-core.mts
node --import tsx docs/audits/2026-10-22/reproduce-privacy.mts
node --import tsx docs/audits/2026-10-22/reproduce-store.mts
node --import tsx docs/audits/2026-10-22/reproduce-sync-size.mts
```

Recorded results: [core](/Users/kelvx/Dev/projects/hackathons/zireh/docs/audits/2026-10-22/core-results.json), [privacy/export](/Users/kelvx/Dev/projects/hackathons/zireh/docs/audits/2026-10-22/privacy-results.json), [store](/Users/kelvx/Dev/projects/hackathons/zireh/docs/audits/2026-10-22/store-results.json), [sync size](/Users/kelvx/Dev/projects/hackathons/zireh/docs/audits/2026-10-22/sync-size-results.json).

Recommended order: (1) enforce local routing and a final outbound privacy gate; (2) implement effective cancellation and safe publication review; (3) make money operations transactional and recoverable, with settlement conservation checks; (4) fix browser persistence, replay handling, and immutable snapshots; (5) add key/member lifecycle and backup/recovery workflows.

Application source was left unchanged. The only repository additions are this audit, the individual-file checklist, diagnostic reproductions, recorded output, and two screenshots.
