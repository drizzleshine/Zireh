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

Everything up to "send" runs on your computer, using **NVIDIA Nemotron 3 Nano 4B** (via Ollama).

| # | Step | What it does |
|---|---|---|
| 1 | **Redact** | Finds names, organizations, places, IDs, contacts and amounts. Each becomes a placeholder with a deliberately vague description ("Lagos" → "a city in West Africa"). Pattern detectors + model extraction + a second classification pass for anything missed. |
| 2 | **Route** | "Local only" stops here and answers on your computer. |
| 3 | **Rewrite / split** | Turns the task into self-contained general questions. Higher levels split it so no single question reveals the whole situation. |
| 4 | **Leak check** | The local model plays the provider: "what could I infer about this person?" Risky pieces are generalized once, then blocked. A deterministic floor blocks any piece containing a hidden value, whatever the model says. |
| 5 | **Decoys** | Plausible cover questions on unrelated topics. Near-duplicates and decoys with odd placeholders are rejected, because they'd point at the real question. |
| 6 | **Send** | Every piece, real or decoy, goes out on **its own Tor circuit**, paid with **its own unlinkable ecash coins**, to the relay's **onion service**. |
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

| | Your computer | Relay | Sync host | AI provider |
|---|---|---|---|---|
| Your IP | ✓ | – (onion service) | – (onion service) | – |
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
- **Research history** survives reloads and recovers individual paid answers from the daemon when final synthesis was interrupted.
- **Evidence** can be expanded and downloaded in full. Research shows an explicit notice when it uses a shortened excerpt.
- **Member removal** rotates the case key and sync namespace. Share fresh invites with the remaining members; prior copies remain accessible.
- **Signed authorship** binds new member identities and record revisions to signing keys. Review signatures are visible; old unsigned data stays labeled legacy.
- **Fictional demo case** to try everything without real material.

![Case board](docs/screenshots/board.png)

## Use it from any AI tool

The daemon offers a non-streaming OpenAI-compatible text adapter. Editors and scripts that
use plain text chat can route through the privacy pipeline by changing one URL. Tool calls
and vision are unsupported; `stream` is ignored and the adapter returns one JSON response:

```bash
export OPENAI_BASE_URL=http://127.0.0.1:7878/v1
export OPENAI_API_KEY=$(cat .zireh/daemon/local-api-key)   # created on first start, owner-only
# models: zireh/local, zireh/standard, zireh/private, zireh/paranoid
# or pick the level per request with the header  x-zireh-level: private
```

Each request is redacted, generalized, split and decoyed like a research question, sent over
Tor, and answered with names restored. Every request shows up in the privacy log.

## Payments: per-token billing without identity

The current watcher is simulated: no real ZEC moves. The demo exercises quotes, blind minting
and per-token settlements; real chain intake remains unimplemented.

1. Request a quote and mark the simulated payment as confirmed.
2. The relay issues **blind-signed ecash coins** (Cashu-style BDHKE, verified against the Cashu
   NUT-00 test vectors). The relay can't link coins to the payment or to each other.
3. Each call pays the **worst case** (input bound + `max_tokens`); the relay returns **change**
   as fresh blind-signed coins. You pay exactly per token, with no account.
4. Your client **audits every bill**: it recomputes the cost from the reported usage and flags
   overcharges, including hidden reasoning tokens beyond the cap you set. It also verifies charge-plus-change conservation and retains disputed settlements.
5. Dropped connections never cost twice: calls are idempotent by request id and recovered
   automatically.


Paid-provider demo safety: the current payment watcher is simulated. Setting `NEBIUS_API_KEY`
or `TAVILY_API_KEY` requires `RELAY_DEMO=1`. Demo top-ups default to at most 5,000,000 credits
per quote and 20,000,000 credits per UTC day. A separate daily budget reserves each provider
call's maximum charge before spending coins. Both daily counters persist across restarts.
`RELAY_DEMO_QUOTE_LIMIT` and `RELAY_DEMO_DAILY_LIMIT` configure those ceilings. The relay binds
to `127.0.0.1`; optional Tor onion exposure retains that local binding. This is a capped demo,
not a real Zcash payment service.

## NVIDIA Nemotron and Nebius Token Factory

| Where | Model | Role |
|---|---|---|
| On your computer (Ollama) | `nemotron-3-nano:4b` | Redaction, hints, classification, rewriting, splitting, leak check, decoys, reassembly. Runs in non-reasoning mode: each stage takes about 1 s on an M1 instead of about 10 s. |
| Relay → **Nebius Token Factory** | `nvidia/nemotron-3-super-120b-a12b` (default), `nvidia/Llama-3_1-Nemotron-Ultra-253B-v1` | Answers the generalized questions. Called through Token Factory's OpenAI-compatible API (`https://api.tokenfactory.nebius.com/v1`) with the relay's key. |

