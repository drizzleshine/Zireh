//! `relay.db`, unchanged from the TypeScript relay: spent coins, stored replies (so a resent call
//! returns the same result and never pays twice), top-up quotes and the demo budget.

use std::path::Path;
use std::sync::{Mutex, MutexGuard};
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Map, Value};

use crate::features::mint::spent::SPENT_SCHEMA;

/// Stored-reply marker: coins burned, no reply yet. Never sent to clients as a status.
pub const REDEEMED: u16 = 0;

/// Answers stop being served after 15 minutes or acknowledgement; the money part stays.
pub const ANSWER_TTL_MS: u64 = 15 * 60 * 1000;

#[derive(Clone, Debug, PartialEq)]
pub struct StoredResponse {
    pub status: u16,
    pub body: Value,
}

pub fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

/// What survives once an answer expires: the crash marker, a minted top-up, or the settlement
/// (change coins) of a paid call. `None` means nothing financial is left to keep.
pub fn settlement_only(r: &StoredResponse) -> Option<StoredResponse> {
    if r.status == REDEEMED {
        return Some(r.clone());
    }
    let body = r.body.as_object()?;
    if body.get("outputsHash").is_some_and(truthy) {
        return Some(r.clone());
    }
    let settlement = body.get("settlement").filter(|s| truthy(s))?;
    let mut kept = Map::new();
    kept.insert("settlement".into(), settlement.clone());
    kept.insert("answerExpired".into(), Value::Bool(true));
    if let Some(model @ Value::String(_)) = body.get("model") {
        kept.insert("model".into(), model.clone());
        kept.insert("content".into(), Value::String(String::new()));
    }
    if body.get("hits").is_some_and(Value::is_array) {
        kept.insert("hits".into(), json!([]));
    }
    if let Some(error) = body.get("error").filter(|e| truthy(e)) {
        kept.insert("error".into(), error.clone());
        kept.insert("message".into(), Value::String("Answer expired; settlement is retained".into()));
    }
    Some(StoredResponse { status: r.status, body: Value::Object(kept) })
}

/// JavaScript truthiness for JSON values.
fn truthy(v: &Value) -> bool {
    match v {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().is_some_and(|n| n != 0.0),
        Value::String(s) => !s.is_empty(),
        _ => true,
    }
}

pub struct RelayDb {
    conn: Mutex<Connection>,
}

