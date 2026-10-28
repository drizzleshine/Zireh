//! The Rust mint against values computed by the TypeScript wallet and relay
//! (`scripts/mint-vectors.ts` → `fixtures/mint-vectors.json`). Browsers keep running the TS code,
//! so every byte here has to match.

use std::sync::Mutex;

use rusqlite::Connection;
use serde_json::Value;
use zireh_host::features::mint::amounts::{blank_output_count, split_amount};
use zireh_host::features::mint::bdhke::{blind, hash_to_curve, point_to_hex, public_key_of, sign_blinded, unblind, verify_token};
use zireh_host::features::mint::keys::MintKeys;
use zireh_host::features::mint::pricing::{actual_cost, input_token_bound, max_cost, ModelPrice};
use zireh_host::features::mint::spent::{MemorySpentStore, SpentStore, SqliteSpentStore, SPENT_SCHEMA};
use zireh_host::features::mint::{BlindedMessage, Mint, MintErrorCode, Proof, RedeemError};
use zireh_host::js::canonical_json;

fn vectors() -> Value {
    serde_json::from_str(include_str!("fixtures/mint-vectors.json")).unwrap()
}

fn s<'a>(v: &'a Value, key: &str) -> &'a str {
    v[key].as_str().unwrap_or_else(|| panic!("{key} missing"))
}

#[test]
fn hash_to_curve_matches_nut00_and_typescript() {
    for case in vectors()["hashToCurve"].as_array().unwrap() {
        let y = hash_to_curve(&hex::decode(s(case, "secret")).unwrap()).unwrap();
        assert_eq!(point_to_hex(&y), s(case, "Y"), "secret {}", s(case, "secret"));
    }
}

#[test]
fn blind_sign_unblind_verify_match_typescript() {
    for case in vectors()["bdhke"].as_array().unwrap() {
        let secret = hex::decode(s(case, "secret")).unwrap();
        assert_eq!(public_key_of(s(case, "k")).unwrap(), s(case, "K"));
        assert_eq!(blind(&secret, s(case, "r")).unwrap(), s(case, "B_"));
        assert_eq!(sign_blinded(s(case, "k"), s(case, "B_")).unwrap(), s(case, "C_"));
        assert_eq!(unblind(s(case, "C_"), s(case, "r"), s(case, "K")).unwrap(), s(case, "C"));
        assert_eq!(verify_token(s(case, "k"), &secret, s(case, "C")), case["valid"].as_bool().unwrap());
        assert!(!verify_token(s(case, "k"), b"another secret", s(case, "C")));
        assert!(!case["wrongKeyValid"].as_bool().unwrap());
    }
}

#[test]
fn keyset_id_json_and_key_file_match_typescript() {
    let v = vectors();
    let ks = &v["keyset"];
    let private: Vec<(u64, String)> = ks["privateKeys"].as_object().unwrap().iter().map(|(a, k)| (a.parse().unwrap(), k.as_str().unwrap().to_string())).collect();
    let keys = MintKeys::from_private_keys(private).unwrap();
    assert_eq!(keys.id, s(ks, "id"));
    assert_eq!(serde_json::to_string(&keys.keyset()).unwrap(), s(ks, "json"));
    assert_eq!(serde_json::to_string(&keys).unwrap(), s(ks, "mintKeysFile"));
    // A key file written by the TypeScript relay loads unchanged.
    let loaded: MintKeys = serde_json::from_str(s(ks, "mintKeysFile")).unwrap();
    assert_eq!(loaded, keys);
}

#[test]
fn change_and_blank_outputs_match_typescript() {
    let v = vectors();
    for case in v["splitAmount"].as_array().unwrap() {
        let coins: Vec<u64> = case["coins"].as_array().unwrap().iter().map(|c| c.as_u64().unwrap()).collect();
        assert_eq!(split_amount(case["total"].as_u64().unwrap()), coins, "{}", case["total"]);
    }
    for case in v["blankOutputCount"].as_array().unwrap() {
        assert_eq!(blank_output_count(case["max"].as_u64().unwrap()), case["count"].as_u64().unwrap(), "{}", case["max"]);
    }
}

#[test]
fn prices_match_typescript_including_utf16_lengths() {
    let cases = vectors()["pricing"].as_array().unwrap().clone();
    assert_eq!(cases.len(), 60);
    for case in &cases {
        let p = &case["price"];
        let price = ModelPrice { model: s(p, "model").into(), input_per_mtok: p["inputPerMTok"].as_f64().unwrap(), output_per_mtok: p["outputPerMTok"].as_f64().unwrap() };
        let contents: Vec<&str> = case["messages"].as_array().unwrap().iter().map(|m| s(m, "content")).collect();
        let max_tokens = case["maxTokens"].as_u64().unwrap();
        assert_eq!(input_token_bound(contents.iter().copied()), case["inputTokenBound"].as_u64().unwrap(), "{case}");
        assert_eq!(max_cost(&price, contents.iter().copied(), max_tokens), case["maxCost"].as_u64().unwrap(), "{case}");
        let u = &case["usage"];
        assert_eq!(actual_cost(&price, u["prompt_tokens"].as_u64().unwrap(), u["completion_tokens"].as_u64().unwrap()), case["actualCost"].as_u64().unwrap(), "{case}");
    }
}

