//! What a call costs, matching `packages/wallet/src/pricing.ts`. The client computes the same
//! hold before it pays, so every step (UTF-16 lengths, float maths, rounding) must agree.

use crate::js::utf16_len;

/// µUSD per one million tokens, as published for each model.
#[derive(Clone, Debug, PartialEq)]
pub struct ModelPrice {
    pub model: String,
    pub input_per_mtok: f64,
    pub output_per_mtok: f64,
}

/// Upper bound on input tokens from text alone: 2 characters per token plus 8 per message.
pub fn input_token_bound<'a>(contents: impl IntoIterator<Item = &'a str>) -> u64 {
    contents.into_iter().map(|c| (utf16_len(c) as u64).div_ceil(2) + 8).sum()
}

fn credits(tokens: u64, per_mtok: f64) -> f64 {
    (tokens as f64 * per_mtok) / 1_000_000.0
}

fn at_least_one(cost: f64) -> u64 {
    (cost.ceil() as u64).max(1)
}

/// Coins the client must hand over before the call: the worst case.
pub fn max_cost<'a>(price: &ModelPrice, contents: impl IntoIterator<Item = &'a str>, max_tokens: u64) -> u64 {
    at_least_one(credits(input_token_bound(contents), price.input_per_mtok) + credits(max_tokens, price.output_per_mtok))
}

/// What the call actually cost, from the provider's usage report.
pub fn actual_cost(price: &ModelPrice, prompt_tokens: u64, completion_tokens: u64) -> u64 {
    at_least_one(credits(prompt_tokens, price.input_per_mtok) + credits(completion_tokens, price.output_per_mtok))
}
