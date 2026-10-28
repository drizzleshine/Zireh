# Zireh

**Investigate together. Ask powerful AI. Keep your sources to yourselves.**

Zireh is a collaborative research tool for people who handle sensitive material: journalists,
legal-aid teams, human-rights researchers. A team collects evidence, builds a case board, reviews
each other's findings and publishes a conclusion. When they ask an AI for help, Zireh makes sure
the AI provider learns as little as possible about **who** is asking and **what** the case is.

![What you asked vs. what the provider saw](docs/screenshots/welcome.png)

## The problem

Cloud AI is the most useful research tool there is, and the most dangerous one to paste a source's
name into. A provider sees your IP, your account, your payment details and every word you send, and
can join them into a profile. Local models are private but much weaker. Zireh lets a small local
model protect the question, and a large cloud model answer it.

## What happens when you ask a question

Everything up to "send" runs in your browser, using **NVIDIA Nemotron 3 Nano 4B** on the graphics
card (WebGPU; about 2.5 GB, downloaded once when you turn it on).

| # | Step | What it does |
|---|---|---|
| 1 | **Redact** | Finds names, organizations, places, IDs, contacts and amounts. Each becomes a placeholder with a deliberately vague description ("Lagos" → "a city in West Africa"). Pattern detectors + model extraction + a second classification pass for anything missed. |
| 2 | **Route** | "Local only" stops here and answers in your browser. |
| 3 | **Rewrite / split** | Turns the task into self-contained general questions. Higher levels split it so no single question reveals the whole situation. |
| 4 | **Leak check** | The local model plays the provider: "what could I infer about this person?" Risky pieces are generalized once, then blocked. A deterministic floor blocks any piece containing a hidden value, whatever the model says. |
| 5 | **Decoys** | Plausible cover questions on unrelated topics. Near-duplicates and decoys with odd placeholders are rejected, because they'd point at the real question. |
| 6 | **Send** | Every piece, real or decoy, goes out as **its own request**, paid with **its own unlinkable ecash coins**. |
| 7 | **Reassemble** | Decoy answers are excluded from reassembly; real answers are combined locally with citations checked for existing answer IDs (not factual support), and the hidden names are put back. |

![Research view](docs/screenshots/research.png)

### Privacy levels

| Level | Leaves your computer | Decoys per question | Split |
|---|---|---|---|
| Local only | nothing | – | – |
| Standard | one generalized question | 0 | no |
| Private | several independent questions | 1 | yes |
| Paranoid | same, stricter leak threshold | 3 | yes |

## Who sees what

| | Your browser | Relay | Sync host | AI provider |
|---|---|---|---|---|
| Your IP | ✓ | ✓ | ✓ | – |
| Names, places, case details | ✓ | – | – (ciphertext) | – |
| Generalized question pieces | ✓ | ✓ | – | ✓ |
| Which pieces are decoys / belong together | ✓ | – | – | – |
| Who paid | ✓ | – (blind-signed coins) | – | – |
| Team membership and case files | ✓ | – | ciphertext only | – |

## Collaboration (end-to-end encrypted)

- **Cases** with evidence (notes, documents, links, images), observations, findings, reviews,
  comments, a draggable **case board** with labeled connections, and a **conclusion**
  (resolved / unresolved / disputed) with revisions.
- **Invite links** carry the case key, validated sync-host location, namespace and signature requirement in the URL fragment, which browsers never send to a server.
- **Sync host** stores sealed records in an append-only log. It checks a one-way token so only
  members can write, and never sees a key or plaintext. Devices repair a reset or replaced host
  automatically. Authenticated revisions reject older or repeated records already seen by a device.
- **Images** are re-encoded on your computer before they become evidence, dropping GPS, camera
  and time metadata, and you can mark faces, plates or signs to pixelate them first.
- **Findings page**: export a single self-contained HTML page with a SHA-256 content hash, with
  names hidden (using the same descriptions the AI saw) or shown.
