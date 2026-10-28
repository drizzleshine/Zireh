//! The relay: sells AI calls and web searches for blind-signed coins, so the provider never learns
//! who asked and the relay never learns which top-up paid for which question. A port of
//! `packages/relay/src/relay.ts`; status codes, error codes and reply shapes are unchanged.

pub mod config;
pub mod store;
pub mod upstream;
pub mod validate;
pub mod watcher;

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use axum::body::Bytes;
use axum::extract::{Query, State};
use axum::http::Method;
use axum::response::Response;
use axum::routing::any;
use axum::Router;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tokio::sync::watch;

use crate::features::mint::amounts::blank_output_count;
use crate::features::mint::keys::MintKeys;
use crate::features::mint::pricing::{actual_cost, max_cost, ModelPrice};
use crate::features::mint::spent::{SpentStore, SqliteSpentStore};
use crate::features::mint::{total, BlindSignature, BlindedMessage, CommitResult, Mint, MintError, Proof, RedeemError};
use crate::http::json;
use crate::js::{canonical_json, js_number};
use store::{RelayDb, StoredResponse, REDEEMED};
use upstream::{ChatUpstream, HealthCheck, Tavily, Usage};
use validate::{ChatMessage, ChatRequest};
use watcher::Watcher;

/// Demo mode: provider spend and top-ups are capped per UTC day.
pub struct Admission {
    pub quote_limit: u64,
    pub daily_limit: u64,
}

pub struct Model {
    pub price: ModelPrice,
    pub upstream: ChatUpstream,
}

pub struct Relay {
    pub db: Arc<RelayDb>,
    pub keys: MintKeys,
    pub watcher: Watcher,
    /// In the order they are offered.
    pub models: Vec<Model>,
    pub search: Option<Tavily>,
    pub search_price: u64,
    pub admission: Option<Admission>,
    pub health: Option<HealthCheck>,
    in_flight: Mutex<HashMap<String, watch::Receiver<Option<StoredResponse>>>>,
}

/// Marks coins spent in `relay.db`, so the burn and the stored reply share one transaction.
pub struct DbSpent(Arc<RelayDb>);

impl SpentStore for DbSpent {
    fn mark_spent(&self, secrets: &[String], commit: &mut dyn FnMut(Option<&rusqlite::Connection>) -> CommitResult) -> Result<bool, String> {
        SqliteSpentStore(self.0.mutex()).mark_spent(secrets, commit)
    }
}

fn fail(status: u16, error: &str, message: &str) -> Response {
    json(status, json!({ "error": error, "message": message }))
}

fn fail_with(status: u16, error: &str, message: &str, settlement: Value) -> StoredResponse {
    StoredResponse { status, body: json!({ "error": error, "message": message, "settlement": settlement }) }
}

fn internal(message: impl std::fmt::Display) -> Response {
    let m = message.to_string();
    fail(503, "upstream_error", &format!("internal error: {}", js_slice(&m, 120)))
}

fn reply(r: &StoredResponse) -> Response {
    json(r.status, r.body.clone())
}

/// `s.slice(0, n)` counted in UTF-16 units, never splitting a character.
fn js_slice(s: &str, n: usize) -> &str {
    let mut units = 0;
    for (i, c) in s.char_indices() {
        units += c.len_utf16();
        if units > n {
            return &s[..i];
        }
    }
    s
}

/// A price as JSON, integers without a trailing `.0`, as JavaScript writes them.
fn js_value(n: f64) -> Value {
    serde_json::from_str(&js_number(n)).unwrap_or(Value::Null)
}

fn sha256_hex(text: &str) -> String {
    hex::encode(Sha256::digest(text.as_bytes()))
}

fn signatures_json(sigs: &[BlindSignature]) -> Value {
    serde_json::to_value(sigs).expect("signatures serialize")
}

fn settlement(request_id: &str, charged: u64, usage: &Usage, change: &[BlindSignature]) -> Value {
    json!({ "requestId": request_id, "charged": charged, "usage": usage.to_json(), "change": signatures_json(change) })
}

fn parse(body: &Bytes) -> Value {
    serde_json::from_slice(body).unwrap_or(Value::Null)
}

