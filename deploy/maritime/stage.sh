#!/usr/bin/env bash
# Stage a clean copy of what a service needs for upload, with its Dockerfile at the root:
#   deploy/maritime/stage.sh host|zeccheckout <out-dir>
# The host stage holds only host/ (Cargo.toml, Cargo.lock, src, tests), so .zireh/ (local
# keys and data), .env files and node_modules never leave this machine.
set -euo pipefail
service="${1:?host or zeccheckout}"
out="${2:?output directory}"
root="$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"
rm -rf "$out" && mkdir -p "$out"
case "$service" in
  # ZecCheckout is a published image: its upload is the Dockerfile alone.
  zeccheckout) ;;
  host)
    for f in Cargo.toml Cargo.lock src tests; do cp -R "$root/host/$f" "$out/"; done
    ;;
  *) echo "unknown service: $service (host or zeccheckout)" >&2; exit 1 ;;
esac
cp "$root/deploy/maritime/$service.Dockerfile" "$out/Dockerfile"
echo "staged $service in $out ($(du -sh "$out" | cut -f1))"
