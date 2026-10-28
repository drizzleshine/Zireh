//! Shielded Zcash payment engine, adapted from ZecCheckout (github.com/samizdatproject/zeccheckout, MIT); see NOTICE.md.
//!
//! In-process library, no HTTP routes: the relay calls [`Payments`] directly. The engine holds only a
//! Unified Full Viewing Key (never a spending key), hands out one diversified address per invoice, and
//! watches the chain through a lightwalletd gRPC connection. That connection is the only network access.

pub mod invoice;
pub mod keygen;
pub mod keys;
pub mod scanner;
pub mod service;
pub mod store;

use std::sync::Arc;
use std::time::Duration;

use anyhow::Result;
use serde::Serialize;

pub use invoice::Status;
pub use service::Settings;

use service::{now, App, CreateInvoice};
use store::Db;

pub const DEFAULT_TESTNET_LIGHTWALLETD: &str = "https://testnet.zec.rocks:443";
pub const DEFAULT_MAINNET_LIGHTWALLETD: &str = "https://zec.rocks:443";

/// Default lightwalletd endpoint for `network` ("testnet" or "mainnet").
pub fn default_lightwalletd_url(network: &str) -> Result<&'static str> {
    match keys::parse_network(network)? {
        zcash_protocol::consensus::Network::MainNetwork => Ok(DEFAULT_MAINNET_LIGHTWALLETD),
        zcash_protocol::consensus::Network::TestNetwork => Ok(DEFAULT_TESTNET_LIGHTWALLETD),
    }
}

/// A newly created invoice.
#[derive(Clone, Debug, Serialize)]
pub struct InvoiceView {
    pub id: String,
    pub address: String,
    pub payment_uri: String,
    pub amount_zat: u64,
    pub expires_at: u64,
}

/// Payment progress for one invoice. `status` is one of pending, underpaid, detected, paid, expired.
#[derive(Clone, Debug, Serialize)]
pub struct StatusView {
    pub status: Status,
    pub received_zat: u64,
    pub confirmed_zat: u64,
}

/// Owns the database, the viewing key and the settings. Share it behind an `Arc`.
pub struct Payments {
    app: Arc<App>,
}

impl Payments {
    /// Opens (or creates) the SQLite file at `db_path` (`":memory:"` works too) for `network`
    /// ("testnet" or "mainnet") and the given UFVK.
    pub fn open(db_path: &str, network: &str, ufvk: &str, settings: Settings) -> Result<Self> {
        let network = keys::parse_network(network)?;
        let vk = keys::ViewingKey::parse(network, ufvk)?;
        let db = Db::open(db_path)?;
        Ok(Self { app: Arc::new(App::new(db, vk, settings)) })
    }

    /// Creates an invoice with its own shielded address. `order_id` is the caller's reference (may be
    /// empty). `ttl_secs` is clamped to between one minute and thirty days.
    pub fn create_invoice(&self, amount_zat: u64, order_id: &str, ttl_secs: u64) -> Result<InvoiceView> {
        let row = self.app.create_invoice(
            CreateInvoice {
                amount_zat,
                order_id: Some(order_id.to_owned()),
                description: None,
                expires_in_secs: Some(ttl_secs),
            },
            now(),
        )?;
        Ok(InvoiceView {
            id: row.id,
            address: row.address,
            payment_uri: row.uri,
            amount_zat: row.amount_zat,
            expires_at: row.expires_at,
        })
    }

    /// Current status of an invoice, or `None` if the id is unknown.
    pub fn status(&self, invoice_id: &str) -> Result<Option<StatusView>> {
        if !invoice::is_valid_invoice_id(invoice_id) {
            return Ok(None);
        }
        Ok(self.app.db.get_invoice(invoice_id)?.map(|r| StatusView {
            status: r.status,
            received_zat: r.received_zat,
            confirmed_zat: r.confirmed_zat,
        }))
    }

    /// Zatoshis paid to the invoice that are visible in the mempool but not mined yet. Advisory only;
    /// it never changes the invoice status.
    pub fn mempool_seen(&self, invoice_id: &str) -> u64 {
        self.app.mempool_seen_for(invoice_id)
    }