- **Privacy log**: paid research and search requests are recorded before sending, with the complete serialized body, its hash, attempt status and settled cost. Failed attempts remain visible; recovery updates the same request ID.
- **Review before send** pauses a prepared plan for explicit approval; Paranoid enables it by default. Saved hide phrases invalidate a prepared review when changed.
- **Encrypted backups** protect the case key, signing identity, records and research history with a passphrase; imports preserve newer local revisions. Archives are capped at 64 MiB, with oversized exports refused before download.
- **Research history** survives reloads and recovers individual paid answers from the wallet's journal when final synthesis was interrupted.
- **Evidence** can be expanded and downloaded in full. Research shows an explicit notice when it uses a shortened excerpt.
- **Member removal** rotates the case key and sync namespace. Share fresh invites with the remaining members; prior copies remain accessible.
- **Signed authorship** binds new member identities and record revisions to signing keys. Review signatures are visible; old unsigned data stays labeled legacy.
- **Fictional demo case** to try everything without real material.

![Case board](docs/screenshots/board.png)

## Payments: per-token billing without identity

Top-ups are simulated by default: no real ZEC moves, and "Mark as paid" stands in for a payment.
With `ZCASH_UFVK` set, the host instead gives each quote its own shielded address and watches the
chain for it with a viewing key only (testnet unless `ZCASH_NETWORK=mainnet`); it never holds a
spending key.

1. Request a quote and pay it (or mark the simulated payment as paid).
2. The relay issues **blind-signed ecash coins** (Cashu-style BDHKE, verified against the Cashu
   NUT-00 test vectors). The relay can't link coins to the payment or to each other.
3. Each call pays the **worst case** (input bound + `max_tokens`); the relay returns **change**
   as fresh blind-signed coins. You pay exactly per token, with no account.
4. Your client **audits every bill**: it recomputes the cost from the reported usage and flags
   overcharges, including hidden reasoning tokens beyond the cap you set. It also verifies charge-plus-change conservation and retains disputed settlements.
5. Dropped connections never cost twice: calls are idempotent by request id and recovered
   automatically.


Paid-provider demo safety: simulated and testnet coins are free, so with either of them setting
`NEBIUS_API_KEY` or `TAVILY_API_KEY` requires `RELAY_DEMO=1`. Demo top-ups default to at most 5,000,000 credits
per quote and 20,000,000 credits per UTC day. A separate daily budget reserves each provider
call's maximum charge before spending coins. Both daily counters persist across restarts.
`RELAY_DEMO_QUOTE_LIMIT` and `RELAY_DEMO_DAILY_LIMIT` configure those ceilings. This is a capped
demo, not a real Zcash payment service.

## NVIDIA Nemotron and Nebius Token Factory

| Where | Model | Role |
|---|---|---|
| In your browser (WebGPU, transformers.js) | `onnx-community/NVIDIA-Nemotron-3-Nano-4B-BF16-ONNX`, 4-bit | Redaction, hints, classification, rewriting, splitting, leak check, decoys, reassembly. Runs in a Web Worker with reasoning off. Optional: without it, names are hidden by rule and each question goes out whole. |
| Relay → **Nebius Token Factory** | `nvidia/nemotron-3-super-120b-a12b` (default), `nvidia/Llama-3_1-Nemotron-Ultra-253B-v1` | Answers the generalized questions. Called through Token Factory's OpenAI-compatible API (`https://api.tokenfactory.nebius.com/v1`) with the relay's key. |

Without a `NEBIUS_API_KEY` the relay runs in **local-dev mode**: it answers with a local
OpenAI-compatible model (`OLLAMA_URL`, `LOCAL_MODEL`) and says so everywhere (logs, UI, model name). Nothing is ever labeled as Token Factory when
it isn't.

**Tavily** (optional): the relay offers paid web search through Tavily; the browser redacts the
query first and pays for it like any other call.

Research reserves separate coins for the complete plan before sending any question. If needed,
a zero-fee blind swap splits large coins first; interrupted swaps recover from the durable journal.
Up to four pieces run concurrently, each with an independent random 1–3000 ms delay. Real
questions and decoys use the same schedule. Stop releases unsent reservations; submitted calls
still settle. Only one browser tab holds the wallet at a time, so two tabs never spend the same coin.

## Architecture

A monorepo of small packages in strict layers. A package may only import from lower layers;
`pnpm check:layers` enforces it.

