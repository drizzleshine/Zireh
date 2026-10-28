//! Relay settings from the environment (the TypeScript relay's names).
//!
//! Upstream modes:
//!  - token-factory: NEBIUS_API_KEY set; models served by Nebius Token Factory.
//!  - local-dev: no key; calls go to a local OpenAI-compatible model (Ollama) so everything runs
//!    end to end. The offered model is the local one, never labeled as Token Factory.
//!
//! Payments: simulated unless ZCASH_UFVK (or ZCASH_UFVK_FILE) is set, then real shielded Zcash on
//! ZCASH_NETWORK (testnet unless set), watched in-process with that viewing key.

use crate::features::mint::pricing::ModelPrice;

#[derive(Clone, Debug, PartialEq)]
pub enum Upstream {
    TokenFactory { base_url: String, api_key: String },
    LocalDev { base_url: String, local_model: String },
}

#[derive(Clone, Debug, PartialEq)]
pub struct Zcash {
    pub network: &'static str,
    pub ufvk: String,
    pub lightwalletd: Option<String>,
    pub birthday: Option<u64>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct RelayConfig {
    pub data_dir: String,
    pub demo: Option<(u64, u64)>, // (quote limit, daily limit), credits
    pub upstream: Upstream,
    pub prices: Vec<ModelPrice>,
    pub tavily_api_key: Option<String>,
    /// Tavily's endpoint; TAVILY_URL overrides it (self-hosted proxies, tests).
    pub tavily_url: String,
    pub search_price: u64,
    pub usd_per_zec: f64,
    pub zcash: Option<Zcash>,
}

/// µUSD per 1M tokens: provider list price plus a 20% relay margin.
fn with_margin(model: &str, usd_in: f64, usd_out: f64) -> ModelPrice {
    ModelPrice { model: model.into(), input_per_mtok: (usd_in * 1.2 * 1e6).ceil(), output_per_mtok: (usd_out * 1.2 * 1e6).ceil() }
}

pub fn default_models() -> Vec<ModelPrice> {
    vec![with_margin("nvidia/nemotron-3-super-120b-a12b", 0.3, 0.9), with_margin("nvidia/Llama-3_1-Nemotron-Ultra-253B-v1", 0.6, 1.8)]
}

/// RELAY_MODELS="id:usdIn:usdOut,id:usdIn:usdOut" overrides the defaults.
fn parse_models(spec: Option<String>) -> Result<Vec<ModelPrice>, String> {
    let Some(spec) = spec else { return Ok(default_models()) };
    spec.split(',')
        .map(|entry| {
            let parts: Vec<&str> = entry.split(':').collect();
            match parts.as_slice() {
                [model, usd_in, usd_out] if !model.is_empty() && !usd_in.is_empty() && !usd_out.is_empty() => {
                    let num = |s: &str| s.parse::<f64>().map_err(|_| format!("bad RELAY_MODELS entry: {entry}"));
                    Ok(with_margin(model, num(usd_in)?, num(usd_out)?))
                }
                _ => Err(format!("bad RELAY_MODELS entry: {entry}")),
            }
        })
        .collect()
}

fn trimmed(get: &impl Fn(&str) -> Option<String>, key: &str) -> Option<String> {
    get(key).map(|v| v.trim().to_string()).filter(|v| !v.is_empty())
}

fn limit(get: &impl Fn(&str) -> Option<String>, key: &str, fallback: u64) -> Result<u64, String> {
    match get(key) {
        None => Ok(fallback),
        Some(v) => v.trim().parse::<u64>().ok().filter(|n| *n >= 1 && *n <= 9_007_199_254_740_991).ok_or_else(|| format!("{key} must be a positive safe integer")),
    }
}

impl RelayConfig {
    pub fn from_lookup(get: impl Fn(&str) -> Option<String>) -> Result<Self, String> {
        let api_key = trimmed(&get, "NEBIUS_API_KEY");
        let tavily_api_key = trimmed(&get, "TAVILY_API_KEY");
        let demo = get("RELAY_DEMO").as_deref() == Some("1");
        let zcash = Self::zcash(&get)?;
        // Simulated and testnet coins are free, so anything they buy from a paid provider is ours to pay.
        if (api_key.is_some() || tavily_api_key.is_some()) && !demo && zcash.as_ref().map(|z| z.network) != Some("mainnet") {
            return Err("Simulated or testnet payments cannot fund paid providers. Set RELAY_DEMO=1 to explicitly enable a capped demo.".into());
        }
        let demo = if demo { Some((limit(&get, "RELAY_DEMO_QUOTE_LIMIT", 5_000_000)?, limit(&get, "RELAY_DEMO_DAILY_LIMIT", 20_000_000)?)) } else { None };
        let upstream = match api_key {
            Some(api_key) => Upstream::TokenFactory { base_url: get("NEBIUS_BASE_URL").unwrap_or_else(|| "https://api.tokenfactory.nebius.com/v1".into()), api_key },
            None => Upstream::LocalDev {
                base_url: get("OLLAMA_URL").unwrap_or_else(|| "http://127.0.0.1:11434/v1".into()),
                local_model: get("LOCAL_MODEL").unwrap_or_else(|| "nemotron-3-nano:4b".into()),
            },
        };
        let number = |key: &str, fallback: f64| -> Result<f64, String> {
            match get(key) {
                None => Ok(fallback),
                Some(v) => v.trim().parse::<f64>().ok().filter(|n| n.is_finite() && *n > 0.0).ok_or_else(|| format!("{key} must be a positive number")),
            }
        };
        Ok(Self {
            data_dir: get("RELAY_DATA_DIR").unwrap_or_else(|| ".zireh/relay".into()),
            demo,
            upstream,
            prices: parse_models(get("RELAY_MODELS"))?,
            tavily_api_key,
            tavily_url: get("TAVILY_URL").unwrap_or_else(|| "https://api.tavily.com/search".into()),
            search_price: number("RELAY_SEARCH_PRICE", 9600.0)? as u64, // Tavily basic ≈ $0.008 + margin
            usd_per_zec: number("USD_PER_ZEC", 50.0)?,
            zcash,
        })
    }

