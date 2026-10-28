//! Top-up payment intake, matching `packages/wallet/src/zcash`. A quote gives the client a fresh
//! address and an amount; the watcher reports when it has been paid. Quote records live in the
//! `quotes` table as `{ quote, state, invoiceId?, received? }`, the same JSON the TS relay wrote.

use std::sync::Arc;

use rusqlite::Connection;
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};

use super::store::{iso_time, now_ms, parse_iso, RelayDb};
use crate::features::payments::{Payments, Status};

pub const QUOTE_TTL_MS: u64 = 15 * 60 * 1000;

pub enum Watcher {
    /// No chain: payments are marked by hand. Labeled "simulated" everywhere.
    Simulated { usd_per_zec: f64 },
    /// Real shielded payments, seen by the in-process payment engine (viewing key only).
    Zcash { payments: Arc<Payments>, network: &'static str, usd_per_zec: f64 },
}

/// credits are µUSD; ZEC has 8 decimals. Rounds up so the relay is never short. Same float
/// steps as `creditsToZec`.
pub fn credits_to_zat(credits: u64, usd_per_zec: f64) -> u64 {
    ((credits as f64 / 1_000_000.0 / usd_per_zec) * 1e8).ceil() as u64
}

pub fn zat_to_zec(zat: u64) -> String {
    format!("{}.{:08}", zat / 100_000_000, zat % 100_000_000)
}

fn random_id() -> String {
    let mut bytes = [0u8; 16];
    getrandom::fill(&mut bytes).expect("system randomness");
    hex::encode(bytes)
}

fn record(conn: &Connection, quote_id: &str) -> Result<Map<String, Value>, String> {
    match RelayDb::get_quote_on(conn, quote_id).map_err(|e| e.to_string())? {
        Some(Value::Object(r)) => Ok(r),
        _ => Err("unknown quote".into()),
    }
}

fn state_of(r: &Map<String, Value>) -> String {
    r.get("state").and_then(Value::as_str).unwrap_or("").to_string()
}

impl Watcher {
    pub fn network(&self) -> &'static str {
        match self {
            Self::Simulated { .. } => "simulated",
            Self::Zcash { network, .. } => network,
        }
    }

    pub fn quote(&self, db: &RelayDb, credits: u64) -> Result<Value, String> {
        let quote_id = random_id();
        let (quote, invoice_id) = match self {
            Self::Simulated { usd_per_zec } => {
                let zec = zat_to_zec(credits_to_zat(credits, *usd_per_zec));
                // Looks like a unified address but is marked as simulated so it can't be mistaken for one.
                let address = format!("usim1{}", &hex::encode(Sha256::digest(quote_id.as_bytes()))[..58]);
                let quote = json!({ "quoteId": quote_id, "credits": credits, "zec": zec, "address": address, "expiresAt": iso_time(now_ms() + QUOTE_TTL_MS), "network": "simulated" });
                (quote, None)
            }
            Self::Zcash { payments, network, usd_per_zec } => {
                let zat = credits_to_zat(credits, *usd_per_zec);
                let invoice = payments.create_invoice(zat, &quote_id, QUOTE_TTL_MS / 1000).map_err(|e| e.to_string())?;
                let quote = json!({ "quoteId": quote_id, "credits": credits, "zec": zat_to_zec(zat), "address": invoice.address, "paymentUri": invoice.payment_uri, "expiresAt": iso_time(invoice.expires_at * 1000), "network": network });
                (quote, Some(invoice.id))
            }
        };
        let mut rec = json!({ "quote": quote, "state": "quoted" });
        if let Some(id) = invoice_id {
            rec["invoiceId"] = Value::String(id);
        }
        RelayDb::put_quote_on(&db.conn(), &quote_id, &rec).map_err(|e| e.to_string())?;
        Ok(quote)
    }