| Layer | Packages |
|---|---|
| L0 | `schema` (contracts and validators), `crypto` (hashing, AES-GCM case box, BDHKE) |
| L1 | `llm` (one OpenAI-compatible client for local and cloud models, JSON helper) |
| L3 | `shield` (the privacy pipeline: redact, split, leak check, decoys, live trace) |
| L4 | `wallet` (mint, wallet, pricing, bill audit, ledger) |
| L5 | `relay-client` (paid, idempotent relay client) |
| L7 | `cases` (collaboration domain, publication), `sync` (sealed envelopes) |

| Folder | Runs | Composes |
|---|---|---|
| `app/` | your browser | wallet, privacy pipeline, on-device model (Web Worker), cases, sync, encryption, UI |
| `host/` | server | Rust, one binary: relay, ecash mint, Zcash payments (viewing key only) and sync |

Design notes are kept outside the repo.

## Run it

Requirements: Node 22.19+ within the 22.x line, Node 24.x, or Node 26+, pnpm, and a Rust toolchain (cargo).

```bash
pnpm install
cp .env.example .env          # optional
pnpm dev                      # Rust host on :8788 + the web app on :5173
```

The app calls the host at `http://127.0.0.1:8788`; build it with `VITE_HOST_URL` set to use a
deployed host instead. Coins and the privacy log live in that browser's storage.

```bash
pnpm check        # layer check + typecheck
```

## Measured on an M1 MacBook (8 GB)

Measured with the earlier Ollama setup; the in-browser model has not been timed yet.

| | |
|---|---|
| Local pipeline stage (Nano via Ollama, non-reasoning) | ~1 s each |
| Private-level question, local-dev upstream | 40–180 s (the "cloud" model shares the laptop GPU) |

## Honest limits

- **Real Zcash intake is untested.** It is built (viewing key, per-quote addresses, compact-block
  scanning) but has not yet received a real testnet payment; the default is the labeled
  simulated network.
- **No network anonymity.** Requests leave the browser over plain HTTPS, so the relay and sync
  host see your IP address (not your name, the hidden values or which pieces belong together).
  Use a trusted VPN if your address itself is sensitive.
- **Topic still leaks.** Generalization hides who and where, not what the question is about.
- **Images stay local.** They're stripped and shared with the team, not sent to the AI. Face
  hiding is manual (mark and pixelate); the local model is text-only.
- **The device is the trust boundary.** Case keys, signing keys and coins live unencrypted in this browser's
  storage; protect the computer (disk encryption, screen lock). Clearing the site's data deletes the
  coins, and case backups don't include them yet.
- **Concurrent edits use authenticated record revisions.** Devices reject older or repeated
  versions they have already seen. A newly joined device can still be shown an older authentic
  history until it receives a newer checkpoint from another member. Concurrent edits to the
  same record use a deterministic revision order; they are not merged field by field.
- **Legacy authorship remains unverified.** New cases require per-member signatures; earlier unsigned records cannot be retroactively authenticated. Compare member fingerprints through a trusted channel when identity matters.
- **Invite routing is restricted.** Invite-supplied hosts must be public HTTPS origins: no IP addresses, local names, paths or credentials.
- **Small-model judgment.** Nano 4B can miss a name; that's why there are pattern detectors, a
  second classification pass and a deterministic leak floor. The privacy log shows exactly what
  was sent, so a miss is visible.

## Built for the Nebius × NVIDIA Global AI Hackathon

Track: **Personal AI**. All code in this repository was written during the submission period
(October 2026); see the git history.

### Feedback on the tools

- **Nemotron 3 Nano 4B** is a good fit for on-device privacy work. Turning reasoning off
  (`reasoning_effort: "none"` in Ollama) cut a typical stage from 9.9 s to 1.2 s with the same
  result. Two quirks to know: it copies examples from prompts verbatim (we removed copyable
  examples), and it's better at *classifying* a given list of phrases than *extracting* names
  from free text, so we use both.
- **Reasoning-token billing** needs to be visible to callers. A client that wants to verify its
  bill can count visible output but not hidden reasoning. Reporting
  `completion_tokens_details.reasoning_tokens` consistently would let every client audit costs.
- **Token Factory** being OpenAI-compatible meant one client serves both the local model and the
  cloud, which kept the architecture simple. The docs we found didn't state vision support or
  prompt-caching behavior for Nemotron models; clear statements there would help privacy-sensitive
  designs (we keep images local and isolate cache prefixes per case to be safe).

## License

MIT. See [LICENSE](LICENSE).
