//! JavaScript-compatible text: the browser hashes and compares the exact strings its own
//! `JSON.stringify` produces, so anything we hash or echo must be formatted the same way.

use serde_json::Value;

/// `JSON.stringify(n)`: JavaScript's own number-to-text rule (shortest digits, ties as
/// ECMAScript picks them, exponent from 1e21 and below 1e-6, `-0` as `0`). Rust's `Display`
/// can choose different but equally short digits for large numbers, so we use ryu-js.
pub fn js_number(n: f64) -> String {
    if !n.is_finite() {
        "null".into()
    } else if n == 0.0 {
        "0".into()
    } else {
        ryu_js::Buffer::new().format_finite(n).to_string()
    }
}

/// `JSON.stringify(s)` for a string.
pub fn str_json(s: &str) -> String {
    serde_json::to_string(s).expect("string serializes")
}

/// `s.length` in JavaScript: UTF-16 code units, so an emoji counts as two.
pub fn utf16_len(s: &str) -> usize {
    s.encode_utf16().count()
}

/// Our TypeScript `canonicalJson`: keys sorted the way JavaScript compares strings (by UTF-16
/// code units, not bytes), no whitespace, numbers and strings as `JSON.stringify` writes them.
pub fn canonical_json(v: &Value) -> String {
    match v {
        Value::Null => "null".into(),
        Value::Bool(b) => b.to_string(),
        Value::Number(n) => js_number(n.as_f64().unwrap_or(f64::NAN)),
        Value::String(s) => str_json(s),
        Value::Array(items) => format!("[{}]", items.iter().map(canonical_json).collect::<Vec<_>>().join(",")),
        Value::Object(map) => {
            let mut entries: Vec<_> = map.iter().collect();
            entries.sort_by(|(a, _), (b, _)| a.encode_utf16().cmp(b.encode_utf16()));
            let body: Vec<_> = entries.iter().map(|(k, v)| format!("{}:{}", str_json(k), canonical_json(v))).collect();
            format!("{{{}}}", body.join(","))
        }
    }
}
