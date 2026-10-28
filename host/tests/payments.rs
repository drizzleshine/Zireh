//! Public API of the in-process payment engine (no network: the scanner is not started).

use std::sync::Arc;

use zireh_host::features::payments::{keygen, Payments, Settings, Status};

fn payments() -> Arc<Payments> {
    let w = keygen::testnet_wallet().unwrap();
    Arc::new(Payments::open(":memory:", "testnet", &w.ufvk, Settings::default()).unwrap())
}

#[test]
fn invoices_have_distinct_shielded_addresses_and_start_pending() {
    let p = payments();
    let a = p.create_invoice(100_000, "order-1", 600).unwrap();
    let b = p.create_invoice(200_000, "order-2", 600).unwrap();
    assert_ne!(a.id, b.id);
    assert_ne!(a.address, b.address);
    assert!(a.address.starts_with("utest1"));
    assert!(a.payment_uri.starts_with(&format!("zcash:{}?amount=0.001", a.address)));
    assert_eq!(a.amount_zat, 100_000);
    let s = p.status(&a.id).unwrap().unwrap();
    assert_eq!((s.status, s.received_zat, s.confirmed_zat), (Status::Pending, 0, 0));
}

#[test]
fn bad_input_is_rejected_and_unknown_ids_are_none() {
    let p = payments();
    assert!(p.create_invoice(0, "x", 600).is_err());
    assert!(p.create_invoice(1, "bad\nline", 600).is_err());
    assert!(p.status(&"a".repeat(32)).unwrap().is_none());
    assert!(p.status("not-an-id").unwrap().is_none());
}

#[test]
fn ttl_is_applied_per_call() {
    let p = payments();
    let short = p.create_invoice(1, "", 120).unwrap();
    let long = p.create_invoice(1, "", 7200).unwrap();
    assert!(long.expires_at - short.expires_at >= 7000);
}

#[test]
fn keys_must_match_the_network() {
    let w = keygen::testnet_wallet().unwrap();
    assert!(Payments::open(":memory:", "mainnet", &w.ufvk, Settings::default()).is_err());
}

#[test]
fn state_persists_in_a_file_database() {
    let w = keygen::testnet_wallet().unwrap();
    let path = std::env::temp_dir().join(format!("zireh-payments-{}.db", std::process::id()));
    let path = path.to_str().unwrap().to_owned();
    let (id, addr) = {
        let p = Payments::open(&path, "testnet", &w.ufvk, Settings::default()).unwrap();
        let i = p.create_invoice(5, "o", 600).unwrap();
        (i.id, i.address)
    };
    let p = Payments::open(&path, "testnet", &w.ufvk, Settings::default()).unwrap();
    assert!(p.status(&id).unwrap().is_some());
    // Diversifier indices keep increasing across restarts: no address is reused.
    let next = p.create_invoice(5, "o2", 600).unwrap();
    assert_ne!(next.address, addr);
    for ext in ["", "-wal", "-shm"] {
        let _ = std::fs::remove_file(format!("{path}{ext}"));
    }
}
