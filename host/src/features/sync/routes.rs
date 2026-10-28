//! `/v1/cases/{caseId}/records`: GET pulls, POST pushes. Check order, status codes and
//! bodies mirror the TypeScript host exactly (including validating a push body before auth).

use axum::{
    body::Body,
    extract::Request,
    http::{HeaderMap, Method, Uri},
    response::Response,
    routing::any,
    Router,
};
use http_body_util::{BodyExt, Limited};
use serde::Serialize;
use serde_json::{value::RawValue, Value};

use super::{
    store::{Denied, Fail, NewRecord, Store},
    MAX_RECORDS_PER_PUSH, MAX_SYNC_BODY_BYTES,
};
use crate::http::{error, internal_error, json_raw, not_found};
use crate::js::{js_number, str_json};

/// Largest integer JavaScript (and so zod) treats as exact.
const MAX_SAFE_INTEGER: f64 = 9_007_199_254_740_991.0;

const COLLECTIONS: [&str; 12] =
    ["members", "cases", "evidence", "observations", "findings", "reviews", "pseudonyms", "comments", "links", "board", "conclusions", "replies"];

pub fn router(store: Store) -> Router {
    Router::new().route("/v1/cases/{case_id}/records", any(handle)).with_state(store)
}

async fn handle(axum::extract::State(store): axum::extract::State<Store>, req: Request) -> Response {
    let (parts, body) = req.into_parts();
    let Some(case_id) = case_id_from(&parts.uri) else { return not_found() };
    let token = header_token(&parts.headers);
    match parts.method {
        Method::GET => {
            let after = after_param(&parts.uri);
            run(move || pull(&store, &case_id, token.as_deref(), after)).await
        }
        Method::POST => push(store, case_id, token, &parts.headers, body).await,
        _ => error(405, "method not allowed"),
    }
}

/// Runs blocking SQLite work off the async threads.
async fn run(f: impl FnOnce() -> Response + Send + 'static) -> Response {
    tokio::task::spawn_blocking(f).await.unwrap_or_else(|_| internal_error())
}

fn denied(d: Denied) -> Response {
    match d {
        Denied::MissingToken => error(401, "missing case token"),
        Denied::UnknownCase => error(404, "unknown case"),
        Denied::WrongToken => error(403, "wrong case token"),
    }
}

fn fail(f: Fail) -> Response {
    match f {
        Fail::Denied(d) => denied(d),
        Fail::Db(e) => {
            eprintln!("sync host database error: {e}");
            internal_error()
        }
    }
}

/// Mirrors `/^\/v1\/cases\/([0-9a-f]{32})\/records$/` against the raw path.
fn case_id_from(uri: &Uri) -> Option<String> {
    let id = uri.path().strip_prefix("/v1/cases/")?.strip_suffix("/records")?;
    is_hex(id, 32).then(|| id.to_string())
}

fn is_hex(s: &str, len: usize) -> bool {
    s.len() == len && s.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

fn header_token(headers: &HeaderMap) -> Option<String> {
    let mut all = headers.get_all("x-case-token").iter();
    let first = all.next()?;
    if all.next().is_some() {
        return None; // fetch would join duplicates with ", ", which is never a valid token
    }
    first.to_str().ok().map(str::to_string)
}

fn after_param(uri: &Uri) -> f64 {
    let raw = uri.query().and_then(|q| form_urlencoded::parse(q.as_bytes()).find(|(k, _)| k == "after").map(|(_, v)| v.into_owned()));
    // Number(raw ?? 0) || 0
    let n = raw.map_or(0.0, |s| js_to_number(&s));
    if n.is_nan() || n == 0.0 {
        0.0
    } else {
        n
    }
}

fn is_js_space(c: char) -> bool {
    matches!(c, '\u{FEFF}') || (c.is_whitespace() && c != '\u{85}')
}

/// JavaScript `Number(string)`.
pub fn js_to_number(s: &str) -> f64 {
    let t = s.trim_matches(is_js_space);
    if t.is_empty() {
        return 0.0;
    }
    match t {
        "Infinity" | "+Infinity" => return f64::INFINITY,
        "-Infinity" => return f64::NEG_INFINITY,
        _ => {}
    }
    let b = t.as_bytes();
    if b.len() > 2 && b[0] == b'0' {
        let radix = match b[1] {
            b'x' | b'X' => 16,
            b'o' | b'O' => 8,
            b'b' | b'B' => 2,
            _ => 0,
        };
        if radix != 0 {
            return t[2..].chars().try_fold(0f64, |acc, c| c.to_digit(radix).map(|d| acc * radix as f64 + d as f64)).unwrap_or(f64::NAN);
        }
    }
    // StrDecimalLiteral: [+-] (digits [. digits?] | . digits) [eE [+-] digits]
    let mut i = 0;
    if i < b.len() && (b[i] == b'+' || b[i] == b'-') {
        i += 1;
    }
    let int_start = i;
    while i < b.len() && b[i].is_ascii_digit() {
        i += 1;
    }
    let mut digits = i - int_start;
    if i < b.len() && b[i] == b'.' {
        i += 1;
        let f = i;
        while i < b.len() && b[i].is_ascii_digit() {
            i += 1;
        }
        digits += i - f;
    }
    if digits == 0 {
        return f64::NAN;
    }
    if i < b.len() && (b[i] == b'e' || b[i] == b'E') {
        i += 1;
        if i < b.len() && (b[i] == b'+' || b[i] == b'-') {
            i += 1;
        }
        let e = i;
        while i < b.len() && b[i].is_ascii_digit() {
            i += 1;
        }
        if i == e {
            return f64::NAN;
        }
    }
    if i != b.len() {
        return f64::NAN;
    }
    t.parse::<f64>().unwrap_or(f64::NAN)
}

#[derive(Serialize)]
struct Out<'a> {
    seq: i64,
    id: &'a str,
    collection: &'a str,
    sealed: &'a RawValue,
}

