//! Request validation with the same rules as the zod schemas in `packages/schema` (relay.ts,
//! money.ts, chat.ts): unknown keys are dropped, integers must be safe integers, string lengths
//! count UTF-16 units. Error wording differs from zod's; clients only show the message.

use serde_json::{Map, Value};

use crate::features::mint::{BlindedMessage, Proof};
use crate::js::utf16_len;

pub type Checked<T> = Result<T, String>;

const MAX_SAFE_INTEGER: f64 = 9_007_199_254_740_991.0;

fn object<'a>(v: &'a Value, path: &str) -> Checked<&'a Map<String, Value>> {
    v.as_object().ok_or_else(|| format!("{path}: expected object"))
}

fn field<'a>(o: &'a Map<String, Value>, key: &str, path: &str) -> Checked<&'a Value> {
    o.get(key).ok_or_else(|| format!("{}: required", join(path, key)))
}

fn join(path: &str, key: &str) -> String {
    if path.is_empty() { key.to_string() } else { format!("{path}.{key}") }
}

fn string(v: &Value, path: &str) -> Checked<String> {
    v.as_str().map(str::to_string).ok_or_else(|| format!("{path}: expected string"))
}

fn number(v: &Value, path: &str) -> Checked<f64> {
    v.as_f64().filter(|n| n.is_finite()).ok_or_else(|| format!("{path}: expected number"))
}

/// `z.number().int()`: a safe integer.
fn int(v: &Value, path: &str) -> Checked<f64> {
    let n = number(v, path)?;
    if n.fract() != 0.0 || n.abs() > MAX_SAFE_INTEGER {
        return Err(format!("{path}: expected int"));
    }
    Ok(n)
}

fn is_hex(s: &str) -> bool {
    !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

fn hex_of_len(v: &Value, path: &str, len: usize) -> Checked<String> {
    let s = string(v, path)?;
    if s.len() == len && is_hex(&s) { Ok(s) } else { Err(format!("{path}: invalid")) }
}

/// `/^0[23][0-9a-f]{64}$/`
fn point_hex(v: &Value, path: &str) -> Checked<String> {
    let s = string(v, path)?;
    let ok = s.len() == 66 && s.starts_with('0') && matches!(s.as_bytes()[1], b'2' | b'3') && is_hex(&s[2..]);
    if ok { Ok(s) } else { Err(format!("{path}: invalid")) }
}

fn non_empty(v: &Value, path: &str) -> Checked<String> {
    let s = string(v, path)?;
    if utf16_len(&s) >= 1 { Ok(s) } else { Err(format!("{path}: too small")) }
}

/// `Amount`: positive safe integer and a power of two.
fn amount(v: &Value, path: &str) -> Checked<u64> {
    let n = int(v, path)?;
    if n <= 0.0 {
        return Err(format!("{path}: too small"));
    }
    let n = n as u64;
    if n & (n - 1) == 0 { Ok(n) } else { Err(format!("{path}: power of two")) }
}

fn array<'a>(v: &'a Value, path: &str, min: usize, max: usize) -> Checked<&'a Vec<Value>> {
    let a = v.as_array().ok_or_else(|| format!("{path}: expected array"))?;
    if a.len() < min {
        return Err(format!("{path}: too small"));
    }
    if a.len() > max {
        return Err(format!("{path}: too big"));
    }
    Ok(a)
}

/// `requestId: /^[0-9a-f]{32}$/`
pub fn request_id(o: &Map<String, Value>, path: &str) -> Checked<String> {
    hex_of_len(field(o, "requestId", path)?, &join(path, "requestId"), 32)
}

/// `BlindedMessage`: amount ≥ 0 (0 = blank output for change). With `positive`, the swap's
/// `.extend({ amount: Amount })`.
fn blinded(v: &Value, path: &str, positive: bool) -> Checked<BlindedMessage> {
    let o = object(v, path)?;
    let amount = if positive {
        amount(field(o, "amount", path)?, &join(path, "amount"))?
    } else {
        let n = int(field(o, "amount", path)?, &join(path, "amount"))?;
        if n < 0.0 {
            return Err(format!("{}: too small", join(path, "amount")));
        }
        n as u64
    };
    Ok(BlindedMessage {
        amount,
        b: point_hex(field(o, "B_", path)?, &join(path, "B_"))?,
        keyset_id: non_empty(field(o, "keysetId", path)?, &join(path, "keysetId"))?,
    })
}

fn proof(v: &Value, path: &str) -> Checked<Proof> {
    let o = object(v, path)?;
    Ok(Proof {
        amount: amount(field(o, "amount", path)?, &join(path, "amount"))?,
        secret: hex_of_len(field(o, "secret", path)?, &join(path, "secret"), 64)?,
        c: point_hex(field(o, "C", path)?, &join(path, "C"))?,
        keyset_id: non_empty(field(o, "keysetId", path)?, &join(path, "keysetId"))?,
    })
}

fn list<T>(v: &Value, path: &str, min: usize, max: usize, each: impl Fn(&Value, &str) -> Checked<T>) -> Checked<Vec<T>> {
    array(v, path, min, max)?.iter().enumerate().map(|(i, item)| each(item, &join(path, &i.to_string()))).collect()
}

