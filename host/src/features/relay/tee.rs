//! Receipt check for a model running in a NEAR AI Cloud TEE.
//!
//! The same steps as the public verification demo: a fresh nonce, NVIDIA's verdict on the GPU
//! report, then the signature over the exact request and response bytes. A failed check is
//! reported; it does not hide the answer.

use base64::engine::general_purpose::{URL_SAFE, URL_SAFE_NO_PAD};
use base64::Engine;
use k256::ecdsa::{RecoveryId, Signature, VerifyingKey};
use sha2::{Digest, Sha256};
use sha3::Keccak256;
use serde_json::{json, Value};

const NVIDIA_NRAS: &str = "https://nras.attestation.nvidia.com/v3/attest/gpu";

pub fn is_near_gateway(base_url: &str) -> bool {
    base_url.contains("cloud-api.near.ai")
}

struct Check {
    name: &'static str,
    pass: bool,
    detail: String,
}

impl Check {
    fn to_json(&self) -> Value {
        json!({ "name": self.name, "pass": self.pass, "detail": self.detail })
    }
}

pub struct Prepared {
    nonce: String,
    report: Result<Value, String>,
}

pub async fn prepare(client: &reqwest::Client, base_url: &str, api_key: Option<&str>, model: &str) -> Prepared {
    let nonce = hex::encode(rand::random::<[u8; 32]>());
    let url = format!(
        "{}/attestation/report?model={}&signing_algo=ecdsa&nonce={nonce}",
        base_url.trim_end_matches('/'),
        query(model),
    );
    Prepared { nonce, report: get_json(client, &url, api_key).await }
}

pub async fn complete(client: &reqwest::Client, base_url: &str, api_key: Option<&str>, model: &str, request_body: &str, response_text: &str, prepared: Prepared) -> Value {
    let mut checks = Vec::new();
    let mut model_tees = Vec::new();
    let mut gateway = Vec::new();
    match &prepared.report {
        Err(error) => {
            checks.push(Check { name: "Attestation report names a model TEE", pass: false, detail: error.clone() });
            checks.push(Check { name: "Gateway attestation echoes this request's nonce", pass: false, detail: String::new() });
            checks.push(Check { name: "Model attestation echoes this request's nonce", pass: false, detail: String::new() });
            checks.push(Check { name: "NVIDIA says the GPU TEE is genuine and fresh", pass: false, detail: String::new() });
        }
        Ok(report) => {
            let attestations = report["model_attestations"].as_array();
            for item in attestations.into_iter().flatten() {
                if let Some(addr) = item["signing_address"].as_str() {
                    if !model_tees.iter().any(|known| known == addr) {
                        model_tees.push(addr.to_string());
                    }
                }
            }
            if let Some(addr) = report["gateway_attestation"]["signing_address"].as_str() {
                gateway.push(addr.to_string());
            }
            let count = attestations.map(|items| items.len()).unwrap_or(0);
            checks.push(Check { name: "Attestation report names a model TEE", pass: !model_tees.is_empty(), detail: model_tees.join(", ") });
            checks.push(Check {
                name: "Gateway attestation echoes this request's nonce",
                pass: report["gateway_attestation"]["request_nonce"].as_str() == Some(prepared.nonce.as_str()),
                detail: String::new(),
            });
            let echoed = count > 0 && attestations.unwrap().iter().all(|item| item["request_nonce"].as_str() == Some(prepared.nonce.as_str()));
            checks.push(Check { name: "Model attestation echoes this request's nonce", pass: echoed, detail: format!("{count} TEE node{}", if count == 1 { "" } else { "s" }) });
            checks.push(nvidia_check(client, attestations, &prepared.nonce).await);
        }
    }

    let parsed: Value = serde_json::from_str(response_text).unwrap_or(Value::Null);
    let chat_id = parsed["id"].as_str().unwrap_or("");
    if chat_id.is_empty() {
        checks.push(Check { name: "Signature kind matches the signed text", pass: false, detail: "The chat response had no id".into() });
        checks.push(Check { name: "Signed hashes match this question and this answer", pass: false, detail: String::new() });
        checks.push(Check { name: "Signer is the attested TEE key", pass: false, detail: String::new() });
        return report(checks);
    }

    let signature = get_signature(client, base_url, api_key, chat_id, model).await;
    match signature {
        Err(error) => {
            checks.push(Check { name: "Signature kind matches the signed text", pass: false, detail: error });
            checks.push(Check { name: "Signed hashes match this question and this answer", pass: false, detail: String::new() });
            checks.push(Check { name: "Signer is the attested TEE key", pass: false, detail: String::new() });
        }
        Ok(signature) => {
            let text = signature["text"].as_str().unwrap_or("");
            let kind = signature_kind(&signature, text);
            let parts = text.split(':').count();
            let kind_ok = parts == if kind == "provider_tee" { 3 } else { 2 };
            checks.push(Check { name: "Signature kind matches the signed text", pass: kind_ok && (kind == "provider_tee" || kind == "gateway"), detail: kind.into() });
            let mut hashes = compare_hashes(text, &sha256_hex(request_body), &sha256_hex(response_text), model);
            if kind == "provider_tee" && hashes.signed_model.as_deref() != Some(model) {
                hashes.valid = false;
            }
            checks.push(Check { name: "Signed hashes match this question and this answer", pass: hashes.valid, detail: hashes.signed_model.clone().unwrap_or_else(|| kind.into()) });
            let expected = if kind == "gateway" { &gateway } else { &model_tees };
            let (pass, detail) = match signature["signature"].as_str().and_then(|sig| recover_address(text, sig).ok()) {
                Some(recovered) => (expected.iter().any(|addr| addr.eq_ignore_ascii_case(&recovered)), recovered),
                None => (false, "The signature could not be recovered".into()),
            };
            checks.push(Check { name: "Signer is the attested TEE key", pass, detail });
        }
    }
    report(checks)
}

