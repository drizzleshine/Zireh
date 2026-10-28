//! Throwaway testnet wallet creation, for demos and tests only.
//!
//! Adapted from ZecCheckout's `zc-keygen` helper. The payment engine itself never
//! loads, parses or needs a seed or spending key; it only takes the UFVK. This is
//! deliberately testnet-only: for mainnet, export a UFVK from your own wallet.

use anyhow::{anyhow, Result};
use rand::RngCore;
use zcash_keys::address::Address;
use zcash_keys::keys::{ReceiverRequirement, UnifiedAddressRequest, UnifiedSpendingKey};
use zcash_protocol::consensus::Network;

/// A freshly generated testnet wallet. The seed phrase is a secret: show it to
/// the operator once and never store it next to the viewing key.
pub struct TestnetWallet {
    /// 24-word BIP-39 mnemonic.
    pub seed_phrase: String,
    /// Unified full viewing key (`uviewtest1...`), the only thing the server needs.
    pub ufvk: String,
    /// Default Orchard + Sapling unified address (`utest1...`).
    pub unified_address: String,
    /// Sapling-only address, for faucets and wallets that want one.
    pub sapling_address: Option<String>,
}

/// Creates a throwaway testnet wallet (account 0).
pub fn testnet_wallet() -> Result<TestnetWallet> {
    let network = Network::TestNetwork;
    let mut entropy = [0u8; 32];
    rand::rngs::OsRng.fill_bytes(&mut entropy);
    let mnemonic = bip39::Mnemonic::from_entropy(&entropy)?;
    let seed = mnemonic.to_seed("");
    let usk = UnifiedSpendingKey::from_seed(&network, &seed, zip32::AccountId::ZERO)
        .map_err(|e| anyhow!("{e:?}"))?;
    let ufvk = usk.to_unified_full_viewing_key();
    let (ua, _) = ufvk
        .default_address(
            UnifiedAddressRequest::custom(
                ReceiverRequirement::Require,
                ReceiverRequirement::Require,
                ReceiverRequirement::Omit,
            )
            .map_err(|e| anyhow!("{e:?}"))?,
        )
        .map_err(|e| anyhow!("{e:?}"))?;
    Ok(TestnetWallet {
        seed_phrase: mnemonic.to_string(),
        ufvk: ufvk.encode(&network),
        unified_address: ua.encode(&network),
        sapling_address: ua.sapling().map(|s| Address::Sapling(*s).encode(&network)),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::features::payments::keys::ViewingKey;

    #[test]
    fn wallet_is_testnet_and_usable_by_the_engine() {
        let w = testnet_wallet().unwrap();
        assert_eq!(w.seed_phrase.split_whitespace().count(), 24);
        assert!(w.ufvk.starts_with("uviewtest"));
        assert!(w.unified_address.starts_with("utest"));
        assert!(ViewingKey::parse(Network::TestNetwork, &w.ufvk).is_ok());
        assert!(ViewingKey::parse(Network::MainNetwork, &w.ufvk).is_err());
        assert_ne!(w.seed_phrase, testnet_wallet().unwrap().seed_phrase);
    }
}
