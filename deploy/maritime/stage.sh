#!/usr/bin/env bash
# Stage a clean copy of the repo for upload, with the chosen Dockerfile at its root:
#   deploy/maritime/stage.sh relay|sync-host|zeccheckout <out-dir>
# Only files git tracks or would track are copied, so .zireh/ (local keys and data),
# .env files and node_modules never leave this machine.
set -euo pipefail
service="${1:?relay, sync-host or zeccheckout}"
out="${2:?output directory}"
root="$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"
rm -rf "$out" && mkdir -p "$out"
# ZecCheckout is a published image: its upload is the Dockerfile alone.
if [ "$service" = zeccheckout ]; then
  cp "$root/deploy/maritime/zeccheckout.Dockerfile" "$out/Dockerfile"
  echo "staged zeccheckout in $out"
  exit 0
fi
cd "$root"
git ls-files -co --exclude-standard -z | grep -zv -E '^(docs/|context/|\.claude/|app/test/)' | xargs -0 -I{} rsync -R "{}" "$out/"
cp "deploy/maritime/$service.Dockerfile" "$out/Dockerfile"
echo "staged $service in $out ($(du -sh "$out" | cut -f1))"