Without a `NEBIUS_API_KEY` the relay runs in **local-dev mode**: it answers with the local Nano
model and says so everywhere (logs, UI, model name). Nothing is ever labeled as Token Factory when
it isn't.

**Tavily** (optional): the relay offers paid web search through Tavily; the daemon redacts the
query first and sends it over Tor like any other call.

## Architecture

A monorepo of small packages in strict layers. A package may only import from lower layers;
`pnpm check:layers` enforces it.

| Layer | Packages |
|---|---|
| L0 | `schema` (contracts and validators), `crypto` (hashing, AES-GCM case box, BDHKE) |
| L1 | `llm` (one OpenAI-compatible client for local and cloud models, JSON helper) |
| L2 | `redact`, `split`, `leakcheck`, `decoy` (privacy stages) |
| L3 | `shield` (composes the stages into a pipeline with a live trace) |
| L4 | `tor` (circuit-isolated transport, onion services), `wallet` (mint, wallet, pricing, bill audit), `zcash` (payment watcher) |
| L5 | `inference` (paid, idempotent relay client), `relay-core` (relay handler) |
| L6 | `ledger` (run state machine, privacy log) |
| L7 | `cases` (collaboration domain, publication), `sync` (sealed envelopes) |

| App | Runs | Composes |
|---|---|---|
| `apps/daemon` | your computer (127.0.0.1) | local model, shield, Tor, wallet, ledger, sync proxy; serves the UI |
| `apps/web` | your browser | cases, sync, encryption, UI |
| `apps/relay` | server, as an onion service | relay-core, Token Factory, Tavily, mint |
| `apps/sync-host` | server, as an onion service | ciphertext log |

More detail: [`context/architecture.md`](context/architecture.md), design decisions and measured
numbers: [`context/decisions.md`](context/decisions.md).

## Run it

Requirements: Node 22.19+ within the 22.x line, Node 24.x, or Node 26+ (matching the locked Undici and Vitest engines), pnpm, [Ollama](https://ollama.com), Tor (`brew install tor ollama`).

```bash
pnpm install
ollama pull nemotron-3-nano:4b
cp .env.example .env          # optional: paid-provider keys require RELAY_DEMO=1
pnpm dev                      # Tor mode: relay and sync host as onion services
# open http://127.0.0.1:7878, top up (simulated Zcash), try the demo case
```

`pnpm dev --direct` skips Tor for fast local iteration; the UI shows Tor as off.

```bash
pnpm check        # layer check + typecheck + 179 tests
pnpm smoke:tor    # live: three independently isolated requests through Tor
```

## Measured on an M1 MacBook (8 GB)

| | |
|---|---|
| Tor cold bootstrap | ~78 s (first run only) |
| Tor warm bootstrap | 3.4 s |
| HTTPS request on a fresh circuit | 1.0–2.2 s |
| Local pipeline stage (Nano, non-reasoning) | ~1 s each |
| Private-level question, local-dev upstream | 40–180 s (the "cloud" model shares the laptop GPU) |

## Honest limits

- **Zcash intake is simulated.** The relay uses a labeled simulated network; a viewing-key watcher
  on testnet is designed (`zcash.PaymentWatcher`) but not built.
- **Tor helps against passive observers.** An adversary who controls both your guard and the
  relay could correlate timing. A mixnet with constant cover traffic would be stronger.
- **Topic still leaks.** Generalization hides who and where, not what the question is about.
- **Images stay local.** They're stripped and shared with the team, not sent to the AI. Face
  hiding is manual (mark and pixelate); the local model is text-only.
- **The device is the trust boundary.** Case keys, signing keys and coins live unencrypted in this browser's
  storage and the daemon's data folder; protect the computer (disk encryption, screen lock).
- **Concurrent edits use authenticated record revisions.** Devices reject older or repeated
  versions they have already seen. A newly joined device can still be shown an older authentic
  history until it receives a newer checkpoint from another member. Concurrent edits to the
  same record use a deterministic revision order; they are not merged field by field.
- **Legacy authorship remains unverified.** New cases require per-member signatures; earlier unsigned records cannot be retroactively authenticated. Compare member fingerprints through a trusted channel when identity matters.
- **Invite routing is restricted.** Invite-supplied hosts must be v3 onion URLs or localhost/127.0.0.1 development servers.
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
