import { randomId } from "@zireh/crypto";
import type { FetchLike } from "@zireh/schema";

/**
 * How requests reach the relay. `fetchFor(tag)` returns a fetch for one call; each call gets a
 * fresh tag so a transport that can isolate calls (separate connections or circuits) may do so.
 */
export interface Transport {
  readonly kind: "direct";
  fetchFor(tag: string): FetchLike;
}

/** Plain HTTPS from this device: the relay sees its network address, never the question's owner. */
export const directTransport = (doFetch: FetchLike = (input, init) => fetch(input, init)): Transport => ({
  kind: "direct",
  fetchFor: () => doFetch,
});

/** A fresh, unlinkable tag (one per outbound call). */
export const newCircuitTag = (): string => `c-${randomId().slice(0, 12)}`;
