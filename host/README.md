# zireh-host

Zireh's single Rust backend. This slice is the sync host (port of the retired TypeScript sync host); the relay
will join it as `src/features/relay` and be merged in `src/main.rs`.

## Run

```
cargo run --release
cargo test
```

## Environment

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `8788` | Listen port. `SYNC_PORT` (the TypeScript host's name) wins if set. |
| `HOST` | `127.0.0.1` | Bind address. `SYNC_HOST_BIND` (the TypeScript host's name) wins if set. Containers set `0.0.0.0`. |
| `SYNC_DB` | `.zireh/sync/sync.db` | SQLite file (`:memory:` allowed). Parent directories are created with mode 0700. Existing databases from the TypeScript host open unchanged. |

`SYNC_ONION` (Tor onion publishing) is not ported yet.

## Routes

| Route | Behaviour |
| --- | --- |
| `GET /health` | `{"ok":true}` (any method) |
| `GET /v1/cases/{caseId}/records?after=N` | Pull up to 500 records after `N`. Header `x-case-token` required. `200 {records, cursor, head}`; 401 bad/missing token, 404 unknown case, 403 wrong token |
| `POST /v1/cases/{caseId}/records` | Push `{records: [1..200 envelopes]}`, body at most 4 MiB. First push registers the token. `200 {cursor}`; 413 too large, 400 invalid records, 401, 403 |
| other methods on that path | `405 {"error":"method not allowed"}` |
| anything else | `404 {"error":"not found"}` |

`caseId` is 32 lowercase hex characters; the token is 64 lowercase hex characters. Exact duplicate
envelopes (same case, id, collection and sealed JSON) are not appended twice. A push body that is not
valid JSON gets a bare `500 Internal Server Error`, as the Node host did.

## Payments (library module)

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
