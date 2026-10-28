//! Zireh host: one binary that serves every Zireh backend service.
//! Each service lives in `features/<name>` and exposes a `router(..)` that `main` merges.

pub mod config;
pub mod features;
pub mod http;
pub mod js;
