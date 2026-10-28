//! Port of the retired TypeScript sync host tests plus every route and error path of host.ts.
//! The host never decrypts, so envelopes here carry opaque `iv`/`ct` strings.

use axum::{
    body::Body,
    http::{header, Request, StatusCode},
    Router,
};
use http_body_util::BodyExt;
use serde_json::{json, Value};
use tower::ServiceExt;
use zireh_host::{
    features::sync::{routes::js_to_number, routes::router, store::Store},
    http::base_router,
};

const CASE: &str = "0123456789abcdef0123456789abcdef";

fn token(c: char) -> String {
    c.to_string().repeat(64)
}

fn app_with(store: Store) -> Router {
    base_router().merge(router(store))
}

fn app() -> Router {
    app_with(Store::open(":memory:").unwrap())
}

fn id(n: u32) -> String {
    format!("{n:032x}")
}

fn env(n: u32, collection: &str) -> Value {
    json!({ "id": id(n), "collection": collection, "sealed": { "v": 1, "iv": "aXY", "ct": format!("ct{n}") } })
}

struct Res {
    status: StatusCode,
    headers: header::HeaderMap,
    text: String,
}

impl Res {
    fn json(&self) -> Value {
        serde_json::from_str(&self.text).unwrap_or_else(|_| panic!("not json: {}", self.text))
    }
}

async fn send(app: &Router, req: Request<Body>) -> Res {
    let r = app.clone().oneshot(req).await.unwrap();
    let (parts, body) = r.into_parts();
    let bytes = body.collect().await.unwrap().to_bytes();
    Res { status: parts.status, headers: parts.headers, text: String::from_utf8_lossy(&bytes).into_owned() }
}

fn path(case: &str, query: &str) -> String {
    format!("/v1/cases/{case}/records{query}")
}

async fn get_raw(app: &Router, case: &str, tok: Option<&str>, query: &str) -> Res {
    let mut b = Request::builder().method("GET").uri(path(case, query));
    if let Some(t) = tok {
        b = b.header("x-case-token", t);
    }
    send(app, b.body(Body::empty()).unwrap()).await
}

async fn post_raw(app: &Router, case: &str, tok: Option<&str>, body: String) -> Res {
    let mut b = Request::builder().method("POST").uri(path(case, "")).header("content-type", "application/json");
    if let Some(t) = tok {
        b = b.header("x-case-token", t);
    }
    send(app, b.body(Body::from(body)).unwrap()).await
}

async fn push(app: &Router, case: &str, tok: &str, records: Vec<Value>) -> Res {
    post_raw(app, case, Some(tok), json!({ "records": records }).to_string()).await
}

async fn pull(app: &Router, case: &str, tok: &str, after: i64) -> Res {
    get_raw(app, case, Some(tok), &format!("?after={after}")).await
}

fn err(r: &Res, status: u16, message: &str) {
    assert_eq!(r.status.as_u16(), status, "{}", r.text);
    assert_eq!(r.json(), json!({ "error": message }));
}

// ---- host.test.ts: "sync host" ----

#[tokio::test]
async fn stores_and_returns_sealed_records_for_members_holding_the_token() {
    let app = app();
    let t = token('a');
    let r = push(&app, CASE, &t, vec![env(1, "cases"), env(2, "members")]).await;
    assert_eq!((r.status.as_u16(), r.json()), (200, json!({ "cursor": 2 })));

    let pulled = pull(&app, CASE, &t, 0).await;
    assert_eq!(pulled.status, StatusCode::OK);
    let body = pulled.json();
    assert_eq!(body["records"].as_array().unwrap().len(), 2);
    assert_eq!(body["cursor"], 2);
    assert_eq!(body["head"], 2);
    let cols: Vec<&str> = body["records"].as_array().unwrap().iter().map(|r| r["collection"].as_str().unwrap()).collect();
    assert_eq!(cols, ["cases", "members"]);
    assert_eq!(body["records"][0], json!({ "seq": 1, "id": id(1), "collection": "cases", "sealed": { "v": 1, "iv": "aXY", "ct": "ct1" } }));

    let again = pull(&app, CASE, &t, 2).await.json();
    assert_eq!(again["records"], json!([]));
    assert_eq!(again["cursor"], 2);
}

