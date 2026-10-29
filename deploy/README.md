# Deploying Zireh

Two pieces: the browser app on **Vercel** (zireh.tech) and the Rust host on **Maritime**
(relay, ecash mint, payments, sync). Both CLIs are signed in as the deploying account
(`vercel whoami`, `maritime whoami`); GitHub pushes go to `drizzleshine/Zireh`.

| What | Where |
|---|---|
| App | https://www.zireh.tech, https://zireh.tech, https://zireh.vercel.app (Vercel project `zireh`) |
| Host | Maritime agent `zireh-host`: `maritime agents list` shows its `publicUrl` (`https://api.maritime.sh/a/<id>`) |
| DNS | zireh.tech uses Vercel's nameservers (`ns1/ns2.vercel-dns.com`); Vercel issues the HTTPS certificate |

## Everyday deploy

```bash
deploy/maritime/deploy.sh   # host: rebuilds the existing agent in place (same URL, same /data)
deploy/vercel.sh            # app: looks up the host URL and builds the app against it
```

Deploy the host first when both changed. The scripts upload only what they need: `stage.sh`
copies `host/` sources; `.vercelignore` keeps `.env`, `.zireh/`, `host/` and notes out.

## Host secrets

```bash
deploy/maritime/secrets.sh  # copies LLM_* from .env, sets RELAY_DEMO=1, restarts, prints upstreamOk
```

- Never `source .env` to pass values on: the shell strips the quotes inside JSON values such as
  `LLM_EXTRA_BODY`, and the host then refuses to start (the VM crash-loops). `secrets.sh` reads
  values as written.
- `RELAY_DEMO=1` is required while top-ups are simulated or testnet: anyone can press
  "Mark as paid", and the cap (20,000,000 credits, about $20 a day) limits what they can spend.
- For real Zcash testnet top-ups, also set the viewing key:
  `maritime agents env set <id> ZCASH_UFVK=uviewtest1... ZCASH_BIRTHDAY=<height>`, then `maritime agents restart <id>`.

## Things that bite

- **Never delete and recreate the agent.** Its `/data` volume holds the mint keys: losing them
  voids every coin people hold, and a new agent also gets a new URL (run `deploy/vercel.sh` after).
- **The host URL has a path** (`/a/<id>`). The app accepts that; Maritime has no custom domains.
- **Restart by id, not name**: `maritime agents restart <id>` (the name form returns 404).
- **"The AI couldn't be reached"** used to hide provider refusals; the privacy log shows the real
  reason (Meta's model refuses some topics with `content_policy_violation`).
- **New domain, no HTTPS yet?** If Vercel hasn't issued a certificate after the DNS change:
  `vercel certs issue zireh.tech www.zireh.tech`.
