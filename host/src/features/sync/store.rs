//! SQLite storage. Same tables, columns, indexes and SQL as the TypeScript host, so an
//! existing database file keeps working.

use std::{
    fs,
    os::unix::fs::DirBuilderExt,
    path::Path,
    sync::{Arc, Mutex, MutexGuard},
};

use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use sha2::{Digest, Sha256};

use super::{MAX_PULL_PAGE_BYTES, MAX_RECORDS_PER_PULL};

/// Why a request was refused before touching any records.
#[derive(Debug, PartialEq, Eq)]
pub enum Denied {
    /// No token, or not 64 lowercase hex characters (401).
    MissingToken,
    /// Unknown case on a read (404).
    UnknownCase,
    /// Token does not match the registered hash (403).
    WrongToken,
}

#[derive(Debug)]
pub enum Fail {
    Denied(Denied),
    Db(rusqlite::Error),
}

impl From<rusqlite::Error> for Fail {
    fn from(e: rusqlite::Error) -> Self {
        Fail::Db(e)
    }
}

/// A validated envelope ready to store. `sealed` is already the canonical JSON text.
pub struct NewRecord {
    pub id: String,
    pub collection: String,
    pub sealed: String,
}

pub struct StoredRow {
    pub seq: i64,
    pub id: String,
    pub collection: String,
    pub sealed: String,
}

pub struct Page {
    pub rows: Vec<StoredRow>,
    pub head: i64,
}

#[derive(Clone)]
pub struct Store {
    conn: Arc<Mutex<Connection>>,
}

/// sha256("zireh/case-token-hash/v1:" + token), hex.
pub fn case_token_hash(token: &str) -> String {
    hex::encode(Sha256::digest(format!("zireh/case-token-hash/v1:{token}").as_bytes()))
}

fn valid_token(token: Option<&str>) -> Option<&str> {
    token.filter(|t| t.len() == 64 && t.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)))
}

const SCHEMA: &str = "
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS cases (case_id TEXT PRIMARY KEY, token_hash TEXT NOT NULL) WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS records (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      case_id TEXT NOT NULL, id TEXT NOT NULL, collection TEXT NOT NULL, sealed TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS records_by_case ON records (case_id, seq);
    CREATE INDEX IF NOT EXISTS records_by_identity ON records (case_id, collection, id);
";

impl Store {
    pub fn open(path: &str) -> rusqlite::Result<Store> {
        if path != ":memory:" {
            let parent = Path::new(path).parent().filter(|p| !p.as_os_str().is_empty()).unwrap_or(Path::new("."));
            fs::DirBuilder::new().recursive(true).mode(0o700).create(parent).map_err(|e| rusqlite::Error::ToSqlConversionFailure(Box::new(e)))?;
        }
        let conn = Connection::open(path)?;
        conn.execute_batch(SCHEMA)?;
        Ok(Store { conn: Arc::new(Mutex::new(conn)) })
    }

    fn lock(&self) -> MutexGuard<'_, Connection> {
        self.conn.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// First writer registers the case; afterwards the token must match.
    fn authorize(conn: &Connection, case_id: &str, token: Option<&str>, register: bool) -> Result<(), Fail> {
        let token = valid_token(token).ok_or(Fail::Denied(Denied::MissingToken))?;
        let stored: Option<String> = conn.query_row("SELECT token_hash FROM cases WHERE case_id = ?", [case_id], |r| r.get(0)).optional()?;
        match stored {
            None if !register => Err(Fail::Denied(Denied::UnknownCase)),
            None => {
                conn.execute("INSERT INTO cases (case_id, token_hash) VALUES (?, ?)", params![case_id, case_token_hash(token)])?;
                Ok(())
            }
            Some(hash) if hash == case_token_hash(token) => Ok(()),
            Some(_) => Err(Fail::Denied(Denied::WrongToken)),
        }
    }

    pub fn pull(&self, case_id: &str, token: Option<&str>, after: f64) -> Result<Page, Fail> {
        let conn = self.lock();
        Self::authorize(&conn, case_id, token, false)?;
        let mut stmt = conn.prepare("SELECT seq, id, collection, sealed FROM records WHERE case_id = ? AND seq > ? ORDER BY seq LIMIT ?")?;
        let mut rows = Vec::new();
        let mut bytes = 0;
        for row in stmt.query_map(params![case_id, after, MAX_RECORDS_PER_PULL], |r| {
            Ok(StoredRow { seq: r.get(0)?, id: r.get(1)?, collection: r.get(2)?, sealed: r.get(3)? })
        })? {
            let row = row?;
            bytes += row.sealed.len();
            if !rows.is_empty() && bytes > MAX_PULL_PAGE_BYTES {
                break;
            }
            rows.push(row);
        }
        let head = Self::head(&conn, case_id)?;
        Ok(Page { rows, head })
    }

    fn head(conn: &Connection, case_id: &str) -> rusqlite::Result<i64> {
        conn.query_row("SELECT COALESCE(MAX(seq), 0) AS seq FROM records WHERE case_id = ?", [case_id], |r| r.get(0))
    }

    /// Append records (skipping exact duplicates) in one immediate transaction; returns the new head.
    pub fn push(&self, case_id: &str, token: Option<&str>, records: &[NewRecord]) -> Result<i64, Fail> {
        let mut conn = self.lock();
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        Self::authorize(&tx, case_id, token, true)?;
        {
            let mut add = tx.prepare(
                "INSERT INTO records (case_id, id, collection, sealed) SELECT ?, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM records WHERE case_id = ? AND id = ? AND collection = ? AND sealed = ?)",
            )?;
            for r in records {
                add.execute(params![case_id, r.id, r.collection, r.sealed, case_id, r.id, r.collection, r.sealed])?;
            }
        }
        tx.commit()?;
        Ok(Self::head(&conn, case_id)?)
    }
}