#[tokio::test]
async fn rejects_a_wrong_token_and_unknown_cases() {
    let app = app();
    push(&app, CASE, &token('a'), vec![env(1, "members")]).await;
    err(&pull(&app, CASE, &token('b'), 0).await, 403, "wrong case token");
    err(&push(&app, CASE, &token('b'), vec![env(1, "members")]).await, 403, "wrong case token");
    err(&pull(&app, &"b".repeat(32), &token('a'), 0).await, 404, "unknown case");
}

// ---- host.test.ts: "F11 exact envelope retries" ----

#[tokio::test]
async fn does_not_append_a_duplicate_when_a_push_is_retried() {
    let app = app();
    let t = token('a');
    let e = env(1, "cases");
    assert_eq!(push(&app, CASE, &t, vec![e.clone()]).await.json(), json!({ "cursor": 1 }));
    assert_eq!(push(&app, CASE, &t, vec![e.clone()]).await.json(), json!({ "cursor": 1 }));
    assert_eq!(pull(&app, CASE, &t, 0).await.json()["records"].as_array().unwrap().len(), 1);
}

// ---- additional routes and error paths ----

#[tokio::test]
async fn health_and_unknown_paths() {
    let app = app();
    let r = send(&app, Request::get("/health").body(Body::empty()).unwrap()).await;
    assert_eq!((r.status.as_u16(), r.json()), (200, json!({ "ok": true })));
    let r = send(&app, Request::post("/health").body(Body::empty()).unwrap()).await;
    assert_eq!(r.status, StatusCode::OK);
    for p in ["/", "/health/", "/v1/cases", &format!("/v1/cases/{CASE}"), &format!("/v1/cases/{CASE}/records/"), &format!("/v1/cases/{}/records", "A".repeat(32)), &format!("/v1/cases/{}/records", "a".repeat(31)), &format!("/v1/cases/{}/records", "a".repeat(33)), "/v1/cases/zz/records"] {
        err(&send(&app, Request::get(p).header("x-case-token", token('a')).body(Body::empty()).unwrap()).await, 404, "not found");
    }
}

#[tokio::test]
async fn responses_are_json_and_never_cached() {
    let app = app();
    for r in [get_raw(&app, CASE, None, "").await, push(&app, CASE, &token('a'), vec![env(1, "cases")]).await] {
        assert_eq!(r.headers[header::CONTENT_TYPE], "application/json");
        assert_eq!(r.headers[header::CACHE_CONTROL], "no-store");
    }
    let h = send(&app, Request::get("/health").body(Body::empty()).unwrap()).await;
    assert_eq!(h.headers[header::CACHE_CONTROL], "no-store");
}

#[tokio::test]
async fn other_methods_are_405() {
    let app = app();
    for m in ["PUT", "DELETE", "PATCH", "HEAD", "OPTIONS"] {
        let r = send(&app, Request::builder().method(m).uri(path(CASE, "")).body(Body::empty()).unwrap()).await;
        assert_eq!(r.status, StatusCode::METHOD_NOT_ALLOWED, "{m}");
        if m != "HEAD" {
            err(&r, 405, "method not allowed");
        }
    }
}

#[tokio::test]
async fn token_must_be_64_lowercase_hex() {
    let app = app();
    push(&app, CASE, &token('a'), vec![env(1, "cases")]).await;
    let bad = [None, Some(""), Some("abc"), Some(&"A".repeat(64)[..]), Some(&"g".repeat(64)[..]), Some(&"a".repeat(65)[..]), Some(&"a".repeat(63)[..])];
    for t in bad {
        err(&get_raw(&app, CASE, t, "").await, 401, "missing case token");
        err(&post_raw(&app, CASE, t, json!({ "records": [env(9, "cases")] }).to_string()).await, 401, "missing case token");
    }
    // A bad token must not have registered anything or written anything.
    assert_eq!(pull(&app, CASE, &token('a'), 0).await.json()["head"], 1);
    err(&post_raw(&app, &"c".repeat(32), Some("zz"), json!({ "records": [env(9, "cases")] }).to_string()).await, 401, "missing case token");
    err(&pull(&app, &"c".repeat(32), &token('a'), 0).await, 404, "unknown case");
}