fn bad_request(message: String) -> Response {
    fail(400, "bad_request", &message)
}

/// What a paid call does once its coins are burned.
enum Work {
    Chat { model: usize, request: ChatRequest },
    Search { query: String, max_results: u64 },
}

impl Relay {
    pub fn new(db: Arc<RelayDb>, keys: MintKeys, watcher: Watcher, models: Vec<Model>, search: Option<Tavily>, search_price: u64, admission: Option<Admission>, health: Option<HealthCheck>) -> Self {
        Self { db, keys, watcher, models, search, search_price, admission, health, in_flight: Mutex::new(HashMap::new()) }
    }

    fn mint(&self) -> Mint<DbSpent> {
        Mint::new(self.keys.clone(), DbSpent(self.db.clone()))
    }

    fn today() -> String {
        store::iso_time(store::now_ms())[..10].to_string()
    }

    fn admit_call(&self, credits: u64) -> Result<bool, String> {
        match &self.admission {
            None => Ok(true),
            Some(a) => self.db.reserve_budget("provider", credits, a.daily_limit, &Self::today()).map_err(|e| e.to_string()),
        }
    }

    /// A quote's state after asking the payment watcher for news, or the error reply to send.
    fn current_state(&self, quote_id: &str) -> Result<String, Response> {
        if self.watcher.state(&self.db, quote_id).is_err() {
            return Err(fail(404, "not_found", "unknown quote"));
        }
        if let Err(e) = self.watcher.refresh(&self.db, quote_id) {
            return Err(fail(502, "upstream_error", &format!("Couldn't check the payment: {e}")));
        }
        self.watcher.state(&self.db, quote_id).map_err(|_| fail(404, "not_found", "unknown quote"))
    }

    /// A finished or interrupted earlier attempt with this requestId: its stored reply, or a
    /// full refund if the relay burned the coins and then stopped before answering.
    async fn resume(&self, request_id: &str, blanks: &[BlindedMessage]) -> Option<Response> {
        let running = self.in_flight.lock().expect("in-flight").get(request_id).cloned();
        if let Some(rx) = running {
            return Some(Self::wait(rx).await);
        }
        let stored = match self.db.get_response(request_id) {
            Ok(s) => s?,
            Err(e) => return Some(internal(e)),
        };
        if stored.status != REDEEMED {
            return Some(reply(&stored));
        }
        let refunded = stored.body["redeemed"].as_u64().unwrap_or(0);
        let change = match self.mint().change(blanks, refunded) {
            Ok(c) => c,
            Err(e) => return Some(internal(e)),
        };
        let response = fail_with(502, "upstream_error", "the relay restarted before answering; refunded", settlement(request_id, 0, &Usage::zero(), &change));
        if let Err(e) = self.db.put_response(request_id, &response) {
            return Some(internal(e));
        }
        Some(reply(&response))
    }

    async fn wait(mut rx: watch::Receiver<Option<StoredResponse>>) -> Response {
        match rx.wait_for(Option::is_some).await {
            Ok(r) => reply(r.as_ref().expect("waited for a value")),
            Err(_) => internal("the earlier attempt stopped"),
        }
    }

    /// Shared settlement path for every paid call: idempotency, hold check, burn, upstream,
    /// change. The requestId is 128 random bits chosen by the client: a bearer secret for its
    /// own result.
    async fn paid(self: &Arc<Self>, request_id: String, proofs: Vec<Proof>, blanks: Vec<BlindedMessage>, hold: u64, work: Work) -> Response {
        if let Some(r) = self.resume(&request_id, &blanks).await {
            return r;
        }
        let paid_amount = total(&proofs);
        if paid_amount < hold {
            return fail(402, "insufficient_funds", &format!("this call needs {hold} credits, got {paid_amount}"));
        }
        if (blanks.len() as u64) < blank_output_count(paid_amount) {
            return fail(400, "bad_request", "not enough blank outputs for change");
        }
        let rx = {
            let mut running = self.in_flight.lock().expect("in-flight");
            if let Some(rx) = running.get(&request_id) {
                rx.clone()
            } else {
                let (tx, rx) = watch::channel(None);
                running.insert(request_id.clone(), rx.clone());
                // Spawned, so a paid call finishes and stores its answer even if the client
                // disconnects; the retry then picks the answer up.
                let relay = self.clone();
                tokio::spawn(async move {
                    let result = relay.run_paid(&request_id, &proofs, &blanks, hold, paid_amount, work).await;
                    let _ = tx.send(Some(result));
                    relay.in_flight.lock().expect("in-flight").remove(&request_id);
                });
                rx
            }
        };
        Self::wait(rx).await
    }

