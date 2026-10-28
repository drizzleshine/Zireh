#!/usr/bin/env bash
# Deploy the Rust host (sync + relay + payments) to Maritime as one always-on, public HTTPS container:
#   deploy/maritime/deploy.sh [agent-name]
# Needs `maritime login` first. Uploads a staged copy (see stage.sh: host/ sources only, no .zireh/,
# .env or node_modules), creates the agent, and waits for it to answer /health.
# Secrets are set afterwards, never uploaded, for example:
#   maritime env set zireh-host LLM_API_KEY=... LLM_BASE_URL=... LLM_MODELS=... RELAY_DEMO=1 --secret --reload --json
#   maritime env set zireh-host ZCASH_UFVK=uviewtest1... ZCASH_NETWORK=testnet --secret --reload --json
set -euo pipefail
name="${1:-zireh-host}"
here="$(cd "$(dirname "$0")" && pwd)"
stage="$(mktemp -d)/host"

"$here/stage.sh" "$stage"
upload="$(maritime agents upload-source "$stage" --json)"
key="$(jq -r '.uploadS3Key // .upload_key // .key // .s3Key // empty' <<<"$upload")"
[ -n "$key" ] || { echo "Couldn't find the upload key in: $upload" >&2; exit 1; }

jq -n --arg name "$name" --arg key "$key" '{
  name: $name, framework: "custom", uploadS3Key: $key,
  exposedPort: 8080, healthCheckPath: "/health", publicWeb: true,
  idleTtlSeconds: 0
}' | maritime agents create --stdin --json

for _ in $(seq 1 60); do
  status="$(maritime status "$name" --json | jq -r '.status')"
  echo "status: $status"
  [ "$status" = "active" ] && break
  sleep 10
done
maritime logs "$name" --json | jq -r '.[]?.message // .logs[]?.message // empty' | tail -5
