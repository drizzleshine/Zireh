/** Minimal fetch signature, so transports (Tor, direct, test doubles) are interchangeable. */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;