pub fn proofs(o: &Map<String, Value>) -> Checked<Vec<Proof>> {
    list(field(o, "proofs", "")?, "proofs", 1, 64, proof)
}

/// `changeOutputs: z.array(BlindedMessage).max(64)`
pub fn change_outputs(o: &Map<String, Value>) -> Checked<Vec<BlindedMessage>> {
    list(field(o, "changeOutputs", "")?, "changeOutputs", 0, 64, |v, p| blinded(v, p, false))
}

pub fn body(v: &Value) -> Checked<&Map<String, Value>> {
    object(v, "")
}

/// `TopupQuoteRequest`: `credits` int, positive, ≤ 100,000,000.
pub fn topup_credits(o: &Map<String, Value>) -> Checked<u64> {
    let n = int(field(o, "credits", "")?, "credits")?;
    if n <= 0.0 {
        return Err("credits: too small".into());
    }
    if n > 100_000_000.0 {
        return Err("credits: too big".into());
    }
    Ok(n as u64)
}

/// `MintRequest`: quoteId string, outputs 1..64 blinded messages.
pub fn mint_request(o: &Map<String, Value>) -> Checked<(String, Vec<BlindedMessage>)> {
    Ok((string(field(o, "quoteId", "")?, "quoteId")?, list(field(o, "outputs", "")?, "outputs", 1, 64, |v, p| blinded(v, p, false))?))
}

/// `SwapRequest`: requestId, proofs 1..64, outputs 1..512 with power-of-two amounts.
pub fn swap_request(o: &Map<String, Value>) -> Checked<(String, Vec<Proof>, Vec<BlindedMessage>)> {
    Ok((request_id(o, "")?, proofs(o)?, list(field(o, "outputs", "")?, "outputs", 1, 512, |v, p| blinded(v, p, true))?))
}

pub fn quote_id(o: &Map<String, Value>) -> Checked<String> {
    string(field(o, "quoteId", "")?, "quoteId")
}

#[derive(Clone, Debug)]
pub struct ChatMessage {
    pub role: String,
    pub content: String,
}

#[derive(Clone, Debug)]
pub struct ChatRequest {
    pub model: String,
    pub messages: Vec<ChatMessage>,
    pub max_tokens: u64,
    pub temperature: Option<f64>,
}

/// `ChatRequest`: model min 1, messages ≥ 1 with role system|user|assistant, max_tokens 1..32768,
/// temperature 0..2 optional, stream boolean optional (accepted and ignored).
pub fn chat_request(v: &Value, path: &str) -> Checked<ChatRequest> {
    let o = object(v, path)?;
    let messages = list(field(o, "messages", path)?, &join(path, "messages"), 1, usize::MAX, |m, p| {
        let m = object(m, p)?;
        let role = string(field(m, "role", p)?, &join(p, "role"))?;
        if !matches!(role.as_str(), "system" | "user" | "assistant") {
            return Err(format!("{}: invalid option", join(p, "role")));
        }
        Ok(ChatMessage { role, content: string(field(m, "content", p)?, &join(p, "content"))? })
    })?;
    let max_tokens = int(field(o, "max_tokens", path)?, &join(path, "max_tokens"))?;
    if max_tokens <= 0.0 || max_tokens > 32_768.0 {
        return Err(format!("{}: out of range", join(path, "max_tokens")));
    }
    let temperature = match o.get("temperature") {
        None => None,
        Some(t) => {
            let t = number(t, &join(path, "temperature"))?;
            if !(0.0..=2.0).contains(&t) {
                return Err(format!("{}: out of range", join(path, "temperature")));
            }
            Some(t)
        }
    };
    if let Some(s) = o.get("stream") {
        s.as_bool().ok_or_else(|| format!("{}: expected boolean", join(path, "stream")))?;
    }
    Ok(ChatRequest { model: non_empty(field(o, "model", path)?, &join(path, "model"))?, messages, max_tokens: max_tokens as u64, temperature })
}

/// JavaScript's `String.prototype.trim`: WhiteSpace and LineTerminator code points (which is not
/// Rust's `char::is_whitespace`: JS trims U+FEFF and keeps U+0085).
pub fn js_trim(s: &str) -> &str {
    let ws = |c: char| matches!(c, '\u{9}' | '\u{a}' | '\u{b}' | '\u{c}' | '\u{d}' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}');
    s.trim_matches(ws)
}

/// `SearchPaidRequest`: query trimmed, 2..400 characters; maxResults 1..10.
pub fn search_request(o: &Map<String, Value>) -> Checked<(String, u64)> {
    let query = js_trim(&string(field(o, "query", "")?, "query")?).to_string();
    let len = utf16_len(&query);
    if len < 2 {
        return Err("query: too small".into());
    }
    if len > 400 {
        return Err("query: too big".into());
    }
    let max = int(field(o, "maxResults", "")?, "maxResults")?;
    if !(1.0..=10.0).contains(&max) {
        return Err("maxResults: out of range".into());
    }
    Ok((query, max as u64))
}
