import { z } from "zod";

/** No credentials, query or fragment. A path is allowed: some hosts serve the API under a prefix. */
const plainUrl = (url: URL) => !url.username && !url.password && !url.search && !url.hash;
/** The origin plus any path prefix, with no trailing slash. */
const base = (value: string) => {
  const url = new URL(value);
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
};
const loopback = (host: string) => host === "127.0.0.1" || host === "localhost" || host === "[::1]";
/** A public name: no IP literals (which could point at a router or cloud metadata) and no local-only names. */
const publicName = (host: string) => host.includes(".") && !/^[\d.]+$/.test(host) && !host.startsWith("[") && !/\.(local|localhost|internal|lan|home|onion)$/.test(host);

/** Hosts that may be written into an invite: a public HTTPS origin, never a loopback or private address. */
export const InviteSyncHost = z.string().max(256).refine((value) => {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && plainUrl(url) && publicName(url.hostname);
  } catch { return false; }
}, "Use a public HTTPS URL without credentials, query or fragment").transform(base);

/** Hosts this device may sync with: any invite host, or this computer's own dev host. */
export const SyncHost = z.string().max(256).refine((value) => {
  try {
    const url = new URL(value);
    return InviteSyncHost.safeParse(value).success || (["http:", "https:"].includes(url.protocol) && plainUrl(url) && loopback(url.hostname));
  } catch { return false; }
}, "Use a public HTTPS URL or a loopback URL without credentials, query or fragment").transform(base);
