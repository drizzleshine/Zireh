//! SQLite persistence. A single connection behind a mutex; all operations are
//! short. Memos are never stored (we never fetch them), and request metadata
//! such as client IPs is never written anywhere.

use anyhow::{anyhow, Result};
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use std::sync::Mutex;

use super::invoice::{Received, Status};

pub struct Db {
    conn: Mutex<Connection>,
}

#[derive(Clone, Debug, Serialize)]
pub struct InvoiceRow {
    pub id: String,
    pub order_id: Option<String>,
    pub description: Option<String>,
    pub amount_zat: u64,
    pub div_index: u64,
    pub address: String,
    pub uri: String,
    pub created_at: u64,
    pub expires_at: u64,
    pub status: Status,
    pub received_zat: u64,
    pub confirmed_zat: u64,
    pub paid_at: Option<u64>,
    pub paid_height: Option<u64>,
}

pub struct NewInvoice<'a> {
    pub id: &'a str,
    pub order_id: Option<&'a str>,
    pub description: Option<&'a str>,
    pub amount_zat: u64,
    pub div_index: u64,
    pub address: &'a str,
    pub uri: &'a str,
    pub created_at: u64,
    pub expires_at: u64,
}

#[derive(Clone, Debug)]
pub struct NoteRow {
    pub invoice_id: String,
    pub pool: &'static str,
    pub txid: [u8; 32],
    pub output_index: u32,
    pub value_zat: u64,
    pub height: u64,
}

const SCHEMA: &str = r#"
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS invoices (
    id TEXT PRIMARY KEY,
    order_id TEXT,
    description TEXT,
    amount_zat INTEGER NOT NULL,
    div_index INTEGER NOT NULL UNIQUE,
    address TEXT NOT NULL UNIQUE,
    uri TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    status TEXT NOT NULL,
    received_zat INTEGER NOT NULL DEFAULT 0,
    confirmed_zat INTEGER NOT NULL DEFAULT 0,
    paid_at INTEGER,
    paid_height INTEGER
);
CREATE INDEX IF NOT EXISTS invoices_status ON invoices(status);
CREATE TABLE IF NOT EXISTS notes (
    id INTEGER PRIMARY KEY,
    invoice_id TEXT NOT NULL REFERENCES invoices(id),
    pool TEXT NOT NULL,
    txid BLOB NOT NULL,
    output_index INTEGER NOT NULL,
    value_zat INTEGER NOT NULL,
    height INTEGER NOT NULL,
    UNIQUE (txid, pool, output_index)
);
CREATE INDEX IF NOT EXISTS notes_invoice ON notes(invoice_id);
CREATE TABLE IF NOT EXISTS blocks (height INTEGER PRIMARY KEY, hash BLOB NOT NULL);
"#;

fn row_to_invoice(r: &rusqlite::Row<'_>) -> rusqlite::Result<InvoiceRow> {
    let status: String = r.get("status")?;
    Ok(InvoiceRow {
        id: r.get("id")?,
        order_id: r.get("order_id")?,
        description: r.get("description")?,
        amount_zat: r.get::<_, i64>("amount_zat")? as u64,
        div_index: r.get::<_, i64>("div_index")? as u64,
        address: r.get("address")?,
        uri: r.get("uri")?,
        created_at: r.get::<_, i64>("created_at")? as u64,
        expires_at: r.get::<_, i64>("expires_at")? as u64,
        status: Status::parse(&status).unwrap_or(Status::Pending),
        received_zat: r.get::<_, i64>("received_zat")? as u64,
        confirmed_zat: r.get::<_, i64>("confirmed_zat")? as u64,
        paid_at: r.get::<_, Option<i64>>("paid_at")?.map(|v| v as u64),
        paid_height: r.get::<_, Option<i64>>("paid_height")?.map(|v| v as u64),
    })
}