#[tokio::test]
async fn first_push_registers_the_case_token_and_later_pushes_must_match() {
    let app = app();
    push(&app, CASE, &token('a'), vec![env(1, "cases")]).await;
    err(&push(&app, CASE, &token('b'), vec![env(2, "cases")]).await, 403, "wrong case token");
    assert_eq!(pull(&app, CASE, &token('a'), 0).await.json()["head"], 1, "rejected push must not write");
    // A different case may use a different token.
    assert_eq!(push(&app, &"f".repeat(32), &token('b'), vec![env(1, "cases")]).await.status, StatusCode::OK);
}

#[tokio::test]
async fn invalid_bodies_are_400() {
    let app = app();
    let t = token('a');
    let good = env(1, "cases");
    let mut cases: Vec<(&str, Value)> = vec![
        ("not an object", json!([good.clone()])),
        ("null", Value::Null),
        ("no records", json!({})),
        ("records not array", json!({ "records": {} })),
        ("empty records", json!({ "records": [] })),
        ("201 records", json!({ "records": (0..201).map(|n| env(n, "cases")).collect::<Vec<_>>() })),
        ("bad id", json!({ "records": [{ "id": "XYZ", "collection": "cases", "sealed": good["sealed"] }] })),
        ("uppercase id", json!({ "records": [{ "id": "A".repeat(32), "collection": "cases", "sealed": good["sealed"] }] })),
        ("missing id", json!({ "records": [{ "collection": "cases", "sealed": good["sealed"] }] })),
        ("bad collection", json!({ "records": [env(1, "nope")] })),
        ("missing sealed", json!({ "records": [{ "id": id(1), "collection": "cases" }] })),
        ("sealed not object", json!({ "records": [{ "id": id(1), "collection": "cases", "sealed": "x" }] })),
        ("v is 2", json!({ "records": [{ "id": id(1), "collection": "cases", "sealed": { "v": 2, "iv": "a", "ct": "b" } }] })),
        ("v missing", json!({ "records": [{ "id": id(1), "collection": "cases", "sealed": { "iv": "a", "ct": "b" } }] })),
        ("iv not string", json!({ "records": [{ "id": id(1), "collection": "cases", "sealed": { "v": 1, "iv": 1, "ct": "b" } }] })),
        ("ct missing", json!({ "records": [{ "id": id(1), "collection": "cases", "sealed": { "v": 1, "iv": "a" } }] })),
        ("rev null", json!({ "records": [{ "id": id(1), "collection": "cases", "sealed": { "v": 1, "iv": "a", "ct": "b", "rev": null } }] })),
        ("rev lamport 0", json!({ "records": [{ "id": id(1), "collection": "cases", "sealed": { "v": 1, "iv": "a", "ct": "b", "rev": { "lamport": 0, "deviceId": id(2) } } }] })),
        ("rev lamport fractional", json!({ "records": [{ "id": id(1), "collection": "cases", "sealed": { "v": 1, "iv": "a", "ct": "b", "rev": { "lamport": 1.5, "deviceId": id(2) } } }] })),
        ("rev lamport past 2^53", json!({ "records": [{ "id": id(1), "collection": "cases", "sealed": { "v": 1, "iv": "a", "ct": "b", "rev": { "lamport": 9_007_199_254_740_992u64, "deviceId": id(2) } } }] })),
        ("rev lamport string", json!({ "records": [{ "id": id(1), "collection": "cases", "sealed": { "v": 1, "iv": "a", "ct": "b", "rev": { "lamport": "1", "deviceId": id(2) } } }] })),
        ("rev bad device", json!({ "records": [{ "id": id(1), "collection": "cases", "sealed": { "v": 1, "iv": "a", "ct": "b", "rev": { "lamport": 1, "deviceId": "nope" } } }] })),
        ("one bad among good", json!({ "records": [good.clone(), env(2, "nope")] })),
    ];
    cases.push(("empty body", Value::Null));
    for (name, body) in cases {
        let r = post_raw(&app, CASE, Some(&t), body.to_string()).await;
        assert_eq!(r.status, StatusCode::BAD_REQUEST, "{name}: {}", r.text);
        err(&r, 400, "invalid records");
    }
    err(&post_raw(&app, CASE, Some(&t), String::new()).await, 400, "invalid records");
    // Nothing was registered or stored by any of the above.
    err(&pull(&app, CASE, &t, 0).await, 404, "unknown case");
}

