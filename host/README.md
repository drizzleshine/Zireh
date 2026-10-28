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