fn pull(store: &Store, case_id: &str, token: Option<&str>, after: f64) -> Response {
    let page = match store.pull(case_id, token, after) {
        Ok(p) => p,
        Err(f) => return fail(f),
    };
    let mut sealed = Vec::with_capacity(page.rows.len());
    for r in &page.rows {
        match RawValue::from_string(r.sealed.clone()) {
            Ok(v) => sealed.push(v),
            Err(_) => return internal_error(), // JSON.parse threw in the TypeScript host
        }
    }
    let records: Vec<Out> = page.rows.iter().zip(&sealed).map(|(r, s)| Out { seq: r.seq, id: &r.id, collection: &r.collection, sealed: s }).collect();
    let cursor = match page.rows.last() {
        Some(r) => r.seq.to_string(),
        None => js_number(after.min(page.head as f64)),
    };
    let records_json = serde_json::to_string(&records).expect("records serialize");
    json_raw(200, format!("{{\"records\":{records_json},\"cursor\":{cursor},\"head\":{}}}", page.head))
}

async fn push(store: Store, case_id: String, token: Option<String>, headers: &HeaderMap, body: Body) -> Response {
    let declared = headers.get("content-length").and_then(|v| v.to_str().ok()).map_or(0.0, js_to_number);
    if declared > MAX_SYNC_BODY_BYTES as f64 {
        return error(413, "too large");
    }
    // Lossy decoding never shrinks a body by more than a 3-byte BOM, so anything longer than
    // this is certain to exceed the limit once re-encoded.
    let bytes = match Limited::new(body, MAX_SYNC_BODY_BYTES + 4).collect().await {
        Ok(c) => c.to_bytes(),
        Err(e) if e.downcast_ref::<http_body_util::LengthLimitError>().is_some() => return error(413, "too large"),
        Err(_) => return internal_error(),
    };
    let text = String::from_utf8_lossy(&bytes);
    let text = text.strip_prefix('\u{FEFF}').unwrap_or(&text);
    if text.len() > MAX_SYNC_BODY_BYTES {
        return error(413, "too large");
    }
    let parsed: Value = match serde_json::from_str(if text.is_empty() { "null" } else { text }) {
        Ok(v) => v,
        Err(_) => return internal_error(), // JSON.parse threw in the TypeScript host
    };
    let Some(records) = validate(&parsed) else { return error(400, "invalid records") };
    run(move || match store.push(&case_id, token.as_deref(), &records) {
        Ok(cursor) => json_raw(200, format!("{{\"cursor\":{cursor}}}")),
        Err(f) => fail(f),
    })
    .await
}

/// `z.object({ records: z.array(Envelope).min(1).max(200) })`, producing the exact text
/// `JSON.stringify` of the zod-stripped `sealed` object.
fn validate(v: &Value) -> Option<Vec<NewRecord>> {
    let list = v.as_object()?.get("records")?.as_array()?;
    if list.is_empty() || list.len() > MAX_RECORDS_PER_PUSH {
        return None;
    }
    list.iter().map(envelope).collect()
}

fn envelope(v: &Value) -> Option<NewRecord> {
    let o = v.as_object()?;
    let id = o.get("id")?.as_str().filter(|s| is_hex(s, 32))?;
    let collection = o.get("collection")?.as_str().filter(|s| COLLECTIONS.contains(s))?;
    let s = o.get("sealed")?.as_object()?;
    if s.get("v")?.as_f64()? != 1.0 {
        return None;
    }
    let iv = s.get("iv")?.as_str()?;
    let ct = s.get("ct")?.as_str()?;
    let mut sealed = format!("{{\"v\":1,\"iv\":{},\"ct\":{}", str_json(iv), str_json(ct));
    if let Some(rev) = s.get("rev") {
        let r = rev.as_object()?;
        let lamport = r.get("lamport")?.as_f64()?;
        // zod's `.int()` accepts only safe integers (≤ 2^53 − 1).
        if !(lamport.is_finite() && lamport.fract() == 0.0 && lamport > 0.0 && lamport <= MAX_SAFE_INTEGER) {
            return None;
        }
        let device = r.get("deviceId")?.as_str().filter(|s| is_hex(s, 32))?;
        sealed.push_str(&format!(",\"rev\":{{\"lamport\":{},\"deviceId\":{}}}", js_number(lamport), str_json(device)));
    }
    sealed.push('}');
    Some(NewRecord { id: id.to_string(), collection: collection.to_string(), sealed })
}