impl Db {
    pub fn open(path: &str) -> Result<Self> {
        let conn = if path == ":memory:" {
            Connection::open_in_memory()?
        } else {
            Connection::open(path)?
        };
        conn.execute_batch(SCHEMA)?;
        Ok(Self {
            conn: Mutex::new(conn),
        })
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Connection> {
        self.conn.lock().unwrap_or_else(|p| p.into_inner())
    }

    pub fn get_meta(&self, key: &str) -> Result<Option<String>> {
        Ok(self
            .lock()
            .query_row("SELECT value FROM meta WHERE key = ?1", [key], |r| r.get(0))
            .optional()?)
    }

    pub fn set_meta(&self, key: &str, value: &str) -> Result<()> {
        self.lock().execute(
            "INSERT INTO meta(key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![key, value],
        )?;
        Ok(())
    }

    pub fn get_meta_u64(&self, key: &str) -> Result<Option<u64>> {
        self.get_meta(key)?
            .map(|v| v.parse::<u64>().map_err(|e| anyhow!("meta {key}: {e}")))
            .transpose()
    }

    /// Next diversifier index to try (monotonic, never reused).
    pub fn max_div_index(&self) -> Result<Option<u64>> {
        Ok(self
            .lock()
            .query_row("SELECT MAX(div_index) FROM invoices", [], |r| r.get::<_, Option<i64>>(0))?
            .map(|v| v as u64))
    }

    pub fn insert_invoice(&self, n: &NewInvoice<'_>) -> Result<()> {
        self.lock().execute(
            "INSERT INTO invoices (id, order_id, description, amount_zat, div_index, address, uri, created_at, expires_at, status)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 'pending')",
            params![
                n.id,
                n.order_id,
                n.description,
                n.amount_zat as i64,
                n.div_index as i64,
                n.address,
                n.uri,
                n.created_at as i64,
                n.expires_at as i64
            ],
        )?;
        Ok(())
    }

    pub fn get_invoice(&self, id: &str) -> Result<Option<InvoiceRow>> {
        Ok(self
            .lock()
            .query_row("SELECT * FROM invoices WHERE id = ?1", [id], row_to_invoice)
            .optional()?)
    }

    pub fn list_invoices(&self, limit: u32) -> Result<Vec<InvoiceRow>> {
        let c = self.lock();
        let mut st = c.prepare("SELECT * FROM invoices ORDER BY created_at DESC, id LIMIT ?1")?;
        let rows = st
            .query_map([limit], row_to_invoice)?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    }

    /// Invoices whose status can still change.
    pub fn open_invoices(&self) -> Result<Vec<InvoiceRow>> {
        let c = self.lock();
        let mut st = c.prepare("SELECT * FROM invoices WHERE status != 'paid'")?;
        let rows = st
            .query_map([], row_to_invoice)?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    }

    pub fn invoice_id_by_div_index(&self, j: u64) -> Result<Option<String>> {
        Ok(self
            .lock()
            .query_row("SELECT id FROM invoices WHERE div_index = ?1", [j as i64], |r| r.get(0))
            .optional()?)
    }

    pub fn received_for(&self, invoice_id: &str) -> Result<Vec<Received>> {
        let c = self.lock();
        let mut st = c.prepare("SELECT value_zat, height FROM notes WHERE invoice_id = ?1")?;
        let rows = st
            .query_map([invoice_id], |r| {
                Ok(Received {
                    value_zat: r.get::<_, i64>(0)? as u64,
                    height: r.get::<_, i64>(1)? as u64,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    }

    pub fn update_invoice_state(
        &self,
        id: &str,
        status: Status,
        received_zat: u64,
        confirmed_zat: u64,
        paid_at: Option<u64>,
        paid_height: Option<u64>,
    ) -> Result<()> {
        self.lock().execute(
            "UPDATE invoices SET status = ?2, received_zat = ?3, confirmed_zat = ?4,
                 paid_at = COALESCE(paid_at, ?5), paid_height = COALESCE(paid_height, ?6)
             WHERE id = ?1",
            params![
                id,
                status.as_str(),
                received_zat as i64,
                confirmed_zat as i64,
                paid_at.map(|v| v as i64),
                paid_height.map(|v| v as i64)
            ],
        )?;
        Ok(())
    }

    /// Atomically records the outputs found in one block, the block hash and
    /// the new scan height.
    pub fn commit_block(&self, height: u64, hash: &[u8], notes: &[NoteRow]) -> Result<()> {
        let mut c = self.lock();
        let tx = c.transaction()?;
        for n in notes {
            tx.execute(
                "INSERT OR IGNORE INTO notes (invoice_id, pool, txid, output_index, value_zat, height)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![
                    n.invoice_id,
                    n.pool,
                    &n.txid[..],
                    n.output_index,
                    n.value_zat as i64,
                    n.height as i64
                ],
            )?;
        }
        tx.execute(
            "INSERT OR REPLACE INTO blocks (height, hash) VALUES (?1, ?2)",
            params![height as i64, hash],
        )?;
        tx.execute(
            "DELETE FROM blocks WHERE height < ?1",
            [height.saturating_sub(1000) as i64],
        )?;
        tx.execute(
            "INSERT INTO meta(key, value) VALUES ('scan_height', ?1) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            [height.to_string()],
        )?;
        tx.commit()?;
        Ok(())
    }

    pub fn block_hash(&self, height: u64) -> Result<Option<Vec<u8>>> {
        Ok(self
            .lock()
            .query_row("SELECT hash FROM blocks WHERE height = ?1", [height as i64], |r| r.get(0))
            .optional()?)
    }

    /// Reorg handling: forget everything at or above `height`.
    pub fn rollback_to(&self, height: u64) -> Result<()> {
        let mut c = self.lock();
        let tx = c.transaction()?;
        tx.execute("DELETE FROM notes WHERE height >= ?1", [height as i64])?;
        tx.execute("DELETE FROM blocks WHERE height >= ?1", [height as i64])?;
        tx.execute(
            "INSERT INTO meta(key, value) VALUES ('scan_height', ?1) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            [height.saturating_sub(1).to_string()],
        )?;
        tx.commit()?;
        Ok(())
    }
}