    async fn run_paid(&self, request_id: &str, proofs: &[Proof], blanks: &[BlindedMessage], hold: u64, paid_amount: u64, work: Work) -> StoredResponse {
        let internal_reply = |e: String| StoredResponse { status: 503, body: json!({ "error": "upstream_error", "message": format!("internal error: {}", js_slice(&e, 120)) }) };
        // Another attempt may have finished between our checks.
        if let Ok(Some(stored)) = self.db.get_response(request_id) {
            if stored.status != REDEEMED {
                return stored;
            }
        }
        match self.admit_call(hold) {
            Ok(true) => {}
            Ok(false) => return StoredResponse { status: 429, body: json!({ "error": "limit_exceeded", "message": "Daily demo provider budget exhausted; no coins were spent" }) },
            Err(e) => return internal_reply(e),
        }
        let marker = StoredResponse { status: REDEEMED, body: json!({ "redeemed": paid_amount }) };
        let redeemed = self.mint().redeem(proofs, &mut |tx| match tx {
            Some(tx) => RelayDb::put_response_on(tx, request_id, &marker).map_err(|e| e.to_string()),
            None => Ok(()),
        });
        match redeemed {
            Ok(_) => {}
            // Nothing burned; not stored.
            Err(RedeemError::Mint(e)) => return StoredResponse { status: 400, body: json!({ "error": e.code.as_str(), "message": e.message }) },
            Err(RedeemError::Storage(e)) => return internal_reply(e),
        }
        let outcome = match work {
            Work::Chat { model, request } => {
                let m = &self.models[model];
                m.upstream.chat(&request.messages, request.max_tokens, request.temperature).await.map(|r| {
                    let cost = actual_cost(&m.price, r.usage.prompt_tokens, r.usage.completion_tokens);
                    (json!({ "content": r.content, "model": r.model }), cost, r.usage)
                })
            }
            Work::Search { query, max_results } => match &self.search {
                Some(search) => search.search(&query, max_results).await.map(|hits| (json!({ "hits": hits }), self.search_price, Usage::zero())),
                None => Err("search is not enabled on this relay".into()),
            },
        };
        let mint = self.mint();
        let response = match outcome {
            Err(e) => match mint.change(blanks, paid_amount) {
                Ok(change) => fail_with(502, "upstream_error", js_slice(&e, 200), settlement(request_id, 0, &Usage::zero(), &change)),
                Err(e) => return internal_reply(e.to_string()),
            },
            Ok((mut body, cost, usage)) => {
                let charged = cost.min(paid_amount);
                match mint.change(blanks, paid_amount - charged) {
                    Ok(change) => {
                        body["settlement"] = settlement(request_id, charged, &usage, &change);
                        StoredResponse { status: 200, body }
                    }
                    Err(e) => return internal_reply(e.to_string()),
                }
            }
        };
        if let Err(e) = self.db.put_response(request_id, &response) {
            return internal_reply(e.to_string());
        }
        response
    }

    async fn info(&self) -> Response {
        let prices: Vec<Value> = self.models.iter().map(|m| json!({ "model": m.price.model, "inputPerMTok": js_value(m.price.input_per_mtok), "outputPerMTok": js_value(m.price.output_per_mtok) })).collect();
        let mut info = json!({ "keyset": self.keys.keyset(), "prices": prices, "searchPrice": self.search_price, "searchEnabled": self.search.is_some(), "network": self.watcher.network() });
        if let Some(h) = &self.health {
            info["upstreamOk"] = h.ok().await.into();
        }
        json(200, info)
    }

