//! Sync service: an append-only log of sealed envelopes per case. It checks the case token
//! but never sees a key or a plaintext record.

pub mod routes;
pub mod store;

pub const MAX_SYNC_BODY_BYTES: usize = 4 * 1024 * 1024;
pub const MAX_RECORDS_PER_PUSH: usize = 200;
pub const MAX_RECORDS_PER_PULL: i64 = 500;
