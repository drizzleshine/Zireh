#!/usr/bin/env bash
# Deploy the Rust host (sync + relay + payments) to Maritime as one always-on, public HTTPS container:
#   deploy/maritime/deploy.sh [agent-name]
# Needs `maritime login` first. Uploads a staged copy (see stage.sh: host/ sources only, no .zireh/,
# .env or node_modules). The first run creates the agent; later runs rebuild that same agent, so
# its public URL, its /data volume (mint keys, spent coins, sync records) and its secrets stay.
# Secrets are set separately and never uploaded: see secrets.sh.
set -euo pipefail
name="${1:-zireh-host}"
here="$(cd "$(dirname "$0")" && pwd)"
stage="$(mktemp -d)/host"
agent() { maritime agents list --json | jq -r --arg n "$name" '.results[] | select(.name == $n) | .'"$1" | head -1; }

"$here/stage.sh" "$stage"
upload="$(maritime agents upload-source "$stage" --json)"
key="$(jq -r '[.. | objects | (.uploadS3Key // .s3Key // .upload_key // empty)] | first // empty' <<<"$upload")"
[ -n "$key" ] || { echo "Couldn't find the upload key in: $upload" >&2; exit 1; }

id="$(agent id)"
if [ -n "$id" ]; then
  echo "rebuilding $name ($id) in place"
  deployment="$(maritime deployments create --body-json "$(jq -nc --arg id "$id" --arg key "$key" '{agentId: $id, source: "zip", uploadS3Key: $key}')" --json | jq -r '.results.id // .data.id // .id')"
  status=pending
  for _ in $(seq 1 90); do
    status="$(maritime deployments get "$deployment" --json | jq -r '.results.status // .data.status // .status')"
    echo "build: $status"
    case "$status" in success) break ;; failed | error | cancelled) echo "The build failed: maritime deployments get $deployment" >&2; exit 1 ;; esac
    sleep 10
  done
  [ "$status" = success ] || { echo "The build is still $status after 15 minutes: maritime deployments get $deployment" >&2; exit 1; }
else
  echo "creating $name"
  jq -n --arg name "$name" --arg key "$key" '{
    name: $name, framework: "custom", uploadS3Key: $key,
    exposedPort: 8080, healthCheckPath: "/health", publicWeb: true,
    idleTtlSeconds: 0
  }' | maritime agents create --stdin --json >/dev/null
  id="$(agent id)"
fi

url="$(agent publicUrl)"
for _ in $(seq 1 60); do
  curl -sf -m 10 "$url/health" >/dev/null && break
  sleep 10
done
curl -sf -m 10 "$url/health" >/dev/null || { echo "$url/health is not answering yet; see: maritime logs $id" >&2; exit 1; }
echo "live: $url"
curl -s -m 15 "$url/v1/info" | jq -c '{keyset: .keyset.id, model: .prices[0].model, network, upstreamOk}'
