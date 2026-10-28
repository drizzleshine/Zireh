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

/// `/health` (any method, as before) and the JSON 404 for everything unrouted: in the relay's
/// words under `/v1/` (except the sync service's `/v1/cases`), in the sync host's elsewhere, as
/// each answered when they were separate servers.
pub fn base_router() -> Router {
    Router::new().route("/health", any(|| async { json(200, serde_json::json!({ "ok": true })) })).fallback(|uri: axum::http::Uri| async move {
        let path = uri.path();
        if path.starts_with("/v1/") && !path.starts_with("/v1/cases") {
            json(404, serde_json::json!({ "error": "not_found", "message": "no such route" }))
        } else {
            not_found()
        }
    })
}

/// The web app runs in the browser on its own origin and calls the host directly. Nothing here
/// uses cookies or ambient credentials (calls are paid with coins or carry a case token), so any
/// origin may call it; preflights are answered without reaching the routes.
pub async fn cors(req: axum::extract::Request, next: axum::middleware::Next) -> Response {
    let mut res = if req.method() == axum::http::Method::OPTIONS { StatusCode::NO_CONTENT.into_response() } else { next.run(req).await };
    let headers = res.headers_mut();
    headers.insert(header::ACCESS_CONTROL_ALLOW_ORIGIN, header::HeaderValue::from_static("*"));
    headers.insert(header::ACCESS_CONTROL_ALLOW_METHODS, header::HeaderValue::from_static("GET, POST"));
    headers.insert(header::ACCESS_CONTROL_ALLOW_HEADERS, header::HeaderValue::from_static("content-type, x-case-token"));
    headers.insert(header::ACCESS_CONTROL_MAX_AGE, header::HeaderValue::from_static("600"));
    res
}
