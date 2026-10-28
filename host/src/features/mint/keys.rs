//! The mint's private keys, one per denomination, in the same `mint-keys.json` the TypeScript
//! relay wrote, so coins issued before the switch stay spendable.

use std::collections::BTreeMap;
use std::fs;
use std::io::Write;
use std::path::Path;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use super::amounts::denominations;
use super::bdhke::{public_key_of, random_scalar, scalar_to_hex};

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Keypair {
    pub private_key: String,
    pub public_key: String,
}

/// `pairs` is keyed by amount; JSON writes the keys as strings in ascending numeric order,
/// which is also the order JavaScript gives integer-like keys.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct MintKeys {
    pub id: String,
    pub pairs: BTreeMap<u64, Keypair>,
}

/// What clients see in `/v1/info`: `{ id, unit: "credit", keys: { amount: publicKey } }`.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct Keyset {
    pub id: String,
    pub unit: String,
    pub keys: BTreeMap<u64, String>,
}

pub fn keyset_id(pairs: &BTreeMap<u64, Keypair>) -> String {
    let joined: String = denominations().filter_map(|d| pairs.get(&d)).map(|p| p.public_key.as_str()).collect();
    format!("zr{}", &hex::encode(Sha256::digest(joined.as_bytes()))[..14])
}

impl MintKeys {
    pub fn from_private_keys(private: impl IntoIterator<Item = (u64, String)>) -> Option<Self> {
        let pairs: BTreeMap<u64, Keypair> = private
            .into_iter()
            .map(|(amount, private_key)| Some((amount, Keypair { public_key: public_key_of(&private_key)?, private_key })))
            .collect::<Option<_>>()?;
        Some(Self { id: keyset_id(&pairs), pairs })
    }

    pub fn generate() -> Self {
        Self::from_private_keys(denominations().map(|d| (d, scalar_to_hex(&random_scalar())))).expect("random scalars are valid")
    }

    pub fn keyset(&self) -> Keyset {
        Keyset { id: self.id.clone(), unit: "credit".into(), keys: self.pairs.iter().map(|(a, p)| (*a, p.public_key.clone())).collect() }
    }

    /// Loads `<dir>/mint-keys.json`, or creates it owner-only. Losing it voids every coin.
    pub fn load_or_create(dir: &Path) -> std::io::Result<Self> {
        fs::create_dir_all(dir)?;
        let file = dir.join("mint-keys.json");
        if file.exists() {
            let keys: Self = serde_json::from_slice(&fs::read(&file)?).map_err(std::io::Error::other)?;
            return Ok(keys);
        }
        let keys = Self::generate();
        let mut options = fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
        options.open(&file)?.write_all(&serde_json::to_vec(&keys).map_err(std::io::Error::other)?)?;
        Ok(keys)
    }
}