fn report(checks: Vec<Check>) -> Value {
    json!({ "passed": checks.iter().all(|c| c.pass), "checks": checks.iter().map(Check::to_json).collect::<Vec<_>>() })
}

async fn nvidia_check(client: &reqwest::Client, attestations: Option<&Vec<Value>>, nonce: &str) -> Check {
    let Some(items) = attestations else {
        return Check { name: "NVIDIA says the GPU TEE is genuine and fresh", pass: false, detail: "No NVIDIA payload".into() };
    };
    let payloads: Vec<&Value> = items.iter().filter(|item| !item["nvidia_payload"].is_null()).map(|item| &item["nvidia_payload"]).collect();
    if payloads.is_empty() {
        return Check { name: "NVIDIA says the GPU TEE is genuine and fresh", pass: false, detail: "No NVIDIA payload".into() };
    }
    let mut ok = true;
    for payload in &payloads {
        let body = match payload {
            Value::String(raw) => raw.clone(),
            other => other.to_string(),
        };
        let nonce_ok = serde_json::from_str::<Value>(&body).ok().and_then(|v| v["nonce"].as_str().map(|n| n.eq_ignore_ascii_case(nonce))).unwrap_or(false);
        let verdict = match client.post(NVIDIA_NRAS).header("content-type", "application/json").body(body).send().await {
            Ok(res) if res.status().is_success() => res.json::<Value>().await.ok().and_then(|v| nvidia_fresh(&v, nonce)).unwrap_or(false),
            Ok(res) => return Check { name: "NVIDIA says the GPU TEE is genuine and fresh", pass: false, detail: format!("HTTP {}", res.status().as_u16()) },
            Err(error) => return Check { name: "NVIDIA says the GPU TEE is genuine and fresh", pass: false, detail: error.to_string() },
        };
        ok &= nonce_ok && verdict;
    }
    Check { name: "NVIDIA says the GPU TEE is genuine and fresh", pass: ok, detail: format!("{} GPU report{}", payloads.len(), if payloads.len() == 1 { "" } else { "s" }) }
}