#[test]
fn canonical_json_matches_typescript() {
    for case in vectors()["canonicalJson"].as_array().unwrap() {
        let text = canonical_json(&case["value"]);
        assert_eq!(text, s(case, "text"));
        assert_eq!(hex::encode(<sha2::Sha256 as sha2::Digest>::digest(text.as_bytes())), s(case, "sha256"));
    }
}

fn test_mint<S: SpentStore>(spent: S) -> (Mint<S>, MintKeys) {
    let keys = MintKeys::generate();
    (Mint::new(keys.clone(), spent), keys)
}

/// Client side of a coin: blind with a fixed r, have the mint sign, unblind.
fn coin<S: SpentStore>(mint: &Mint<S>, keys: &MintKeys, amount: u64, seed: u8) -> Proof {
    let secret = hex::encode([seed; 32]);
    let r = hex::encode([seed.wrapping_add(1).max(1); 32]);
    let b = blind(&hex::decode(&secret).unwrap(), &r).unwrap();
    let sig = mint.issue(&[BlindedMessage { amount, b, keyset_id: keys.id.clone() }], amount).unwrap().remove(0);
    let c = unblind(&sig.c, &r, &keys.pairs[&amount].public_key).unwrap();
    Proof { amount, secret, c, keyset_id: keys.id.clone() }
}

fn redeem_code<S: SpentStore>(mint: &Mint<S>, proofs: &[Proof]) -> Result<u64, &'static str> {
    mint.redeem(proofs, &mut |_| Ok(())).map_err(|e| match e {
        RedeemError::Mint(e) => e.code.as_str(),
        RedeemError::Storage(_) => "storage",
    })
}

#[test]
fn mint_issues_burns_once_and_signs_change() {
    let (mint, keys) = test_mint(MemorySpentStore::default());
    let blank = |seed: u8| BlindedMessage { amount: 0, b: blind(&[seed; 32], &hex::encode([7u8; 32])).unwrap(), keyset_id: keys.id.clone() };

    let err = mint.issue(&[BlindedMessage { amount: 4, ..blank(1) }], 5).unwrap_err();
    assert_eq!((err.code, err.message.as_str()), (MintErrorCode::BadRequest, "outputs total 4, expected 5"));
    assert_eq!(mint.issue(&[BlindedMessage { amount: 3, ..blank(1) }], 3).unwrap_err().message, "no key for amount 3");
    assert_eq!(mint.issue(&[BlindedMessage { amount: 2, keyset_id: "zrother".into(), ..blank(1) }], 2).unwrap_err().message, "unknown keyset");

    let a = coin(&mint, &keys, 8, 10);
    let b = coin(&mint, &keys, 2, 20);
    assert_eq!(redeem_code(&mint, &[a.clone(), b.clone()]), Ok(10));
    assert_eq!(redeem_code(&mint, &[a.clone()]), Err("token_spent"));

    let forged = Proof { c: coin(&mint, &keys, 8, 30).c, ..coin(&mint, &keys, 8, 40) };
    assert_eq!(redeem_code(&mint, &[forged]), Err("token_invalid"));
    let fresh = coin(&mint, &keys, 1, 50);
    assert_eq!(redeem_code(&mint, &[fresh.clone(), fresh]), Err("token_spent"), "a repeated coin in one payment");

    let change = mint.change(&[blank(1), blank(2), blank(3)], 13);
    assert_eq!(change.as_ref().map(|c| c.iter().map(|s| s.amount).collect::<Vec<_>>()), Ok(vec![8, 4, 1]));
    assert_eq!(mint.change(&[blank(1)], 3).unwrap_err().message, "not enough blank outputs for change");
    assert_eq!(mint.change(&[], 0), Ok(vec![]));
}

#[test]
fn sqlite_spent_store_is_atomic_and_rolls_back_when_the_commit_fails() {
    let conn = Connection::open_in_memory().unwrap();
    conn.execute_batch(SPENT_SCHEMA).unwrap();
    let db = Mutex::new(conn);
    let store = SqliteSpentStore(&db);
    let ab = ["a".to_string(), "b".to_string()];

    assert_eq!(store.mark_spent(&ab, &mut |_| Err("disk full".into())), Err("disk full".into()));
    assert_eq!(store.mark_spent(&ab, &mut |_| Ok(())), Ok(true), "the failed attempt left nothing behind");
    assert_eq!(store.mark_spent(&["b".into(), "c".into()], &mut |_| Ok(())), Ok(false));
    assert_eq!(store.mark_spent(&["c".into()], &mut |_| Ok(())), Ok(true), "c was not marked by the refused batch");
    assert_eq!(store.mark_spent(&["d".into(), "d".into()], &mut |_| Ok(())), Ok(false));
    let count: i64 = db.lock().unwrap().query_row("SELECT COUNT(*) FROM spent", [], |r| r.get(0)).unwrap();
    assert_eq!(count, 3);
}
