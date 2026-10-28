#!/usr/bin/env bash
# Stage a clean copy of the Rust host for upload, with its Dockerfile at the root:
#   deploy/maritime/stage.sh <out-dir>
# Only host/ (Cargo.toml, Cargo.lock, src, tests) is copied, so .zireh/ (local keys and data),
# .env files and node_modules never leave this machine.
set -euo pipefail
out="${1:?output directory}"
root="$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"
rm -rf "$out" && mkdir -p "$out"
for f in Cargo.toml Cargo.lock src tests; do cp -R "$root/host/$f" "$out/"; done
cp "$root/deploy/maritime/host.Dockerfile" "$out/Dockerfile"
echo "staged the host in $out ($(du -sh "$out" | cut -f1))"
