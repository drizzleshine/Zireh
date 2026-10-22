import { randomId } from "@zireh/crypto";
import type { FetchLike } from "@zireh/schema";
import { socksDispatcher } from "fetch-socks";
import { fetch as undiciFetch } from "undici";

/**
 * How outbound requests leave the device. `fetchFor(tag)` returns a fetch bound to one
 * isolation tag: with Tor, each distinct tag gets its own circuit (SOCKS auth isolation).
 */
export interface Transport {
  readonly kind: "tor" | "direct";
  fetchFor(tag: string): FetchLike;
}

export interface SocksEndpoint {
  readonly host: string;
  readonly port: number;
}

/**
 * Tor's SocksPort isolates streams by SOCKS username/password by default (IsolateSOCKSAuth),
 * so a fresh credential per tag means a fresh circuit and a different exit.
 */
export function torTransport(socks: SocksEndpoint): Transport {
  return {
    kind: "tor",
    fetchFor(tag) {
      return async (input, init) => {
        const dispatcher = socksDispatcher({ type: 5, host: socks.host, port: socks.port, userId: tag, password: randomId() });
        try {
          return await undiciFetch(input, { ...(init as Parameters<typeof undiciFetch>[1]), dispatcher }) as unknown as Response;
        } finally {
          // close() drains active response bodies; awaiting it here would deadlock their reader.
          void dispatcher.close().catch(() => dispatcher.destroy().catch(() => {}));
        }
      };
    },
  };
}

/** No anonymity. Only for local development; the daemon labels it loudly in the UI. */
export const directTransport = (doFetch: FetchLike = fetch): Transport => ({
  kind: "direct",
  fetchFor: () => doFetch,
});

/** A fresh, unlinkable isolation tag (one per outbound call). */
export const newCircuitTag = (): string => `c-${randomId().slice(0, 12)}`;