impl RelayDb {
    pub fn open(dir: &Path) -> rusqlite::Result<Self> {
        std::fs::create_dir_all(dir).map_err(|e| rusqlite::Error::ToSqlConversionFailure(Box::new(e)))?;
        let file = dir.join("relay.db");
        let conn = Connection::open(&file)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o600));
        }
        Self::init(conn)
    }

    pub fn in_memory() -> rusqlite::Result<Self> {
        Self::init(Connection::open_in_memory()?)
    }

    fn init(conn: Connection) -> rusqlite::Result<Self> {
        conn.execute_batch(&format!(
            "PRAGMA journal_mode = WAL;
             PRAGMA synchronous = FULL;
             CREATE TABLE IF NOT EXISTS demo_budget (kind TEXT, day TEXT, credits INTEGER NOT NULL, PRIMARY KEY(kind, day));
             CREATE TABLE IF NOT EXISTS quotes (id TEXT PRIMARY KEY, body TEXT NOT NULL);
             {SPENT_SCHEMA}
             CREATE TABLE IF NOT EXISTS responses (request_id TEXT PRIMARY KEY, at INTEGER NOT NULL, status INTEGER NOT NULL, body TEXT NOT NULL);"
        ))?;
        Ok(Self { conn: Mutex::new(conn) })
    }

    pub fn conn(&self) -> MutexGuard<'_, Connection> {
        self.conn.lock().expect("relay database")
    }

    pub fn mutex(&self) -> &Mutex<Connection> {
        &self.conn
    }

    /// A stored reply; past the TTL only its financial part, which is written back.
    pub fn get_response(&self, id: &str) -> rusqlite::Result<Option<StoredResponse>> {
        let conn = self.conn();
        let row: Option<(u16, String, i64)> = conn
            .query_row("SELECT status, body, at FROM responses WHERE request_id = ?1", params![id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
            .optional()?;
        let Some((status, body, at)) = row else { return Ok(None) };
        let response = StoredResponse { status, body: serde_json::from_str(&body).unwrap_or(Value::Null) };
        if now_ms().saturating_sub(at as u64) <= ANSWER_TTL_MS {
            return Ok(Some(response));
        }
        let financial = settlement_only(&response);
        if let Some(f) = &financial {
            conn.execute("UPDATE responses SET body = ?1 WHERE request_id = ?2", params![f.body.to_string(), id])?;
        }
        Ok(financial)
    }

    /// Stores a reply on whatever connection or transaction the caller holds.
    pub fn put_response_on(conn: &Connection, id: &str, r: &StoredResponse) -> rusqlite::Result<()> {
        conn.execute("INSERT OR REPLACE INTO responses (request_id, at, status, body) VALUES (?1, ?2, ?3, ?4)", params![id, now_ms() as i64, r.status, r.body.to_string()])?;
        Ok(())
    }

    pub fn put_response(&self, id: &str, r: &StoredResponse) -> rusqlite::Result<()> {
        Self::put_response_on(&self.conn(), id, r)
    }

    /// The client has its answer: keep only the financial part.
    pub fn acknowledge(&self, id: &str) -> rusqlite::Result<()> {
        let conn = self.conn();
        let row: Option<(u16, String)> = conn.query_row("SELECT status, body FROM responses WHERE request_id = ?1", params![id], |r| Ok((r.get(0)?, r.get(1)?))).optional()?;
        if let Some((status, body)) = row {
            let response = StoredResponse { status, body: serde_json::from_str(&body).unwrap_or(Value::Null) };
            if let Some(f) = settlement_only(&response) {
                conn.execute("UPDATE responses SET body = ?1 WHERE request_id = ?2", params![f.body.to_string(), id])?;
            }
        }
        Ok(())
    }

    pub fn get_quote_on(conn: &Connection, id: &str) -> rusqlite::Result<Option<Value>> {
        let body: Option<String> = conn.query_row("SELECT body FROM quotes WHERE id = ?1", params![id], |r| r.get(0)).optional()?;
        Ok(body.and_then(|b| serde_json::from_str(&b).ok()))
    }

    pub fn put_quote_on(conn: &Connection, id: &str, record: &Value) -> rusqlite::Result<()> {
        conn.execute("INSERT OR REPLACE INTO quotes (id, body) VALUES (?1, ?2)", params![id, record.to_string()])?;
        Ok(())
    }

    /// Reserve `credits` against today's (UTC) ceiling for `kind`. False, and nothing reserved,
    /// when it would go over.
    pub fn reserve_budget(&self, kind: &str, credits: u64, daily_limit: u64, day: &str) -> rusqlite::Result<bool> {
        let mut conn = self.conn();
        let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        let used: i64 = tx.query_row("SELECT credits FROM demo_budget WHERE kind = ?1 AND day = ?2", params![kind, day], |r| r.get(0)).optional()?.unwrap_or(0);
        let used = used.max(0) as u64;
        if credits > daily_limit.saturating_sub(used) {
            return Ok(false);
        }
        tx.execute("INSERT OR REPLACE INTO demo_budget (kind, day, credits) VALUES (?1, ?2, ?3)", params![kind, day, (used + credits) as i64])?;
        tx.commit()?;
        Ok(true)
    }
}

/// `new Date(ms).toISOString()`: `YYYY-MM-DDTHH:MM:SS.mmmZ`.
pub fn iso_time(ms: u64) -> String {
    let secs = ms / 1000;
    let (days, rem) = ((secs / 86_400) as i64, secs % 86_400);
    // Civil date from days since 1970-01-01 (Howard Hinnant's algorithm).
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!("{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{:03}Z", rem / 3600, rem % 3600 / 60, rem % 60, ms % 1000)
}

/// `Date.parse` for the ISO strings we write; None for anything else.
pub fn parse_iso(s: &str) -> Option<u64> {
    let b = s.as_bytes();
    if b.len() != 24 || b[4] != b'-' || b[7] != b'-' || b[10] != b'T' || b[13] != b':' || b[16] != b':' || b[19] != b'.' || b[23] != b'Z' {
        return None;
    }
    let n = |a: usize, z: usize| s.get(a..z)?.parse::<i64>().ok();
    let (y, m, d) = (n(0, 4)?, n(5, 7)?, n(8, 10)?);
    let (y2, m2) = if m <= 2 { (y - 1, m + 9) } else { (y, m - 3) };
    let era = y2.div_euclid(400);
    let yoe = y2 - era * 400;
    let doy = (153 * m2 + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    let ms = ((days * 86_400 + n(11, 13)? * 3600 + n(14, 16)? * 60 + n(17, 19)?) * 1000 + n(20, 23)?) as u64;
    Some(ms)
}
