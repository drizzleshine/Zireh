//! The mint: issues blind-signed coins for paid top-ups, burns coins when a call is paid, and
//! signs change. A port of `packages/wallet/src/mint.ts`; errors keep the same codes and words.

pub mod amounts;
pub mod bdhke;
pub mod keys;
pub mod pricing;
pub mod spent;

use serde::{Deserialize, Serialize};

use amounts::split_amount;
use bdhke::{sign_blinded, verify_token};
use keys::{Keypair, Keyset, MintKeys};
use spent::SpentStore;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct BlindedMessage {
    pub amount: u64,
    #[serde(rename = "B_")]
    pub b: String,
    #[serde(rename = "keysetId")]
    pub keyset_id: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct BlindSignature {
    pub amount: u64,
    #[serde(rename = "C_")]
    pub c: String,
    #[serde(rename = "keysetId")]
    pub keyset_id: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct Proof {
    pub amount: u64,
    pub secret: String,
    #[serde(rename = "C")]
    pub c: String,
    #[serde(rename = "keysetId")]
    pub keyset_id: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MintErrorCode {
    TokenInvalid,
    TokenSpent,
    BadRequest,
}

impl MintErrorCode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::TokenInvalid => "token_invalid",
            Self::TokenSpent => "token_spent",
            Self::BadRequest => "bad_request",
        }
    }
}

#[derive(Debug, PartialEq, Eq)]
pub struct MintError {
    pub code: MintErrorCode,
    pub message: String,
}

impl MintError {
    fn new(code: MintErrorCode, message: impl Into<String>) -> Self {
        Self { code, message: message.into() }
    }
}

impl std::fmt::Display for MintError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for MintError {}

pub fn total<T: HasAmount>(items: &[T]) -> u64 {
    items.iter().map(HasAmount::amount).sum()
}

pub trait HasAmount {
    fn amount(&self) -> u64;
}
impl HasAmount for BlindedMessage {
    fn amount(&self) -> u64 {
        self.amount
    }
}
impl HasAmount for Proof {
    fn amount(&self) -> u64 {
        self.amount
    }
}

pub struct Mint<S: SpentStore> {
    keys: MintKeys,
    spent: S,
}

impl<S: SpentStore> Mint<S> {
    pub fn new(keys: MintKeys, spent: S) -> Self {
        Self { keys, spent }
    }

    pub fn keyset(&self) -> Keyset {
        self.keys.keyset()
    }

    fn pair(&self, amount: u64, keyset_id: &str) -> Result<&Keypair, MintError> {
        if keyset_id != self.keys.id {
            return Err(MintError::new(MintErrorCode::BadRequest, "unknown keyset"));
        }
        self.keys.pairs.get(&amount).ok_or_else(|| MintError::new(MintErrorCode::BadRequest, format!("no key for amount {amount}")))
    }

    fn sign(&self, amount: u64, keyset_id: &str, blinded: &str) -> Result<BlindSignature, MintError> {
        let pair = self.pair(amount, keyset_id)?;
        // The TS mint throws on a malformed point; the relay reports it as a bad request.
        let c = sign_blinded(&pair.private_key, blinded).ok_or_else(|| MintError::new(MintErrorCode::BadRequest, "invalid blinded message"))?;
        Ok(BlindSignature { amount, c, keyset_id: keyset_id.to_string() })
    }

    /// Issue coins for a paid top-up. The outputs must add up to exactly `credits`.
    pub fn issue(&self, outputs: &[BlindedMessage], credits: u64) -> Result<Vec<BlindSignature>, MintError> {
        let sum = total(outputs);
        if sum != credits {
            return Err(MintError::new(MintErrorCode::BadRequest, format!("outputs total {sum}, expected {credits}")));
        }
        outputs.iter().map(|o| self.sign(o.amount, &o.keyset_id, &o.b)).collect()
    }

    /// Verify and burn coins. Returns their total. All-or-nothing; `commit` runs inside the
    /// same transaction that records them as spent.
    pub fn redeem(&self, proofs: &[Proof], commit: &mut dyn FnMut() -> CommitResult) -> Result<u64, RedeemError> {
        for p in proofs {
            let pair = self.pair(p.amount, &p.keyset_id)?;
            let secret = hex::decode(&p.secret).unwrap_or_default();
            if !verify_token(&pair.private_key, &secret, &p.c) {
                return Err(MintError::new(MintErrorCode::TokenInvalid, "a coin failed verification").into());
            }
        }
        let secrets: Vec<String> = proofs.iter().map(|p| p.secret.clone()).collect();
        match self.spent.mark_spent(&secrets, commit) {
            Ok(true) => Ok(total(proofs)),
            Ok(false) => Err(MintError::new(MintErrorCode::TokenSpent, "a coin was already spent").into()),
            Err(e) => Err(RedeemError::Storage(e)),
        }
    }

    /// Fill blank outputs with `change` (binary decomposition). Unused blanks stay unsigned.
    pub fn change(&self, blanks: &[BlindedMessage], change: u64) -> Result<Vec<BlindSignature>, MintError> {
        let amounts = split_amount(change);
        if amounts.len() > blanks.len() {
            return Err(MintError::new(MintErrorCode::BadRequest, "not enough blank outputs for change"));
        }
        amounts.iter().zip(blanks).map(|(amount, blank)| self.sign(*amount, &blank.keyset_id, &blank.b)).collect()
    }
}

/// Redeeming can fail on the coins (a `MintError`) or on storage (the caller's commit or the
/// database). The second is a server fault, never the client's.
#[derive(Debug)]
pub enum RedeemError {
    Mint(MintError),
    Storage(String),
}

impl From<MintError> for RedeemError {
    fn from(e: MintError) -> Self {
        Self::Mint(e)
    }
}

/// What a commit callback returns: an error message aborts the transaction.
pub type CommitResult = Result<(), String>;
