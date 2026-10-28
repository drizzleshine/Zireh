//! Sync service: an append-only log of sealed envelopes per case. It checks the case token
//! but never sees a key or a plaintext record.

pub mod routes;
pub mod store;

/// Large enough for one evidence item with 10 MB of files after base64 and encryption.
pub const MAX_SYNC_BODY_BYTES: usize = 24 * 1024 * 1024;
/// A pull page stops adding records past this many sealed bytes (it always carries at least one).
pub const MAX_PULL_PAGE_BYTES: usize = 32 * 1024 * 1024;
pub const MAX_RECORDS_PER_PUSH: usize = 200;
pub const MAX_RECORDS_PER_PULL: i64 = 500;