fn nvidia_fresh(body: &Value, nonce: &str) -> Option<bool> {
    let decoded = decode_nvidia(body)?;
    let overall = decoded.get("JWT")?;
    let verdict = overall["x-nvidia-overall-att-result"].as_bool() == Some(true);
    let echoed = overall["eat_nonce"].as_str().is_some_and(|n| n.eq_ignore_ascii_case(nonce));
    Some(verdict && echoed)
}

fn decode_nvidia(body: &Value) -> Option<std::collections::BTreeMap<String, Value>> {
    let mut out = std::collections::BTreeMap::new();
    for item in body.as_array()? {
        if let Some(pair) = item.as_array() {
            if pair.len() == 2 {
                if let (Some(key), Some(token)) = (pair[0].as_str(), pair[1].as_str()) {
                    if let Some(payload) = jwt_payload(token) {
                        out.insert(key.to_string(), payload);
                    }
                }
            }
        } else if let Some(obj) = item.as_object() {
            for (key, value) in obj {
                if let Some(token) = value.as_str() {
                    if let Some(payload) = jwt_payload(token) {
                        out.insert(key.clone(), payload);
                    }
                }
            }
        }
    }
    Some(out)
}

fn jwt_payload(token: &str) -> Option<Value> {
    let part = token.split('.').nth(1)?;
    let bytes = URL_SAFE_NO_PAD.decode(part).or_else(|_| URL_SAFE.decode(part)).ok()?;
    serde_json::from_slice(&bytes).ok()
}

async fn get_signature(client: &reqwest::Client, base_url: &str, api_key: Option<&str>, chat_id: &str, model: &str) -> Result<Value, String> {
    let url = format!(
        "{}/signature/{}?model={}&signing_algo=ecdsa",
        base_url.trim_end_matches('/'),
        query(chat_id),
        query(model),
    );
    let mut last = String::from("Signature request failed");
    for attempt in 1..=5 {
        match get_json(client, &url, api_key).await {
            Ok(body) => return Ok(body),
            Err(error) => {
                let missing = error.contains("HTTP 404");
                last = error;
                if !missing || attempt == 5 {
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_secs(1)).await;
            }
        }
    }
    Err(last)
}

async fn get_json(client: &reqwest::Client, url: &str, api_key: Option<&str>) -> Result<Value, String> {
    let mut req = client.get(url);
    if let Some(key) = api_key {
        req = req.bearer_auth(key);
    }
    let res = req.send().await.map_err(|e| e.to_string())?;
    let status = res.status();
    if !status.is_success() {
        let text = res.text().await.unwrap_or_default();
        return Err(format!("HTTP {} {}", status.as_u16(), text.chars().take(180).collect::<String>()));
    }
    res.json().await.map_err(|e| e.to_string())
}

fn query(value: &str) -> String {
    form_urlencoded::byte_serialize(value.as_bytes()).collect()
}

struct Hashes {
    valid: bool,
    signed_model: Option<String>,
}

fn compare_hashes(text: &str, request_hash: &str, response_hash: &str, model: &str) -> Hashes {
    let parts: Vec<&str> = text.split(':').collect();
    if parts.len() != 2 && parts.len() != 3 {
        return Hashes { valid: false, signed_model: None };
    }
    let (signed_model, signed_request, signed_response) = if parts.len() == 3 { (Some(parts[0]), parts[1], parts[2]) } else { (None, parts[0], parts[1]) };
    let model_ok = signed_model.map(|id| id == model).unwrap_or(true);
    Hashes { valid: model_ok && signed_request == request_hash && signed_response == response_hash, signed_model: signed_model.map(str::to_string) }
}

