# zireh-host

Zireh's single backend: one Rust binary serving the sync service (encrypted case records), the relay
(AI calls and web search paid with blind-signed coins) and Zcash payments for top-ups. Each lives in
`src/features/<name>`; `src/main.rs` merges their routers.

Both services replaced TypeScript originals and were checked side by side against them: sync answered
28 requests byte-identically; the relay answered 65 identically, with identical spent coins and stored
replies (the harness is kept outside the repo). Known differences: validation messages are worded
differently from zod's (same status and error code), and a swap whose outputs don't add up is a 400
(client error) instead of the old 503.

## Run

```
cargo run --release
cargo test
```

## Environment

Read from the environment, then from `.env` in the working directory (`ZIREH_ENV_FILE` names
another file). Real environment variables win.

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `8788` | Listen port. `SYNC_PORT` wins if set. |
| `HOST` | `127.0.0.1` | Bind address. `SYNC_HOST_BIND` wins if set. Containers set `0.0.0.0`. |
| `SYNC_DB` | `.zireh/sync/sync.db` | Sync SQLite file. Databases from the TypeScript host open unchanged. |
| `RELAY_DATA_DIR` | `.zireh/relay` | `mint-keys.json`, `relay.db` and (with real payments) `payments.db`. Losing it voids every coin. |
| `LLM_API_KEY` | unset | Key for any OpenAI-compatible provider. Unset: local-dev mode against Ollama. |
| `LLM_BASE_URL` | `https://api.tokenfactory.nebius.com/v1` with a key, `http://127.0.0.1:11434/v1` without | The provider's OpenAI-compatible base URL (`/chat/completions` and `/models` under it). |
| `LLM_MODELS` | two Nemotron models on Token Factory; `nemotron-3-nano:4b` in local-dev | `id:usdIn:usdOut,…` per 1M tokens, or an id alone for $0.30 / $0.90; a 20% margin is added. In local-dev only the first is used. |
| `LLM_EXTRA_BODY` | `{"reasoning_effort":"none"}` in local-dev, nothing otherwise | JSON object merged into every chat request, e.g. `{"reasoning_effort":"minimal"}`. |
| `TAVILY_API_KEY` | unset | Enables `/v1/search`. `TAVILY_URL` overrides the endpoint. `RELAY_SEARCH_PRICE` (9600 credits) sets the price. |
| `RELAY_DEMO` | unset | `1` caps spend per UTC day: `RELAY_DEMO_QUOTE_LIMIT` (5,000,000) and `RELAY_DEMO_DAILY_LIMIT` (20,000,000) credits. Required for paid providers unless payments are real mainnet Zcash. |
| `ZCASH_UFVK` / `ZCASH_UFVK_FILE` | unset | Viewing key for real top-ups (never a spending key). Unset: simulated payments. |
| `ZCASH_NETWORK` | `testnet` | `testnet` or `mainnet`; must match the key. |
| `LIGHTWALLETD_URL` | `https://testnet.zec.rocks:443` / `https://zec.rocks:443` | Chain source for the payment scanner. `ZCASH_BIRTHDAY` sets the first block to scan. |
| `USD_PER_ZEC` | `50` | Fixed rate for quotes. |

## Routes

| Route | Behaviour |
| --- | --- |
| `GET /health` | `{"ok":true}` (any method) |
| `GET /v1/cases/{caseId}/records?after=N` | Pull up to 500 records after `N`. Header `x-case-token` required. `200 {records, cursor, head}`; 401 bad/missing token, 404 unknown case, 403 wrong token |
| `POST /v1/cases/{caseId}/records` | Push `{records: [1..200 envelopes]}`, body at most 24 MiB. First push registers the token. `200 {cursor}`; 413 too large, 400 invalid records, 401, 403 |
| other methods on that path | `405 {"error":"method not allowed"}` |
| `GET /v1/info` | Keyset, prices, search price, `network` (simulated, testnet, mainnet), `upstreamOk` (AI answered its last 15 s check) |
| `POST /v1/topup/quote` | `{credits}` → fresh shielded address, amount in ZEC, ZIP 321 `paymentUri` (real payments), expiry |
| `GET /v1/topup/state?quoteId=` | `{state, received?}`: quoted, paid (seen or partial), confirmed, minted, expired |
| `POST /v1/topup/simulate` | Simulated network only: mark a quote paid |
| `POST /v1/topup/mint` | Blind-sign coins for a confirmed quote; replays return the same signatures |
| `POST /v1/chat`, `POST /v1/search` | Pay with coins, get the answer plus change; a resent `requestId` returns the stored result and never pays twice |
| `POST /v1/swap` | Exchange coins for other denominations |
| `POST /v1/settlement/ack` | The client has its answer; only the money part is kept |
| unknown `/v1/…` | `404 {"error":"not_found","message":"no such route"}`; elsewhere `404 {"error":"not found"}` |

`caseId` is 32 lowercase hex characters; the token is 64 lowercase hex characters. Exact duplicate
envelopes (same case, id, collection and sealed JSON) are not appended twice. A push body that is not
valid JSON gets a bare `500 Internal Server Error`, as the Node host did.

## Payments

`src/features/payments/` is an in-process Zcash payment engine adapted from ZecCheckout (MIT, see
`NOTICE.md` there). It has no HTTP routes; the relay calls it directly. It holds only a Unified Full
Viewing Key (never a spending key), gives each invoice its own shielded (Orchard + Sapling) address,
and watches the chain through a lightwalletd gRPC connection, the only outbound network access.

```rust
let p = Arc::new(Payments::open("payments.db", "testnet", &ufvk, Settings::default())?);
let inv = p.create_invoice(250_000, "order-42", 3600)?;   // id, address, payment_uri, amount_zat, expires_at
let st = p.status(&inv.id)?;                               // pending | underpaid | detected | paid | expired
tokio::spawn(p.clone().run_scanner(default_lightwalletd_url("testnet")?.into(), Duration::from_secs(15), None));
```

Defaults: 3 confirmations, diversifier indices start at 1,000,000, lightwalletd
`https://testnet.zec.rocks:443` / `https://zec.rocks:443`. `payments::keygen::testnet_wallet()` makes a
throwaway testnet seed phrase and UFVK (testnet only).
