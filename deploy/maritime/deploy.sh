#!/usr/bin/env bash
# Deploy the Rust host (or ZecCheckout) to Maritime as an always-on, public HTTPS container:
#   deploy/maritime/deploy.sh host|zeccheckout [agent-name]
# Needs `maritime login` first. Uploads a staged copy (see stage.sh: host/ sources only, no .zireh/,
# .env or node_modules), creates the agent, and waits for it to answer /health.
# Secrets are set afterwards, never uploaded. The relay is being ported into the host; until
# then the host serves sync only. ZecCheckout (real Zcash top-ups):
#   maritime env set zireh-zeccheckout ZC_UFVK=uviewtest1... ZC_API_KEY=... --secret --reload --json
set -euo pipefail
service="${1:?host or zeccheckout}"
name="${2:-zireh-$service}"
here="$(cd "$(dirname "$0")" && pwd)"
stage="$(mktemp -d)/$service"

"$here/stage.sh" "$service" "$stage"
upload="$(maritime agents upload-source "$stage" --json)"
key="$(jq -r '.uploadS3Key // .upload_key // .key // .s3Key // empty' <<<"$upload")"
[ -n "$key" ] || { echo "Couldn't find the upload key in: $upload" >&2; exit 1; }

health="/health"; [ "$service" = zeccheckout ] && health="/healthz"
jq -n --arg name "$name" --arg key "$key" --arg health "$health" '{
  name: $name, framework: "custom", uploadS3Key: $key,
  exposedPort: 8080, healthCheckPath: $health, publicWeb: true,
  idleTtlSeconds: 0
}' | maritime agents create --stdin --json

for _ in $(seq 1 60); do
  status="$(maritime status "$name" --json | jq -r '.status')"
  echo "status: $status"
  [ "$status" = "active" ] && break
  sleep 10
done
maritime logs "$name" --json | jq -r '.[]?.message // .logs[]?.message // empty' | tail -5
