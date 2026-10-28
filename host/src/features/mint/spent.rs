//! Spent coin secrets. Marking is atomic and all-or-nothing, and the caller's commit (for
//! example storing the paid answer) happens inside the same transaction.

use std::collections::HashSet;
use std::sync::Mutex;

use rusqlite::{params, Connection};

use super::CommitResult;

pub trait SpentStore {
    /// Marks every secret spent; `Ok(false)` (and nothing marked) if any was already spent or
    /// the list repeats a secret.
    fn mark_spent(&self, secrets: &[String], commit: &mut dyn FnMut() -> CommitResult) -> Result<bool, String>;
}

#[derive(Default)]
pub struct MemorySpentStore(Mutex<HashSet<String>>);

impl SpentStore for MemorySpentStore {
    fn mark_spent(&self, secrets: &[String], commit: &mut dyn FnMut() -> CommitResult) -> Result<bool, String> {
        let mut spent = self.0.lock().expect("spent set");
        let unique: HashSet<&String> = secrets.iter().collect();
        if unique.len() != secrets.len() || secrets.iter().any(|s| spent.contains(s)) {
            return Ok(false);
        }
        commit()?;
        spent.extend(secrets.iter().cloned());
        Ok(true)
    }
}

/// The `spent` table of `relay.db`, unchanged from the TypeScript relay.
pub struct SqliteSpentStore<'a>(pub &'a Mutex<Connection>);

pub const SPENT_SCHEMA: &str = "CREATE TABLE IF NOT EXISTS spent (secret TEXT PRIMARY KEY) WITHOUT ROWID;";

impl SpentStore for SqliteSpentStore<'_> {
    fn mark_spent(&self, secrets: &[String], commit: &mut dyn FnMut() -> CommitResult) -> Result<bool, String> {
        let unique: HashSet<&String> = secrets.iter().collect();
        if unique.len() != secrets.len() {
            return Ok(false);
        }
        let mut conn = self.0.lock().map_err(|e| e.to_string())?;
        let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate).map_err(|e| e.to_string())?;
        for s in secrets {
            let seen: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM spent WHERE secret = ?1)", params![s], |r| r.get(0)).map_err(|e| e.to_string())?;
            if seen {
                return Ok(false); // dropping the transaction rolls it back
            }
        }
        for s in secrets {
            tx.execute("INSERT INTO spent (secret) VALUES (?1)", params![s]).map_err(|e| e.to_string())?;
        }
        commit()?;
        tx.commit().map_err(|e| e.to_string())?;
        Ok(true)
    }
}
