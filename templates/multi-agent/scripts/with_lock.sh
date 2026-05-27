#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
lock_parent="$repo_root/comms/locks"
lock_dir="$lock_parent/comms.lockdir"

mkdir -p "$lock_parent"

if [ "$#" -eq 0 ]; then
  echo "Usage: .multi-agent/scripts/with_lock.sh <command> [args...]" >&2
  exit 2
fi

cleanup() {
  if [ "${lock_acquired:-0}" = "1" ]; then
    rmdir "$lock_dir"
  fi
}

trap cleanup EXIT INT TERM

lock_acquired=0
while ! mkdir "$lock_dir" 2>/dev/null; do
  sleep 0.2
done
lock_acquired=1

"$@"
