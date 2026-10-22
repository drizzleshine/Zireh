import { z } from "zod";

/** Invite-supplied hosts may reach a Tor v3 onion service or this computer's dev server. */
export const SyncHost = z.string().max(256).refine((value) => {
  try {
    const url = new URL(value);
    const host = url.hostname;
    return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash && url.pathname === "/" &&
      (host === "127.0.0.1" || host === "localhost" || /^[a-z2-7]{56}\.onion$/.test(host));
  } catch { return false; }
}, "Use a Tor v3 onion URL or a loopback URL without credentials, path, query or fragment").transform((value) => new URL(value).origin);
