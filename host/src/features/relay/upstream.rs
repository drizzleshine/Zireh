//! What the relay calls on the user's behalf: an OpenAI-compatible chat endpoint (Nebius Token
//! Factory, or a local model in development) and Tavily search. The relay holds the keys; users
//! never see them. Prompts and answers are never logged.

use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde_json::{json, Map, Value};

use super::validate::ChatMessage;

#[derive(Clone, Debug)]
pub struct Usage {
    pub prompt_tokens: u64,
    pub completion_tokens: u64,
    /// Hidden reasoning tokens included in completion_tokens.
    pub reasoning_tokens: Option<u64>,
}

impl Usage {
    pub fn zero() -> Self {
        Self { prompt_tokens: 0, completion_tokens: 0, reasoning_tokens: None }
    }

    pub fn to_json(&self) -> Value {
        let mut u = json!({ "prompt_tokens": self.prompt_tokens, "completion_tokens": self.completion_tokens });
        if let Some(r) = self.reasoning_tokens {
            u["reasoning_tokens"] = r.into();
        }
        u
    }
}

pub struct ChatResult {
    pub content: String,
    pub model: String,
    pub usage: Usage,
}

/// One model behind `/chat/completions`.
pub struct ChatUpstream {
    pub base_url: String,
    pub model: String,
    pub api_key: Option<String>,
    /// Provider-specific request fields, e.g. `{ "reasoning_effort": "none" }` for a local model.
    pub extra_body: Map<String, Value>,
    pub client: reqwest::Client,
}

impl ChatUpstream {
    pub async fn chat(&self, messages: &[ChatMessage], max_tokens: u64, temperature: Option<f64>) -> Result<ChatResult, String> {
        let mut body = self.extra_body.clone();
        body.insert("model".into(), self.model.clone().into());
        body.insert("messages".into(), messages.iter().map(|m| json!({ "role": m.role, "content": m.content })).collect());
        body.insert("max_tokens".into(), max_tokens.into());
        if let Some(t) = temperature {
            body.insert("temperature".into(), json!(t));
        }
        let url = format!("{}/chat/completions", self.base_url.trim_end_matches('/'));
        let mut req = self.client.post(url).json(&Value::Object(body));
        if let Some(key) = &self.api_key {
            req = req.bearer_auth(key);
        }
        let res = req.send().await.map_err(|e| e.to_string())?;
        let status = res.status();
        if !status.is_success() {
            let text = res.text().await.unwrap_or_default();
            return Err(format!("{}: HTTP {} {text}", self.model, status.as_u16()));
        }
        let body: Value = res.json().await.map_err(|e| e.to_string())?;
        let usage = &body["usage"];
        Ok(ChatResult {
            content: body["choices"][0]["message"]["content"].as_str().unwrap_or("").to_string(),
            model: body["model"].as_str().unwrap_or(&self.model).to_string(),
            usage: Usage {
                prompt_tokens: usage["prompt_tokens"].as_u64().unwrap_or(0),
                completion_tokens: usage["completion_tokens"].as_u64().unwrap_or(0),
                reasoning_tokens: usage["completion_tokens_details"]["reasoning_tokens"].as_u64(),
            },
        })
    }
}

/// Is the AI behind the relay answering? A model listing is free and quick; the answer is reused
/// for 15 s so frequent `/v1/info` calls don't hammer the provider. In local mode the listed
/// models must include the one we serve.
pub struct HealthCheck {
    pub base_url: String,
    pub api_key: Option<String>,
    pub require_model: Option<String>,
    pub client: reqwest::Client,
    cached: Mutex<Option<(Instant, bool)>>,
}

impl HealthCheck {
    pub fn new(base_url: String, api_key: Option<String>, require_model: Option<String>, client: reqwest::Client) -> Self {
        Self { base_url, api_key, require_model, client, cached: Mutex::new(None) }
    }

    pub async fn ok(&self) -> bool {
        if let Some((at, ok)) = *self.cached.lock().expect("health cache") {
            if at.elapsed() < Duration::from_secs(15) {
                return ok;
            }
        }
        let ok = self.probe().await;
        *self.cached.lock().expect("health cache") = Some((Instant::now(), ok));
        ok
    }

    async fn probe(&self) -> bool {
        let mut req = self.client.get(format!("{}/models", self.base_url.trim_end_matches('/'))).timeout(Duration::from_secs(3));
        if let Some(key) = &self.api_key {
            req = req.bearer_auth(key);
        }
        let Ok(res) = req.send().await else { return false };
        if !res.status().is_success() {
            return false;
        }
        let Some(model) = &self.require_model else { return true };
        let Ok(body) = res.json::<Value>().await else { return false };
        body["data"].as_array().is_some_and(|models| models.iter().any(|m| m["id"].as_str() == Some(model)))
    }
}

/// Tavily web search, called with the relay's own key.
pub struct Tavily {
    pub api_key: String,
    pub url: String,
    pub client: reqwest::Client,
}

impl Tavily {
    pub async fn search(&self, query: &str, max_results: u64) -> Result<Vec<Value>, String> {
        let res = self
            .client
            .post(&self.url)
            .bearer_auth(&self.api_key)
            .json(&json!({ "query": query, "max_results": max_results, "search_depth": "basic" }))
            .send()
            .await
            .map_err(|e| e.to_string())?;
        if !res.status().is_success() {
            return Err(format!("tavily: HTTP {}", res.status().as_u16()));
        }
        let body: Value = res.json().await.map_err(|e| e.to_string())?;
        let field = |r: &Value, k: &str| Value::String(r[k].as_str().unwrap_or("").to_string());
        Ok(body["results"].as_array().map(|rs| rs.iter().map(|r| json!({ "title": field(r, "title"), "url": field(r, "url"), "content": field(r, "content") })).collect()).unwrap_or_default())
    }
}
