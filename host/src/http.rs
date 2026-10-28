//! Shared response helpers and the routes every service shares.

use axum::{
    http::{header, StatusCode},
    response::{IntoResponse, Response},
    routing::any,
    Router,
};

/// JSON response with the same headers the TypeScript hosts send.
pub fn json_raw(status: u16, body: String) -> Response {
    (
        StatusCode::from_u16(status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR),
        [(header::CONTENT_TYPE, "application/json"), (header::CACHE_CONTROL, "no-store")],
        body,
    )
        .into_response()
}

pub fn json(status: u16, body: serde_json::Value) -> Response {
    json_raw(status, body.to_string())
}

pub fn error(status: u16, message: &str) -> Response {
    json(status, serde_json::json!({ "error": message }))
}

pub fn not_found() -> Response {
    error(404, "not found")
}

/// What the Node server answers when a handler throws: a bare 500.
pub fn internal_error() -> Response {
    (StatusCode::INTERNAL_SERVER_ERROR, [(header::CONTENT_TYPE, "text/plain; charset=UTF-8")], "Internal Server Error").into_response()
}

pub use crate::js::js_number;

/// `/health` (any method, as before) and the JSON 404 for everything unrouted.
pub fn base_router() -> Router {
    Router::new().route("/health", any(|| async { json(200, serde_json::json!({ "ok": true })) })).fallback(|| async { not_found() })
}
