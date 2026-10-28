//! Coin denominations and change, matching `packages/wallet/src/amounts.ts`.

/// Coins are powers of two from 1 to 2^MAX_EXP credits (1 credit = 1 µUSD).
pub const MAX_EXP: u32 = 24; // largest coin ≈ $16.78

pub fn denominations() -> impl Iterator<Item = u64> {
    (0..=MAX_EXP).map(|i| 1u64 << i)
}

/// Binary decomposition: 13 → [8, 4, 1]. Larger amounts repeat the top coin.
pub fn split_amount(total: u64) -> Vec<u64> {
    let top = 1u64 << MAX_EXP;
    let mut out = Vec::new();
    let mut rest = total;
    while rest >= top * 2 {
        out.push(top);
        rest -= top;
    }
    for i in (0..=MAX_EXP).rev() {
        if rest == 0 {
            break;
        }
        let d = 1u64 << i;
        if rest >= d {
            out.push(d);
            rest -= d;
        }
    }
    out
}

/// Number of blank outputs that can carry any change up to `max_change`.
pub fn blank_output_count(max_change: u64) -> u64 {
    if max_change == 0 {
        0
    } else {
        // Same float steps as `Math.ceil(Math.log2(maxChange + 1))`.
        ((max_change as f64 + 1.0).log2().ceil() as u64).max(1)
    }
}