    /// Pull the latest payment status before `state` is read (real payments only).
    pub fn refresh(&self, db: &RelayDb, quote_id: &str) -> Result<(), String> {
        let Self::Zcash { payments, .. } = self else { return Ok(()) };
        let rec = record(&db.conn(), quote_id)?;
        let Some(invoice_id) = rec.get("invoiceId").and_then(Value::as_str) else { return Ok(()) };
        if state_of(&rec) == "minted" {
            return Ok(());
        }
        let status = payments.status(invoice_id).map_err(|e| e.to_string())?.ok_or("the payment engine lost this invoice")?;
        let state = match status.status {
            Status::Pending => "quoted",
            Status::Underpaid | Status::Detected => "paid",
            Status::Paid => "confirmed",
            Status::Expired => "expired",
        };
        let mut conn = db.conn();
        let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate).map_err(|e| e.to_string())?;
        // Re-read: a mint may have finished while we were asking.
        let mut latest = record(&tx, quote_id)?;
        if state_of(&latest) == "minted" {
            return Ok(());
        }
        latest.insert("state".into(), Value::String(state.into()));
        if status.received_zat > 0 {
            latest.insert("received".into(), Value::String(zat_to_zec(status.received_zat)));
        }
        RelayDb::put_quote_on(&tx, quote_id, &Value::Object(latest)).map_err(|e| e.to_string())?;
        tx.commit().map_err(|e| e.to_string())
    }

    /// The quote's state; an unpaid simulated quote past its expiry becomes `expired`.
    pub fn state_on(&self, conn: &Connection, quote_id: &str) -> Result<String, String> {
        let mut rec = record(conn, quote_id)?;
        let state = state_of(&rec);
        if matches!(self, Self::Simulated { .. }) && state == "quoted" {
            let expires = rec.get("quote").and_then(|q| q.get("expiresAt")).and_then(Value::as_str).and_then(parse_iso);
            if expires.is_some_and(|t| t < now_ms()) {
                rec.insert("state".into(), Value::String("expired".into()));
                RelayDb::put_quote_on(conn, quote_id, &Value::Object(rec)).map_err(|e| e.to_string())?;
                return Ok("expired".into());
            }
        }
        Ok(state)
    }

    pub fn state(&self, db: &RelayDb, quote_id: &str) -> Result<String, String> {
        self.state_on(&db.conn(), quote_id)
    }

    pub fn received(&self, db: &RelayDb, quote_id: &str) -> Option<String> {
        record(&db.conn(), quote_id).ok()?.get("received").and_then(Value::as_str).map(str::to_string)
    }

    /// The credits the quote pays for.
    pub fn credits(&self, db: &RelayDb, quote_id: &str) -> Result<u64, String> {
        let rec = record(&db.conn(), quote_id)?;
        rec.get("quote").and_then(|q| q.get("credits")).and_then(Value::as_u64).ok_or_else(|| "unknown quote".into())
    }

    /// Demo only: pretend the shielded payment for this quote arrived and confirmed.
    pub fn simulate(&self, db: &RelayDb, quote_id: &str) -> Result<(), String> {
        let conn = db.conn();
        let state = self.state_on(&conn, quote_id)?;
        if state != "quoted" {
            return Err(format!("quote is {state}"));
        }
        let mut rec = record(&conn, quote_id)?;
        rec.insert("state".into(), Value::String("confirmed".into()));
        RelayDb::put_quote_on(&conn, quote_id, &Value::Object(rec)).map_err(|e| e.to_string())
    }

    /// Confirmed → minted exactly once, inside the caller's transaction (which also stores the
    /// minted reply).
    pub fn mark_minted_on(&self, tx: &Connection, quote_id: &str) -> Result<(), String> {
        let state = self.state_on(tx, quote_id)?;
        if state != "confirmed" {
            return Err(format!("quote is {state}, not confirmed"));
        }
        let mut rec = record(tx, quote_id)?;
        rec.insert("state".into(), Value::String("minted".into()));
        RelayDb::put_quote_on(tx, quote_id, &Value::Object(rec)).map_err(|e| e.to_string())
    }
}
