//! Blind Diffie-Hellman key exchange, as specified by Cashu NUT-00, matching `packages/crypto`.
//!
//!   Y  = hash_to_curve(secret)
//!   B_ = Y + r·G          (client blinds)
//!   C_ = k·B_             (mint signs, never sees Y)
//!   C  = C_ − r·K = k·Y   (client unblinds)
//!   verify: C == k·Y      (mint checks a spent token)
//!
//! Points travel as compressed hex; scalars as 32-byte hex.

use k256::elliptic_curve::group::{Group, GroupEncoding};
use k256::elliptic_curve::sec1::{FromEncodedPoint, ToEncodedPoint};
use k256::elliptic_curve::PrimeField;
use k256::{AffinePoint, EncodedPoint, ProjectivePoint, Scalar};
use sha2::{Digest, Sha256};

const DOMAIN: &[u8] = b"Secp256k1_HashToCurve_Cashu_";

pub fn hash_to_curve(secret: &[u8]) -> Option<ProjectivePoint> {
    let msg_hash = Sha256::new().chain_update(DOMAIN).chain_update(secret).finalize();
    for counter in 0u32..(1 << 16) {
        let x = Sha256::new().chain_update(msg_hash).chain_update(counter.to_le_bytes()).finalize();
        let mut compressed = [0u8; 33];
        compressed[0] = 0x02;
        compressed[1..].copy_from_slice(&x);
        if let Some(point) = point_from_bytes(&compressed) {
            return Some(point);
        }
    }
    None
}

/// A scalar in [1, n), from 64 hex characters.
pub fn scalar_from_hex(hex: &str) -> Option<Scalar> {
    let bytes: [u8; 32] = hex::decode(hex).ok()?.try_into().ok()?;
    let k: Scalar = Option::from(Scalar::from_repr(bytes.into()))?;
    (!bool::from(k.is_zero())).then_some(k)
}

pub fn scalar_to_hex(k: &Scalar) -> String {
    hex::encode(k.to_repr())
}

fn point_from_bytes(bytes: &[u8]) -> Option<ProjectivePoint> {
    let encoded = EncodedPoint::from_bytes(bytes).ok()?;
    let affine: AffinePoint = Option::from(AffinePoint::from_encoded_point(&encoded))?;
    Some(affine.into())
}

/// A point on the curve (not infinity), from compressed or uncompressed hex.
pub fn point_from_hex(hex: &str) -> Option<ProjectivePoint> {
    point_from_bytes(&hex::decode(hex).ok()?)
}

pub fn point_to_hex(p: &ProjectivePoint) -> String {
    hex::encode(p.to_affine().to_encoded_point(true).as_bytes())
}

pub fn public_key_of(private_key: &str) -> Option<String> {
    Some(point_to_hex(&(ProjectivePoint::GENERATOR * scalar_from_hex(private_key)?)))
}

/// A fresh random scalar, as `generateMintKeypair` makes them.
pub fn random_scalar() -> Scalar {
    loop {
        let mut bytes = [0u8; 32];
        getrandom::fill(&mut bytes).expect("system randomness");
        if let Some(k) = scalar_from_hex(&hex::encode(bytes)) {
            return k;
        }
    }
}

/// Client side, used by tests: B_ = Y + r·G.
pub fn blind(secret: &[u8], r: &str) -> Option<String> {
    Some(point_to_hex(&(hash_to_curve(secret)? + ProjectivePoint::GENERATOR * scalar_from_hex(r)?)))
}

/// Mint side: C_ = k·B_.
pub fn sign_blinded(private_key: &str, blinded: &str) -> Option<String> {
    let c = point_from_hex(blinded)? * scalar_from_hex(private_key)?;
    (!bool::from(c.is_identity())).then(|| point_to_hex(&c))
}

/// Client side, used by tests: C = C_ − r·K.
pub fn unblind(signed: &str, r: &str, public_key: &str) -> Option<String> {
    Some(point_to_hex(&(point_from_hex(signed)? - point_from_hex(public_key)? * scalar_from_hex(r)?)))
}

/// Mint side: a token (secret, C) is valid iff C == k·hash_to_curve(secret).
pub fn verify_token(private_key: &str, secret: &[u8], c: &str) -> bool {
    let (Some(k), Some(y), Some(c)) = (scalar_from_hex(private_key), hash_to_curve(secret), point_from_hex(c)) else {
        return false;
    };
    (y * k).to_bytes() == c.to_bytes()
}
