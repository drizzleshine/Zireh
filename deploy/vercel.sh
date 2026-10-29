#!/usr/bin/env bash
# Build and deploy the browser app to Vercel production (zireh.tech), pointed at the live host:
#   deploy/vercel.sh [host-agent-name]
# Needs `vercel login` and a linked project (.vercel/, created by `vercel link --project zireh`).
# The host URL is looked up on Maritime, so a rebuilt host never leaves the app on a stale address.
# .vercelignore keeps .env, .zireh/, host/ and local notes out of the upload.
set -euo pipefail
name="${1:-zireh-host}"
root="$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"
host="$(maritime agents list --json | jq -r --arg n "$name" '.results[] | select(.name == $n) | .publicUrl' | head -1)"
[ -n "$host" ] || { echo "No Maritime agent called $name; deploy the host first (deploy/maritime/deploy.sh)." >&2; exit 1; }
curl -sf -m 15 "$host/health" >/dev/null || echo "warning: $host/health is not answering" >&2
echo "app will use host $host"
cd "$root"
vercel deploy --prod --yes --build-env "VITE_HOST_URL=$host" 2>&1 | grep -E "Production:|Error" | tail -2
