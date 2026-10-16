#!/bin/bash
# PROBE (#250): run the kernel suites N times in a group of our own; log any
# SIGINT/SIGTERM/SIGHUP this shell gets, and every kill(2) (strace) or JS kill.
set -u
out=${PROBE_OUT:-/tmp/probe}; mkdir -p "$out"; log=$out/signals.log; : > "$log"
cur=start
trap 'echo "$(date +%T.%N) GOT SIGINT during $cur" >> "$log"' INT
trap 'echo "$(date +%T.%N) GOT SIGTERM during $cur" >> "$log"' TERM
trap 'echo "$(date +%T.%N) GOT SIGHUP during $cur" >> "$log"' HUP
echo "pid $$ pgid $(ps -o pgid= $$) sid $(ps -o sid= $$) tty $(ps -o tty= $$)" >> "$log"
HAS_ST=; command -v strace > /dev/null && HAS_ST=1
echo "strace: ${HAS_ST:-none}" >> "$log"
export KILL_LOG=$out/kill-hook.log NODE_OPTIONS="--require $PWD/scripts/probe/kill-hook.cjs"
for i in $(seq "${1:-3}"); do
  cur="integration run $i"
  pre=(); [ -n "$HAS_ST" ] && pre=(strace -f -qq -e trace=kill,tgkill,tkill,rt_sigqueueinfo -e signal=none -o "$out/strace.$i")
  "${pre[@]}" node --max-old-space-size=512 --test --test-concurrency=3 --test-timeout=120000 test/integration/*.test.mjs > "$out/integration.$i.log" 2>&1 &
  wait $!; rc=$?
  echo "$(date +%T.%N) $cur rc=$rc $(grep -E '^ℹ (pass|fail|cancelled)' "$out/integration.$i.log" | tr '\n' ' ')" >> "$log"
done
cat "$log"