    /// Background scan loop: catches up to the chain tip, then polls every `poll`. Never returns;
    /// spawn it. `birthday` is the first block to scan on a fresh database (default: the current tip).
    pub async fn run_scanner(self: Arc<Self>, lightwalletd_url: String, poll: Duration, birthday: Option<u64>) {
        service::run_scanner(self.app.clone(), lightwalletd_url, poll, birthday).await
    }

    #[allow(dead_code)]
    pub(crate) fn app(&self) -> &App {
        &self.app
    }
}

impl std::fmt::Debug for Payments {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Payments").field("network", &self.app.vk.network_name()).finish()
    }
}

#[allow(dead_code)]
fn _assert_send_sync() {
    fn check<T: Send + Sync>() {}
    check::<Payments>();
    fn spawnable(p: Arc<Payments>) {
        tokio::spawn(p.run_scanner(String::new(), Duration::from_secs(1), None));
    }
    let _ = spawnable;
}

#[cfg(test)]
mod tests {
    use super::scanner::tests::{block, orchard_action, tx};
    use super::*;
    use crate::features::payments::keys::tests::{decode_ua, test_ufvk};
    use zcash_protocol::consensus::Network;

    fn payments() -> Payments {
        Payments::open(":memory:", "testnet", &test_ufvk().encode(&Network::TestNetwork), Settings::default()).unwrap()
    }

    #[test]
    fn public_api_end_to_end() {
        let p = payments();
        let inv = p.create_invoice(250_000, "ord_42", 600).unwrap();
        assert!(inv.address.starts_with("utest"));
        assert!(inv.payment_uri.starts_with(&format!("zcash:{}?amount=0.0025", inv.address)));
        assert_eq!(inv.amount_zat, 250_000);
        assert_eq!(p.status(&inv.id).unwrap().unwrap().status, Status::Pending);
        assert!(p.status(&"0".repeat(32)).unwrap().is_none());
        assert!(p.status("../etc").unwrap().is_none());

        let ua = decode_ua(&inv.address);
        let app = p.app();
        let b1 = block(1000, [0; 32], vec![]);
        app.apply_block(&b1).unwrap();
        let h1: [u8; 32] = b1.hash.clone().try_into().unwrap();
        let b2 = block(1001, h1, vec![tx(9, vec![], vec![orchard_action(ua.orchard().unwrap(), 250_000)])]);
        assert_eq!(app.apply_block(&b2).unwrap(), 1);
        app.refresh(1001, now()).unwrap();
        let s = p.status(&inv.id).unwrap().unwrap();
        assert_eq!((s.status, s.received_zat, s.confirmed_zat), (Status::Detected, 250_000, 0));
        let mut prev: [u8; 32] = b2.hash.clone().try_into().unwrap();
        for h in 1002..=1003 {
            let b = block(h, prev, vec![]);
            prev = b.hash.clone().try_into().unwrap();
            app.apply_block(&b).unwrap();
        }
        app.refresh(1003, now()).unwrap();
        let s = p.status(&inv.id).unwrap().unwrap();
        assert_eq!((s.status, s.confirmed_zat), (Status::Paid, 250_000));
    }

    #[test]
    fn open_rejects_bad_network_and_key() {
        let ufvk = test_ufvk().encode(&Network::TestNetwork);
        assert!(Payments::open(":memory:", "regtest", &ufvk, Settings::default()).is_err());
        assert!(Payments::open(":memory:", "mainnet", &ufvk, Settings::default()).is_err());
        assert!(Payments::open(":memory:", "testnet", "nonsense", Settings::default()).is_err());
    }

    #[test]
    fn default_lightwalletd_urls() {
        assert_eq!(default_lightwalletd_url("testnet").unwrap(), "https://testnet.zec.rocks:443");
        assert_eq!(default_lightwalletd_url("mainnet").unwrap(), "https://zec.rocks:443");
    }
}
