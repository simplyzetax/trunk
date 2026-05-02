#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGLITE_DIR="$ROOT_DIR/vendor/pglite"
POSTGRES_PGLITE_DIR="$PGLITE_DIR/postgres-pglite"
MEMORY_MB="${PGLITE_MEMORY_MB:-64}"
PATCH_FILE="$ROOT_DIR/patches/postgres-pglite-initial-memory-${MEMORY_MB}mb.patch"
ARTIFACT_FILE="$ROOT_DIR/src/vendor/pglite/pglite.wasm"
PATCH_APPLIED=0

cleanup() {
	if [ "$PATCH_APPLIED" = "1" ]; then
		git -C "$POSTGRES_PGLITE_DIR" apply --reverse "$PATCH_FILE"
	fi
}

trap cleanup EXIT

if [ ! -d "$PGLITE_DIR/.git" ] && [ ! -f "$PGLITE_DIR/.git" ]; then
	printf 'Missing PGlite submodule at %s\n' "$PGLITE_DIR" >&2
	printf 'Run: git submodule update --init --recursive vendor/pglite\n' >&2
	exit 1
fi

if [ ! -f "$PATCH_FILE" ]; then
	printf 'Missing patch file: %s\n' "$PATCH_FILE" >&2
	exit 1
fi

git -C "$PGLITE_DIR" submodule update --init --recursive

if git -C "$POSTGRES_PGLITE_DIR" apply --check "$PATCH_FILE"; then
	git -C "$POSTGRES_PGLITE_DIR" apply "$PATCH_FILE"
	PATCH_APPLIED=1
elif git -C "$POSTGRES_PGLITE_DIR" apply --reverse --check "$PATCH_FILE"; then
	printf 'PGlite memory patch is already applied.\n'
else
	printf 'Unable to apply %s cleanly. Check %s for local changes.\n' "$PATCH_FILE" "$POSTGRES_PGLITE_DIR" >&2
	exit 1
fi

pnpm --dir "$PGLITE_DIR" wasm:build
node "$ROOT_DIR/scripts/verify-pglite-memory.mjs" "$PGLITE_DIR/packages/pglite/release/pglite.wasm" "$MEMORY_MB"
mkdir -p "$(dirname "$ARTIFACT_FILE")"
cp "$PGLITE_DIR/packages/pglite/release/pglite.wasm" "$ARTIFACT_FILE"
node "$ROOT_DIR/scripts/verify-pglite-memory.mjs" "$ARTIFACT_FILE" "$MEMORY_MB"

printf 'Built lower-memory PGlite artifact at %s\n' "$ARTIFACT_FILE"
