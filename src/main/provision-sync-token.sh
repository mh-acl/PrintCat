#!/bin/bash
# Run once per laptop, by an actual admin, to provision the GitHub
# push credential used by Tools > "Add items to Print Catalog...".
#
# Writes the token to a root-owned file, mode 600 -- readable only by
# root. A co-admin's ordinary (non-admin) session can't read it
# directly; the app can only get at it by prompting for and receiving
# successful admin authorization at push time (see tokenStore.js).
#
# The token itself should be a fine-grained GitHub Personal Access
# Token scoped to only this one repo, with just "Contents:
# Read and write" permission -- not a classic token with broader repo
# or account access, since a lost/wiped laptop should only ever be
# able to compromise this one repo.
#
# Usage: sudo ./provision-sync-token.sh <token>

set -euo pipefail

TOKEN="${1:?Usage: sudo ./provision-sync-token.sh <token>}"
DIR="/Library/Application Support/PrintCatalog"
FILE="$DIR/sync-token"

if [ "$(id -u)" -ne 0 ]; then
  echo "This must be run with sudo (it needs to create a root-owned file)." >&2
  exit 1
fi

mkdir -p "$DIR"
printf '%s' "$TOKEN" > "$FILE"
chown root:wheel "$FILE"
chmod 600 "$FILE"

echo "Token written to \"$FILE\" (root-owned, mode 600)."