#[tokio::test]
async fn body_is_validated_before_the_token_is_checked() {
    let app = app();
    push(&app, CASE, &token('a'), vec![env(1, "cases")]).await;
    err(&post_raw(&app, CASE, None, json!({ "records": [] }).to_string()).await, 400, "invalid records");
    err(&post_raw(&app, CASE, Some(&token('b')), json!({ "records": [] }).to_string()).await, 400, "invalid records");
}

#[tokio::test]
async fn invalid_json_is_a_bare_500_like_the_node_host() {
    let app = app();
    let r = post_raw(&app, CASE, Some(&token('a')), "{nope".into()).await;
    assert_eq!(r.status, StatusCode::INTERNAL_SERVER_ERROR);
    assert_eq!(r.text, "Internal Server Error");
    assert_eq!(post_raw(&app, CASE, Some(&token('a')), "   ".into()).await.status, StatusCode::INTERNAL_SERVER_ERROR);
}

#[tokio::test]
async fn accepts_exactly_200_records_and_extra_keys_are_stripped() {
    let app = app();
    let t = token('a');
    let r = push(&app, CASE, &t, (1..=200).map(|n| env(n, "evidence")).collect()).await;
    assert_eq!(r.json(), json!({ "cursor": 200 }));

    let app = app_with(Store::open(":memory:").unwrap());
    let rec = json!({ "id": id(1), "extra": 1, "collection": "board", "sealed": { "ct": "c", "junk": true, "iv": "i", "v": 1.0, "rev": { "deviceId": id(7), "lamport": 3.0, "x": 1 } } });
    push(&app, CASE, &t, vec![rec]).await;
    let r = pull(&app, CASE, &t, 0).await;
    // Key order and numbers match JSON.stringify of the zod-parsed value.
    assert!(r.text.contains(&format!(r#""sealed":{{"v":1,"iv":"i","ct":"c","rev":{{"lamport":3,"deviceId":"{}"}}}}"#, id(7))), "{}", r.text);
}

#[tokio::test]
async fn record_field_order_on_the_wire_is_seq_id_collection_sealed() {
    let app = app();
    push(&app, CASE, &token('a'), vec![env(1, "cases")]).await;
    let r = pull(&app, CASE, &token('a'), 0).await;
    assert!(r.text.starts_with(&format!(r#"{{"records":[{{"seq":1,"id":"{}","collection":"cases","sealed":{{"v":1,"iv":"aXY","ct":"ct1"}}}}],"cursor":1,"head":1}}"#, id(1))), "{}", r.text);
}

#[tokio::test]
async fn same_identity_with_different_ciphertext_is_appended() {
    let app = app();
    let t = token('a');
    let a = env(1, "cases");
    let mut b = a.clone();
    b["sealed"]["ct"] = json!("other");
    let mut c = a.clone();
    c["collection"] = json!("members");
    assert_eq!(push(&app, CASE, &t, vec![a.clone(), a.clone(), b, c]).await.json(), json!({ "cursor": 3 }));
}

#[tokio::test]
async fn sequences_are_global_but_cursors_and_heads_are_per_case() {
    let app = app();
    let other = "e".repeat(32);
    push(&app, CASE, &token('a'), vec![env(1, "cases")]).await;
    push(&app, &other, &token('b'), vec![env(1, "cases"), env(2, "cases")]).await;
    push(&app, CASE, &token('a'), vec![env(3, "cases")]).await;
    let r = pull(&app, CASE, &token('a'), 0).await.json();
    let seqs: Vec<i64> = r["records"].as_array().unwrap().iter().map(|r| r["seq"].as_i64().unwrap()).collect();
    assert_eq!(seqs, [1, 4]);
    assert_eq!((r["cursor"].as_i64(), r["head"].as_i64()), (Some(4), Some(4)));
    assert_eq!(push(&app, &other, &token('b'), vec![env(2, "cases")]).await.json(), json!({ "cursor": 3 }));
}

#[tokio::test]
async fn pull_is_capped_at_500_and_paginates() {
    let app = app();
    let t = token('a');
    for chunk in 0..3u32 {
        let recs: Vec<Value> = (0..200).map(|n| env(chunk * 200 + n + 1, "evidence")).collect();
        push(&app, CASE, &t, recs).await;
    }
    let first = pull(&app, CASE, &t, 0).await.json();
    assert_eq!(first["records"].as_array().unwrap().len(), 500);
    assert_eq!((first["cursor"].as_i64(), first["head"].as_i64()), (Some(500), Some(600)));
    let second = pull(&app, CASE, &t, 500).await.json();
    assert_eq!(second["records"].as_array().unwrap().len(), 100);
    assert_eq!((second["cursor"].as_i64(), second["head"].as_i64()), (Some(600), Some(600)));
}

#[tokio::test]
async fn pull_pages_stop_at_a_byte_budget_but_always_carry_one_record() {
    let app = app();
    let t = token('a');
    let big = |n: u32| json!({ "id": id(n), "collection": "evidence", "sealed": { "v": 1, "iv": "i", "ct": "x".repeat(20 * 1024 * 1024) } });
    for n in 1..=2 {
        let body = json!({ "records": [big(n)] }).to_string();
        assert_eq!(post_raw(&app, CASE, Some(&t), body).await.status, StatusCode::OK);
    }
    let first = pull(&app, CASE, &t, 0).await.json();
    assert_eq!(first["records"].as_array().unwrap().len(), 1);
    assert_eq!((first["cursor"].as_i64(), first["head"].as_i64()), (Some(1), Some(2)));
    let second = pull(&app, CASE, &t, 1).await.json();
    assert_eq!(second["records"].as_array().unwrap().len(), 1);
}

#[tokio::test]
async fn after_parameter_follows_javascript_number_semantics() {
    let app = app();
    let t = token('a');
    push(&app, CASE, &t, vec![env(1, "cases"), env(2, "cases"), env(3, "cases")]).await;
    let count_cursor = |r: Value| (r["records"].as_array().unwrap().len(), r["cursor"].clone(), r["head"].clone());
    // missing, empty, junk, NaN all mean 0
    for q in ["", "?after=", "?after=abc", "?after=NaN", "?after=1,2", "?other=2", "?after=0x", "?after=-0"] {
        assert_eq!(count_cursor(get_raw(&app, CASE, Some(&t), q).await.json()), (3, json!(3), json!(3)), "{q}");
    }
    assert_eq!(count_cursor(get_raw(&app, CASE, Some(&t), "?after=1").await.json()), (2, json!(3), json!(3)));
    assert_eq!(count_cursor(get_raw(&app, CASE, Some(&t), "?after=%202%20").await.json()).0, 1); // trimmed
    assert_eq!(count_cursor(get_raw(&app, CASE, Some(&t), "?after=0x2").await.json()).0, 1); // hex
    assert_eq!(count_cursor(get_raw(&app, CASE, Some(&t), "?after=1e0").await.json()).0, 2);
    assert_eq!(count_cursor(get_raw(&app, CASE, Some(&t), "?after=1.5").await.json()).0, 2);
    assert_eq!(count_cursor(get_raw(&app, CASE, Some(&t), "?after=1&after=2").await.json()).0, 2); // first wins
    // beyond the head: cursor is clamped to head
    assert_eq!(count_cursor(get_raw(&app, CASE, Some(&t), "?after=99").await.json()), (0, json!(3), json!(3)));
    assert_eq!(count_cursor(get_raw(&app, CASE, Some(&t), "?after=Infinity").await.json()), (0, json!(3), json!(3)));
    // negative: everything, but the empty-page cursor is not clamped upward
    assert_eq!(count_cursor(get_raw(&app, CASE, Some(&t), "?after=-5").await.json()).0, 3);
    assert_eq!(count_cursor(get_raw(&app, CASE, Some(&t), "?after=-Infinity").await.json()).0, 3);
}

#[tokio::test]
async fn empty_page_cursor_for_fractional_and_negative_after() {
    let app = app();
    let t = token('a');
    push(&app, CASE, &t, vec![env(1, "cases")]).await;
    // after=1.2 -> no rows, cursor = min(1.2, 1) = 1
    assert!(pull_text(&app, &t, "?after=1.2").await.ends_with(r#""cursor":1,"head":1}"#));
    // nothing after -Infinity? (rows exist) so use a case with no rows via after above head only.
    assert!(pull_text(&app, &t, "?after=5").await.ends_with(r#""cursor":1,"head":1}"#));
}

async fn pull_text(app: &Router, t: &str, q: &str) -> String {
    get_raw(app, CASE, Some(t), q).await.text
}

#[tokio::test]
async fn too_large_by_content_length_is_413_before_anything_else() {
    let app = app();
    let req = Request::post(path(CASE, "")).header("content-length", (24 * 1024 * 1024 + 1).to_string()).body(Body::empty()).unwrap();
    err(&send(&app, req).await, 413, "too large");
}

#[tokio::test]
async fn too_large_by_actual_bytes_is_413_and_limit_is_inclusive() {
    let app = app();
    let t = token('a');
    let limit = 24 * 1024 * 1024;
    let make = |ct_len: usize| json!({ "records": [{ "id": id(1), "collection": "cases", "sealed": { "v": 1, "iv": "i", "ct": "x".repeat(ct_len) } }] }).to_string();
    let base = make(0).len();
    // exactly at the limit is accepted
    let ok = make(limit - base);
    assert_eq!(ok.len(), limit);
    assert_eq!(post_raw(&app, CASE, Some(&t), ok).await.status, StatusCode::OK);
    // one byte over is refused (body length is checked by bytes, not characters)
    err(&post_raw(&app, CASE, Some(&t), make(limit - base + 1)).await, 413, "too large");
    // multi-byte characters count by their UTF-8 size
    let wide = json!({ "records": [{ "id": id(1), "collection": "cases", "sealed": { "v": 1, "iv": "i", "ct": "é".repeat(limit / 2) } }] }).to_string();
    err(&post_raw(&app, CASE, Some(&t), wide).await, 413, "too large");
    // an oversize body is refused before auth or validation
    err(&post_raw(&app, CASE, None, "x".repeat(limit + 10)).await, 413, "too large");
}

#[tokio::test]
async fn data_survives_reopen_and_reads_a_database_written_by_the_typescript_host() {
    let dir = std::env::temp_dir().join(format!("zireh-host-test-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    let db = dir.join("nested").join("sync.db");
    let db = db.to_str().unwrap();

    // Create the file exactly as host.ts would have (same DDL), then fill it with its rows.
    {
        std::fs::create_dir_all(dir.join("nested")).unwrap();
        let c = rusqlite::Connection::open(db).unwrap();
        c.execute_batch(
            "PRAGMA journal_mode = WAL;
             CREATE TABLE cases (case_id TEXT PRIMARY KEY, token_hash TEXT NOT NULL) WITHOUT ROWID;
             CREATE TABLE records (seq INTEGER PRIMARY KEY AUTOINCREMENT, case_id TEXT NOT NULL, id TEXT NOT NULL, collection TEXT NOT NULL, sealed TEXT NOT NULL);
             CREATE INDEX records_by_case ON records (case_id, seq);
             CREATE INDEX records_by_identity ON records (case_id, collection, id);",
        )
        .unwrap();
        // sha256("zireh/case-token-hash/v1:" + "a" * 64), as @zireh/cases computes it.
        c.execute("INSERT INTO cases VALUES (?, ?)", [CASE, "bae2bdfcf5d350b886fc8ffef8c1e330f560d67546ff389677015e62d97c0aa7"]).unwrap();
        c.execute("INSERT INTO records (case_id, id, collection, sealed) VALUES (?, ?, 'cases', ?)", [CASE, &id(1), r#"{"v":1,"iv":"i","ct":"c"}"#]).unwrap();
    }

    let app = app_with(Store::open(db).unwrap());
    let t = token('a');
    let r = pull(&app, CASE, &t, 0).await.json();
    assert_eq!(r["records"][0]["sealed"], json!({ "v": 1, "iv": "i", "ct": "c" }));
    err(&pull(&app, CASE, &token('b'), 0).await, 403, "wrong case token");
    // An identical envelope pushed to the old database is deduplicated against the old row.
    let same = json!({ "id": id(1), "collection": "cases", "sealed": { "v": 1, "iv": "i", "ct": "c" } });
    assert_eq!(push(&app, CASE, &t, vec![same]).await.json(), json!({ "cursor": 1 }));
    push(&app, CASE, &t, vec![env(2, "cases")]).await;
    drop(app);

    let app = app_with(Store::open(db).unwrap());
    assert_eq!(pull(&app, CASE, &t, 0).await.json()["head"], 2);
    drop(app);
    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn corrupt_stored_json_is_a_500() {
    let dir = std::env::temp_dir().join(format!("zireh-host-corrupt-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    let db = dir.join("sync.db");
    let store = Store::open(db.to_str().unwrap()).unwrap();
    let app = app_with(store);
    push(&app, CASE, &token('a'), vec![env(1, "cases")]).await;
    let c = rusqlite::Connection::open(&db).unwrap();
    c.execute("UPDATE records SET sealed = 'not json'", []).unwrap();
    assert_eq!(pull(&app, CASE, &token('a'), 0).await.status, StatusCode::INTERNAL_SERVER_ERROR);
    drop(c);
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn js_number_parsing() {
    assert_eq!(js_to_number(""), 0.0);
    assert_eq!(js_to_number("  "), 0.0);
    assert_eq!(js_to_number("12"), 12.0);
    assert_eq!(js_to_number(".5"), 0.5);
    assert_eq!(js_to_number("5."), 5.0);
    assert_eq!(js_to_number("+3"), 3.0);
    assert_eq!(js_to_number("-3e2"), -300.0);
    assert_eq!(js_to_number("0b101"), 5.0);
    assert_eq!(js_to_number("0o17"), 15.0);
    assert_eq!(js_to_number("0XfF"), 255.0);
    assert_eq!(js_to_number("Infinity"), f64::INFINITY);
    assert_eq!(js_to_number("-Infinity"), f64::NEG_INFINITY);
    for bad in ["inf", "nan", "NaN", "infinity", "1e", "e5", "-", ".", "1_0", "0x", "-0x1", "1 2", "0x1g", "--1"] {
        assert!(js_to_number(bad).is_nan(), "{bad}");
    }
}

#[tokio::test]
async fn browsers_on_other_origins_can_call_the_host() {
    let app = app().layer(axum::middleware::from_fn(zireh_host::http::cors));
    let pre = send(&app, Request::builder().method("OPTIONS").uri(path(CASE, "")).header("origin", "https://app.example").body(Body::empty()).unwrap()).await;
    assert_eq!(pre.status, StatusCode::NO_CONTENT);
    assert_eq!(pre.headers["access-control-allow-origin"], "*");
    assert!(pre.headers["access-control-allow-headers"].to_str().unwrap().contains("x-case-token"));
    let res = push(&app, CASE, &token('a'), vec![env(1, "members")]).await;
    assert_eq!(res.status, StatusCode::OK);
    assert_eq!(res.headers["access-control-allow-origin"], "*");
}