    fn zcash(get: &impl Fn(&str) -> Option<String>) -> Result<Option<Zcash>, String> {
        let ufvk = match (trimmed(get, "ZCASH_UFVK"), get("ZCASH_UFVK_FILE")) {
            (Some(k), _) => k,
            (None, Some(file)) => std::fs::read_to_string(&file).map_err(|e| format!("ZCASH_UFVK_FILE {file}: {e}"))?.trim().to_string(),
            (None, None) => return Ok(None),
        };
        let network = match get("ZCASH_NETWORK").as_deref().unwrap_or("testnet") {
            "testnet" => "testnet",
            "mainnet" => "mainnet",
            _ => return Err("ZCASH_NETWORK must be testnet or mainnet".into()),
        };
        let birthday = match get("ZCASH_BIRTHDAY") {
            None => None,
            Some(b) => Some(b.trim().parse::<u64>().map_err(|_| "ZCASH_BIRTHDAY must be a block height".to_string())?),
        };
        Ok(Some(Zcash { network, ufvk, lightwalletd: trimmed(get, "LIGHTWALLETD_URL"), birthday }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn from(pairs: &[(&str, &str)]) -> Result<RelayConfig, String> {
        let map: std::collections::HashMap<String, String> = pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect();
        RelayConfig::from_lookup(|k| map.get(k).cloned())
    }

    #[test]
    fn defaults_match_the_typescript_relay() {
        let c = from(&[]).unwrap();
        assert_eq!(c.upstream, Upstream::LocalDev { base_url: "http://127.0.0.1:11434/v1".into(), local_model: "nemotron-3-nano:4b".into() });
        assert_eq!((c.prices[0].input_per_mtok, c.prices[0].output_per_mtok), (360_000.0, 1_080_000.0));
        assert_eq!((c.search_price, c.usd_per_zec, c.zcash.clone(), c.demo), (9600, 50.0, None, None));
        let custom = from(&[("NEBIUS_API_KEY", "k"), ("RELAY_DEMO", "1"), ("RELAY_MODELS", "nvidia/some-nemotron:0.1:0.2")]).unwrap();
        assert_eq!((custom.prices[0].input_per_mtok, custom.prices[0].output_per_mtok), (120_000.0, 240_000.0));
        assert_eq!(custom.demo, Some((5_000_000, 20_000_000)));
    }

    #[test]
    fn free_coins_never_fund_paid_providers() {
        assert!(from(&[("NEBIUS_API_KEY", "k")]).unwrap_err().contains("RELAY_DEMO=1"));
        assert!(from(&[("TAVILY_API_KEY", "k")]).unwrap_err().contains("RELAY_DEMO=1"));
        assert!(from(&[("NEBIUS_API_KEY", "k"), ("ZCASH_UFVK", "uview1x")]).is_err(), "testnet by default");
        let mainnet = from(&[("NEBIUS_API_KEY", "k"), ("ZCASH_UFVK", "uview1x"), ("ZCASH_NETWORK", "mainnet")]).unwrap();
        assert_eq!(mainnet.demo, None);
        assert!(from(&[("ZCASH_UFVK", "x"), ("ZCASH_NETWORK", "regtest")]).is_err());
        assert!(from(&[("RELAY_DEMO", "1"), ("RELAY_DEMO_QUOTE_LIMIT", "0")]).is_err());
    }
}