fn signature_kind(signature: &Value, text: &str) -> &'static str {
    match signature["signature_kind"].as_str() {
        Some("provider_tee") => "provider_tee",
        Some("gateway") => "gateway",
        _ if text.split(':').count() == 3 => "provider_tee",
        _ => "gateway",
    }
}

fn sha256_hex(data: &str) -> String {
    hex::encode(Sha256::digest(data.as_bytes()))
}

/// Ethereum `personal_sign` address for a message signed by a TEE key.
fn recover_address(message: &str, signature: &str) -> Result<String, String> {
    let bytes = hex::decode(signature.trim().trim_start_matches("0x")).map_err(|e| e.to_string())?;
    if bytes.len() != 65 {
        return Err(format!("signature is {} bytes", bytes.len()));
    }
    let v = match bytes[64] {
        0 | 1 => bytes[64],
        27 | 28 => bytes[64] - 27,
        other => return Err(format!("recovery id {other}")),
    };
    let signature = Signature::from_slice(&bytes[..64]).map_err(|e| e.to_string())?;
    let recid = RecoveryId::from_byte(v).ok_or_else(|| format!("recovery id {v}"))?;
    let key = VerifyingKey::recover_from_prehash(personal_hash(message).as_slice(), &signature, recid).map_err(|e| e.to_string())?;
    Ok(address_of(&key))
}

fn personal_hash(message: &str) -> [u8; 32] {
    let prefix = format!("\x19Ethereum Signed Message:\n{}", message.len());
    let mut hasher = Keccak256::new();
    hasher.update(prefix.as_bytes());
    hasher.update(message.as_bytes());
    hasher.finalize().into()
}

fn address_of(key: &VerifyingKey) -> String {
    let encoded = key.to_encoded_point(false);
    let hash = Keccak256::digest(&encoded.as_bytes()[1..]);
    format!("0x{}", hex::encode(&hash[12..]))
}

#[cfg(test)]
mod tests {
    use super::*;
    use k256::ecdsa::SigningKey;

    #[test]
    fn hashes_accept_a_model_tee_signature_and_reject_a_swap() {
        let request = sha256_hex("{\"model\":\"Qwen/Qwen3.8-27B\"}");
        let response = sha256_hex("{\"id\":\"abc\"}");
        let text = format!("Qwen/Qwen3.8-27B:{request}:{response}");
        assert!(compare_hashes(&text, &request, &response, "Qwen/Qwen3.8-27B").valid);
        assert!(!compare_hashes(&text, &response, &request, "Qwen/Qwen3.8-27B").valid);
        let gateway = format!("{request}:{response}");
        assert!(compare_hashes(&gateway, &request, &response, "Qwen/Qwen3.8-27B").valid);
    }

    #[test]
    fn recovered_address_matches_the_signing_key() {
        let key = SigningKey::random(&mut rand::thread_rng());
        let message = "Qwen/Qwen3.8-27B:abc:def";
        let (signature, recid) = key.sign_prehash_recoverable(&personal_hash(message)).unwrap();
        let mut bytes = signature.to_bytes().as_slice().to_vec();
        bytes.push(recid.to_byte() + 27);
        let recovered = recover_address(message, &hex::encode(bytes)).unwrap();
        assert_eq!(recovered.to_lowercase(), address_of(key.verifying_key()).to_lowercase());
    }

    #[test]
    fn nvidia_token_must_echo_the_nonce() {
        let header = URL_SAFE_NO_PAD.encode(b"{\"alg\":\"none\"}");
        let claims = URL_SAFE_NO_PAD.encode(br#"{"eat_nonce":"aa","x-nvidia-overall-att-result":true}"#);
        let token = format!("{header}.{claims}.sig");
        let body = json!([["JWT", token]]);
        assert_eq!(nvidia_fresh(&body, "aa"), Some(true));
        assert_eq!(nvidia_fresh(&body, "bb"), Some(false));
    }
}