    fn quote(&self, body: &Value) -> Response {
        let credits = match validate::body(body).and_then(validate::topup_credits) {
            Ok(c) => c,
            Err(e) => return bad_request(e),
        };
        if let Some(a) = &self.admission {
            let admitted = credits <= a.quote_limit && matches!(self.db.reserve_budget("quote", credits, a.daily_limit, &Self::today()), Ok(true));
            if !admitted {
                return fail(429, "limit_exceeded", &format!("Demo top-ups are limited to {} credits per quote and a shared daily budget", a.quote_limit));
            }
        }
        match self.watcher.quote(&self.db, credits) {
            Ok(q) => json(200, q),
            Err(e) => fail(502, "upstream_error", &format!("Couldn't get a payment address: {e}")),
        }
    }

    fn quote_state(&self, quote_id: &str) -> Response {
        let state = match self.current_state(quote_id) {
            Ok(s) => s,
            Err(r) => return r,
        };
        let mut body = json!({ "state": state });
        if let Some(received) = self.watcher.received(&self.db, quote_id) {
            body["received"] = received.into();
        }
        json(200, body)
    }

    fn simulate(&self, body: &Value) -> Response {
        if !matches!(self.watcher, Watcher::Simulated { .. }) {
            return fail(404, "not_found", "not a simulated network");
        }
        let quote_id = match validate::body(body).and_then(validate::quote_id) {
            Ok(q) => q,
            Err(e) => return bad_request(e),
        };
        match self.watcher.simulate(&self.db, &quote_id).and_then(|()| self.watcher.state(&self.db, &quote_id)) {
            Ok(state) => json(200, json!({ "state": state })),
            Err(e) => fail(400, "bad_request", &e),
        }
    }

