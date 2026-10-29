#!/usr/bin/env bash
# Copy the host's AI settings from the local .env to the Maritime agent as secrets, then restart it:
#   deploy/maritime/secrets.sh [agent-name] [KEY ...]
# Values are read as written in .env (never through the shell, which would strip the quotes inside
# JSON such as LLM_EXTRA_BODY and stop the host from starting) and are never printed.
# RELAY_DEMO=1 is always set: free (simulated or testnet) coins must not spend a paid provider
# without the daily cap. RELAY_DEMO_DAILY_LIMIT is left at the host default unless you name it.
set -euo pipefail
name="${1:-zireh-host}"
shift || true
keys=("${@:-LLM_API_KEY LLM_BASE_URL LLM_MODELS LLM_EXTRA_BODY}")
root="$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"
id="$(maritime agents list --json | jq -r --arg n "$name" '.results[] | select(.name == $n) | .id' | head -1)"
[ -n "$id" ] || { echo "No agent called $name. Run deploy.sh first." >&2; exit 1; }

pairs=("RELAY_DEMO=1")
for key in ${keys[*]}; do
  line="$(grep -E "^(export )?$key=" "$root/.env" | tail -1 || true)"
  [ -n "$line" ] || { echo "skipping $key (not in .env)"; continue; }
  value="${line#*=}"
  # Strip one pair of surrounding quotes, as the host's own .env reader does.
  if [[ "$value" =~ ^\"(.*)\"$ || "$value" =~ ^\'(.*)\'$ ]]; then value="${BASH_REMATCH[1]}"; fi
  pairs+=("$key=$value")
  echo "setting $key"
done
maritime agents env set "$id" "${pairs[@]}" >/dev/null
maritime agents restart "$id" >/dev/null
url="$(maritime agents list --json | jq -r --arg n "$name" '.results[] | select(.name == $n) | .publicUrl' | head -1)"
for _ in $(seq 1 30); do
  info="$(curl -s -m 15 "$url/v1/info" || true)"
  jq -e '.prices' >/dev/null 2>&1 <<<"$info" && break
  sleep 10
done
jq -c '{model: .prices[0].model, network, upstreamOk}' <<<"$info"
