//! Relay settings from the environment (and `.env`, see `crate::dotenv`).
//!
//! The AI behind the relay is any OpenAI-compatible `/chat/completions` endpoint:
//!  - hosted: LLM_API_KEY set; LLM_BASE_URL and LLM_MODELS name the provider and its models
//!    (Nebius Token Factory, Meta's Model API, OpenRouter, …).
//!  - local-dev: no key; calls go to a local model (Ollama by default) so everything runs end to
//!    end. Labeled as local everywhere.
//!
//! Payments: simulated unless ZCASH_UFVK (or ZCASH_UFVK_FILE) is set, then real shielded Zcash on
//! ZCASH_NETWORK (testnet unless set), watched in-process with that viewing key.

use crate::features::mint::pricing::ModelPrice;

#[derive(Clone, Debug, PartialEq)]
pub enum Upstream {
    Hosted { base_url: String, api_key: String },
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
    /// Provider-specific request fields sent with every call, e.g. `{"reasoning_effort":"minimal"}`.
    pub extra_body: serde_json::Map<String, serde_json::Value>,
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

/// List price used when LLM_MODELS names a model without one (Nemotron 3 Super's), USD per 1M tokens.
const DEFAULT_PRICE: (f64, f64) = (0.3, 0.9);

/// LLM_MODELS="id:usdIn:usdOut,id" (prices per 1M tokens; an id alone gets DEFAULT_PRICE).
/// Unset: the two Nemotron models on Nebius Token Factory.
fn parse_models(spec: Option<String>) -> Result<Vec<ModelPrice>, String> {
    let Some(spec) = spec else { return Ok(default_models()) };
    spec.split(',')
        .map(str::trim)
        .map(|entry| {
            let num = |s: &str| s.parse::<f64>().ok().filter(|n| n.is_finite() && *n >= 0.0).ok_or_else(|| format!("bad LLM_MODELS entry: {entry}"));
            // Model ids may contain ':' (e.g. nemotron-3-nano:4b), so prices are the last two fields.
            match entry.rsplitn(3, ':').collect::<Vec<_>>().as_slice() {
                [usd_out, usd_in, model] if !model.is_empty() && num(usd_in).is_ok() && num(usd_out).is_ok() => Ok(with_margin(model, num(usd_in)?, num(usd_out)?)),
                _ if !entry.is_empty() => Ok(with_margin(entry, DEFAULT_PRICE.0, DEFAULT_PRICE.1)),
                _ => Err(format!("bad LLM_MODELS entry: {entry}")),
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
        let api_key = trimmed(&get, "LLM_API_KEY");
        let tavily_api_key = trimmed(&get, "TAVILY_API_KEY");
        let demo = get("RELAY_DEMO").as_deref() == Some("1");
        let zcash = Self::zcash(&get)?;
        // Simulated and testnet coins are free, so anything they buy from a paid provider is ours to pay.
        if (api_key.is_some() || tavily_api_key.is_some()) && !demo && zcash.as_ref().map(|z| z.network) != Some("mainnet") {
            return Err("Simulated or testnet payments cannot fund paid providers. Set RELAY_DEMO=1 to explicitly enable a capped demo.".into());
        }
        let demo = if demo { Some((limit(&get, "RELAY_DEMO_QUOTE_LIMIT", 5_000_000)?, limit(&get, "RELAY_DEMO_DAILY_LIMIT", 20_000_000)?)) } else { None };
        let models = trimmed(&get, "LLM_MODELS");
        let prices = parse_models(models.clone())?;
        let upstream = match api_key {
            Some(api_key) => Upstream::Hosted { base_url: trimmed(&get, "LLM_BASE_URL").unwrap_or_else(|| "https://api.tokenfactory.nebius.com/v1".into()), api_key },
            None => Upstream::LocalDev {
                base_url: trimmed(&get, "LLM_BASE_URL").unwrap_or_else(|| "http://127.0.0.1:11434/v1".into()),
                local_model: if models.is_some() { prices[0].model.clone() } else { "nemotron-3-nano:4b".into() },
            },
        };
        let extra_body = match trimmed(&get, "LLM_EXTRA_BODY") {
            Some(raw) => match serde_json::from_str(&raw) {
                Ok(serde_json::Value::Object(map)) => map,
                _ => return Err("LLM_EXTRA_BODY must be a JSON object".into()),
            },
            // A local Nemotron answers in about a second with reasoning off, and its bills stay checkable.
            None if matches!(upstream, Upstream::LocalDev { .. }) => serde_json::Map::from_iter([("reasoning_effort".into(), "none".into())]),
            None => serde_json::Map::new(),
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
            prices,
            extra_body,
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
        assert_eq!(c.extra_body["reasoning_effort"], "none");
        let custom = from(&[("LLM_API_KEY", "k"), ("RELAY_DEMO", "1"), ("LLM_MODELS", "nvidia/some-nemotron:0.1:0.2")]).unwrap();
        assert_eq!((custom.prices[0].input_per_mtok, custom.prices[0].output_per_mtok), (120_000.0, 240_000.0));
        assert_eq!(custom.demo, Some((5_000_000, 20_000_000)));
        assert!(custom.extra_body.is_empty());
    }

    #[test]
    fn any_openai_compatible_provider() {
        let c = from(&[("LLM_API_KEY", "k"), ("RELAY_DEMO", "1"), ("LLM_BASE_URL", "https://api.meta.ai/v1"), ("LLM_MODELS", "muse-spark-1.3-contributor"), ("LLM_EXTRA_BODY", r#"{"reasoning_effort":"minimal"}"#)]).unwrap();
        assert_eq!(c.upstream, Upstream::Hosted { base_url: "https://api.meta.ai/v1".into(), api_key: "k".into() });
        assert_eq!((c.prices[0].model.as_str(), c.prices[0].input_per_mtok), ("muse-spark-1.3-contributor", 360_000.0));
        assert_eq!(c.extra_body["reasoning_effort"], "minimal");
        assert!(from(&[("LLM_EXTRA_BODY", "[1]")]).is_err());
        // Local ids keep their colon; prices are only the last two fields.
        let local = from(&[("LLM_MODELS", "nemotron-3-nano:4b")]).unwrap();
        assert_eq!(local.upstream, Upstream::LocalDev { base_url: "http://127.0.0.1:11434/v1".into(), local_model: "nemotron-3-nano:4b".into() });
        assert_eq!(from(&[("LLM_MODELS", "qwen3:8b:0.1:0.2")]).unwrap().prices[0].model, "qwen3:8b");
    }

    #[test]
    fn free_coins_never_fund_paid_providers() {
        assert!(from(&[("LLM_API_KEY", "k")]).unwrap_err().contains("RELAY_DEMO=1"));
        assert!(from(&[("TAVILY_API_KEY", "k")]).unwrap_err().contains("RELAY_DEMO=1"));
        assert!(from(&[("LLM_API_KEY", "k"), ("ZCASH_UFVK", "uview1x")]).is_err(), "testnet by default");
        let mainnet = from(&[("LLM_API_KEY", "k"), ("ZCASH_UFVK", "uview1x"), ("ZCASH_NETWORK", "mainnet")]).unwrap();
        assert_eq!(mainnet.demo, None);
        assert!(from(&[("ZCASH_UFVK", "x"), ("ZCASH_NETWORK", "regtest")]).is_err());
        assert!(from(&[("RELAY_DEMO", "1"), ("RELAY_DEMO_QUOTE_LIMIT", "0")]).is_err());
    }
}