    fn mint_topup(&self, body: &Value) -> Response {
        let (quote_id, outputs) = match validate::body(body).and_then(validate::mint_request) {
            Ok(r) => r,
            Err(e) => return bad_request(e),
        };
        let outputs_hash = sha256_hex(&canonical_json(&serde_json::to_value(&outputs).expect("outputs serialize")));
        let key = format!("topup:{quote_id}");
        match self.db.get_response(&key) {
            Err(e) => return internal(e),
            Ok(Some(stored)) => {
                return if stored.body["outputsHash"].as_str() == Some(&outputs_hash) {
                    json(200, json!({ "signatures": stored.body["signatures"] }))
                } else {
                    fail(409, "bad_request", "quote already minted with different outputs")
                };
            }
            Ok(None) => {}
        }
        let state = match self.current_state(&quote_id) {
            Ok(s) => s,
            Err(r) => return r,
        };
        if state != "confirmed" {
            return fail(402, "quote_unpaid", &format!("quote is {state}"));
        }
        let credits = match self.watcher.credits(&self.db, &quote_id) {
            Ok(c) => c,
            Err(e) => return internal(e),
        };
        let signatures = match self.mint().issue(&outputs, credits) {
            Ok(s) => s,
            Err(e) => return fail(400, "bad_request", &e.message),
        };
        // Quote state and the replayable reply commit together.
        let stored = StoredResponse { status: 200, body: json!({ "outputsHash": outputs_hash, "signatures": signatures_json(&signatures) }) };
        let committed = (|| -> Result<(), String> {
            let mut conn = self.db.conn();
            let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate).map_err(|e| e.to_string())?;
            self.watcher.mark_minted_on(&tx, &quote_id)?;
            RelayDb::put_response_on(&tx, &key, &stored).map_err(|e| e.to_string())?;
            tx.commit().map_err(|e| e.to_string())
        })();
        match committed {
            Ok(()) => json(200, json!({ "signatures": signatures_json(&signatures) })),
            Err(e) => internal(e),
        }
    }

    fn swap(&self, body: &Value) -> Response {
        let (request_id, proofs, outputs) = match validate::body(body).and_then(validate::swap_request) {
            Ok(r) => r,
            Err(e) => return bad_request(e),
        };
        let id = format!("swap:{request_id}");
        let whole = json!({ "requestId": request_id, "proofs": proofs, "outputs": outputs });
        let outputs_hash = sha256_hex(&canonical_json(&whole));
        match self.db.get_response(&id) {
            Err(e) => return internal(e),
            Ok(Some(stored)) => {
                return if stored.body["outputsHash"].as_str() == Some(&outputs_hash) {
                    json(200, json!({ "signatures": stored.body["signatures"] }))
                } else {
                    fail(409, "bad_request", "swap already used with different inputs or outputs")
                };
            }
            Ok(None) => {}
        }
        // Validate and sign before redeeming. Burn and final signatures share one transaction:
        // a crash leaves either the original coins or the complete replayable reply.
        let mint = self.mint();
        let signatures = match mint.issue(&outputs, total(&proofs)) {
            Ok(s) => s,
            Err(MintError { message, .. }) => return fail(400, "bad_request", &message),
        };
        let stored = StoredResponse { status: 200, body: json!({ "outputsHash": outputs_hash, "signatures": signatures_json(&signatures) }) };
        let redeemed = mint.redeem(&proofs, &mut |tx| match tx {
            Some(tx) => RelayDb::put_response_on(tx, &id, &stored).map_err(|e| e.to_string()),
            None => Ok(()),
        });
        match redeemed {
            Ok(_) => json(200, json!({ "signatures": signatures_json(&signatures) })),
            Err(RedeemError::Mint(e)) => fail(400, e.code.as_str(), &e.message),
            Err(RedeemError::Storage(e)) => internal(e),
        }
    }

    async fn chat(self: &Arc<Self>, body: &Value) -> Response {
        let parsed = validate::body(body).and_then(|o| {
            Ok((validate::request_id(o, "")?, validate::chat_request(o.get("request").unwrap_or(&Value::Null), "request")?, validate::proofs(o)?, validate::change_outputs(o)?))
        });
        let (request_id, request, proofs, blanks) = match parsed {
            Ok(p) => p,
            Err(e) => return bad_request(e),
        };
        if let Some(r) = self.resume(&request_id, &blanks).await {
            return r;
        }
        let Some(model) = self.models.iter().position(|m| m.price.model == request.model) else {
            return fail(404, "unknown_model", &format!("model {} is not offered", request.model));
        };
        let hold = max_cost(&self.models[model].price, request.messages.iter().map(|m: &ChatMessage| m.content.as_str()), request.max_tokens);
        self.paid(request_id, proofs, blanks, hold, Work::Chat { model, request }).await
    }

    async fn search(self: &Arc<Self>, body: &Value) -> Response {
        let parsed = validate::body(body).and_then(|o| Ok((validate::request_id(o, "")?, validate::search_request(o)?, validate::proofs(o)?, validate::change_outputs(o)?)));
        let (request_id, (query, max_results), proofs, blanks) = match parsed {
            Ok(p) => p,
            Err(e) => return bad_request(e),
        };
        if let Some(r) = self.resume(&request_id, &blanks).await {
            return r;
        }
        if self.search.is_none() {
            return fail(404, "not_found", "search is not enabled on this relay");
        }
        let price = self.search_price;
        self.paid(request_id, proofs, blanks, price, Work::Search { query, max_results }).await
    }

    fn acknowledge(&self, body: &Value) -> Response {
        let request_id = match validate::body(body).and_then(|o| validate::request_id(o, "")) {
            Ok(r) => r,
            Err(e) => return bad_request(e),
        };
        match self.db.acknowledge(&request_id) {
            Ok(()) => json(200, json!({ "ok": true })),
            Err(e) => internal(e),
        }
    }
}

