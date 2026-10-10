#!/bin/sh
# Memory guard for heavy Node / (rare) Chromium runs on Lars's Mac.
#
# Caps are DECIMAL kilobytes (1000-byte KB as reported by `ps -o rss=` on
# macOS/Linux), NOT GiB binary units:
#   SUM_KB=3000000  → 3,000,000 KB tree RSS (~2.86 GiB)
#   PER_KB=2000000  → 2,000,000 KB per process (~1.91 GiB)
# Sample ≤ 0.5 s. Kill only PIDs in this guard's process tree.
#
# Usage: scripts/mem-guard.sh [--] command...
# Optional: wrap with lockf for Chromium exclusivity:
#   lockf -k /tmp/slicc-heavy.lock scripts/mem-guard.sh …

set -eu

SUM_KB=3000000
PER_KB=2000000
SAMPLE_SEC=0.5

if [ "${1:-}" = '--' ]; then shift; fi
if [ "$#" -eq 0 ]; then
  echo "usage: mem-guard.sh [--] command..." >&2
  exit 2
fi

# Root of the tree we may kill (the command we spawn, not this shell's parent).
"$@" &
ROOT_PID=$!

# Descendants of ROOT_PID (including itself), best-effort across macOS/Linux.
pids_of_tree() {
  root="$1"
  if command -v pgrep >/dev/null 2>&1; then
    # -P is children only; walk breadth-first.
    printf '%s\n' "$root"
    queue="$root"
    while [ -n "$queue" ]; do
      next=
      for p in $queue; do
        kids=$(pgrep -P "$p" 2>/dev/null || true)
        if [ -n "$kids" ]; then
          printf '%s\n' $kids
          next="$next $kids"
        fi
      done
      queue=$next
    done
  else
    printf '%s\n' "$root"
  fi
}

rss_kb() {
  # Compare ps -o rss= (KB) against the decimal caps above.
  ps -o rss= -p "$1" 2>/dev/null | awk '{gsub(/ /,""); if ($0=="") print 0; else print $0}'
}

breach=
while kill -0 "$ROOT_PID" 2>/dev/null; do
  sum=0
  worst=0
  worst_pid=
  for pid in $(pids_of_tree "$ROOT_PID" | sort -u); do
    [ -n "$pid" ] || continue
    kb=$(rss_kb "$pid")
    case "$kb" in ''|*[!0-9]*) kb=0 ;; esac
    sum=$((sum + kb))
    if [ "$kb" -gt "$worst" ]; then
      worst=$kb
      worst_pid=$pid
    fi
    if [ "$kb" -gt "$PER_KB" ]; then
      echo "mem-guard: kill tree: pid $pid rss ${kb} KB > PER_KB=${PER_KB}" >&2
      breach=per
      break
    fi
  done
  if [ -z "$breach" ] && [ "$sum" -gt "$SUM_KB" ]; then
    echo "mem-guard: kill tree: sum ${sum} KB > SUM_KB=${SUM_KB} (worst pid ${worst_pid} ${worst} KB)" >&2
    breach=sum
  fi
  if [ -n "$breach" ]; then
    # Kill only our tree (children before parents when sort -n -r is available).
    tree=$(pids_of_tree "$ROOT_PID" | sort -un)
    for pid in $(printf '%s\n' "$tree" | sort -nr); do
      kill -TERM "$pid" 2>/dev/null || true
    done
    sleep 0.2
    for pid in $(printf '%s\n' "$tree" | sort -nr); do
      kill -KILL "$pid" 2>/dev/null || true
    done
    wait "$ROOT_PID" 2>/dev/null || true
    exit 137
  fi
  sleep "$SAMPLE_SEC"
done

wait "$ROOT_PID"
exit $?