/// Builds the relay from its settings: mint keys and `relay.db` under the data folder, the
/// offered models, search, demo caps, and the payment watcher. Returns the payment engine too,
/// whose chain scanner the caller runs in the background.
pub fn from_config(cfg: &config::RelayConfig) -> Result<(Arc<Relay>, Option<(Arc<crate::features::payments::Payments>, String, Option<u64>)>), String> {
    use crate::features::payments::{default_lightwalletd_url, Payments, Settings};
    let dir = std::path::Path::new(&cfg.data_dir);
    let keys = MintKeys::load_or_create(dir).map_err(|e| format!("mint keys in {}: {e}", cfg.data_dir))?;
    let db = Arc::new(RelayDb::open(dir).map_err(|e| format!("relay database in {}: {e}", cfg.data_dir))?);
    let client = reqwest::Client::builder().timeout(std::time::Duration::from_secs(300)).build().map_err(|e| e.to_string())?;
    let (models, health) = match &cfg.upstream {
        config::Upstream::Hosted { base_url, api_key } => (
            cfg.prices.iter().map(|price| Model { price: price.clone(), upstream: ChatUpstream { base_url: base_url.clone(), model: price.model.clone(), api_key: Some(api_key.clone()), extra_body: cfg.extra_body.clone(), client: client.clone() } }).collect(),
            HealthCheck::new(base_url.clone(), Some(api_key.clone()), None, client.clone()),
        ),
        // Only the model that actually answers is offered, under its own name.
        config::Upstream::LocalDev { base_url, local_model } => {
            let price = ModelPrice { model: local_model.clone(), ..cfg.prices[0].clone() };
            (vec![Model { price, upstream: ChatUpstream { base_url: base_url.clone(), model: local_model.clone(), api_key: None, extra_body: cfg.extra_body.clone(), client: client.clone() } }], HealthCheck::new(base_url.clone(), None, Some(local_model.clone()), client.clone()))
        }
    };
    let search = cfg.tavily_api_key.clone().map(|api_key| Tavily { api_key, url: cfg.tavily_url.clone(), client: client.clone() });
    let (watcher, scanner) = match &cfg.zcash {
        None => (Watcher::Simulated { usd_per_zec: cfg.usd_per_zec }, None),
        Some(z) => {
            let file = dir.join("payments.db");
            let payments = Arc::new(Payments::open(&file.to_string_lossy(), z.network, &z.ufvk, Settings::default()).map_err(|e| format!("payments: {e}"))?);
            let url = match &z.lightwalletd {
                Some(u) => u.clone(),
                None => default_lightwalletd_url(z.network).map_err(|e| e.to_string())?.to_string(),
            };
            (Watcher::Zcash { payments: payments.clone(), network: z.network, usd_per_zec: cfg.usd_per_zec }, Some((payments, url, z.birthday)))
        }
    };
    let admission = cfg.demo.map(|(quote_limit, daily_limit)| Admission { quote_limit, daily_limit });
    Ok((Arc::new(Relay::new(db, keys, watcher, models, search, cfg.search_price, admission, Some(health))), scanner))
}

type Shared = State<Arc<Relay>>;

/// One handler per path; a wrong method is the same 404 the TypeScript relay sent.
pub fn router(relay: Arc<Relay>) -> Router {
    let no_route = || fail(404, "not_found", "no such route");
    Router::new()
        .route("/v1/info", any(move |State(r): Shared, m: Method| async move { if m == Method::GET { r.info().await } else { no_route() } }))
        .route("/v1/topup/quote", any(move |State(r): Shared, m: Method, b: Bytes| async move { if m == Method::POST { r.quote(&parse(&b)) } else { no_route() } }))
        .route(
            "/v1/topup/state",
            any(move |State(r): Shared, m: Method, Query(q): Query<HashMap<String, String>>| async move {
                if m == Method::GET { r.quote_state(q.get("quoteId").map(String::as_str).unwrap_or("")) } else { no_route() }
            }),
        )
        .route("/v1/topup/simulate", any(move |State(r): Shared, m: Method, b: Bytes| async move { if m == Method::POST { r.simulate(&parse(&b)) } else { no_route() } }))
        .route("/v1/topup/mint", any(move |State(r): Shared, m: Method, b: Bytes| async move { if m == Method::POST { r.mint_topup(&parse(&b)) } else { no_route() } }))
        .route("/v1/swap", any(move |State(r): Shared, m: Method, b: Bytes| async move { if m == Method::POST { r.swap(&parse(&b)) } else { no_route() } }))
        .route("/v1/chat", any(move |State(r): Shared, m: Method, b: Bytes| async move { if m == Method::POST { r.chat(&parse(&b)).await } else { no_route() } }))
        .route("/v1/search", any(move |State(r): Shared, m: Method, b: Bytes| async move { if m == Method::POST { r.search(&parse(&b)).await } else { no_route() } }))
        .route("/v1/settlement/ack", any(move |State(r): Shared, m: Method, b: Bytes| async move { if m == Method::POST { r.acknowledge(&parse(&b)) } else { no_route() } }))
        .with_state(relay)
}
