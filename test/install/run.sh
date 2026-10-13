#!/bin/sh
# Exercise install.sh from this checkout in throwaway HOMEs, against the
# published package on the npm registry.
#
#   test/install/run.sh [node|no-node|pty|uninstall]...   (default: all four)
#
# node       Node 22+ on PATH: install an older version, run a
#            #!/usr/bin/env jsh script, re-run to upgrade to the latest, and
#            check a failed upgrade keeps the old install.
# no-node    no Node on PATH and no terminal: a clean failure with the
#            Node install instructions (and the same for a too-old Node).
# pty        no Node on PATH, on a pseudo-terminal (test/install/answer-tty.py):
#            answer "no", then "yes" to the Node download and the rc line.
# uninstall  --uninstall removes JSH_HOME and the wrapper, names the rc line.
#
# Needs curl, node 22+ (for this harness and the "node" case), python3 (pty)
# and perl (to drop the controlling terminal for no-node).

# The rc lines are literal "$HOME/…" text, and ls lists our own dirs.
# shellcheck disable=SC2016,SC2012
set -eu

here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/../.." && pwd)
installer="$root/install.sh"
PREV=0.16.0

fail() {
  printf 'FAIL: %s\n' "$*" >&2
  exit 1
}
pass() { printf 'ok: %s\n' "$*"; }

latest=$(curl -fsSL https://registry.npmjs.org/@ai-ecoverse/slicc-jsh/latest |
  node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(0, "utf8")).version)')
[ "$latest" != "$PREV" ] || fail "PREV ($PREV) is the latest; pick an older one"

work=$(mktemp -d "${TMPDIR:-/tmp}/jsh-install-test.XXXXXX")
trap 'rm -rf "$work"' EXIT

fresh_home() {
  h="$work/$1"
  mkdir -p "$h"
  printf '%s' "$h"
}

# A PATH with the tools install.sh uses and no node.
sandbox_path() {
  sb="$work/sandbox-bin"
  if [ ! -d "$sb" ]; then
    mkdir -p "$sb"
    for t in sh curl tar gzip uname sysctl awk sed grep cut mkdir mv rm chmod \
      mktemp cat ls basename dirname ldd sha256sum shasum openssl perl env; do
      p=$(command -v "$t" 2>/dev/null || true)
      case $p in /*) ln -s "$p" "$sb/$t" ;; esac
    done
  fi
  ! PATH="$sb" command -v node >/dev/null 2>&1 || fail "sandbox PATH has a node"
  printf '%s' "$sb"
}

# Run "$@" with no controlling terminal and stdin from /dev/null.
no_tty() {
  perl -MPOSIX -e 'my $p = fork; if ($p) { waitpid($p, 0); exit($? >> 8) } POSIX::setsid(); exec @ARGV or die "exec: $!"' "$@" </dev/null
}

check_wrapper_version() { # home bin_dir want
  got=$("$2/jsh" --version)
  [ "$got" = "$3" ] || fail "jsh --version is $got, want $3"
}

case_node() {
  h=$(fresh_home node)
  node_major=$(node -p 'process.versions.node.split(".")[0]')
  [ "$node_major" -ge 22 ] || fail "the node case needs Node 22+ on PATH (have $(node --version))"

  # Install an older version, piped as from curl, with --version.
  out=$(HOME="$h" SHELL=/bin/zsh no_tty sh -c "cat '$installer' | sh -s -- --version $PREV" 2>&1) ||
    fail "install $PREV: $out"
  printf '%s\n' "$out"
  check_wrapper_version "$h" "$h/.local/bin" "$PREV"
  printf '%s\n' "$out" | grep -qF 'export PATH="$HOME/.local/bin:$PATH"' ||
    fail "no PATH line printed without a terminal"
  [ ! -e "$h/.zshrc" ] || fail ".zshrc written without asking"
  pass "piped install of $PREV"

  # A #!/usr/bin/env jsh script, with a sliccy: module, from cron-like env.
  printf '#!/usr/bin/env jsh\nconsole.log(require("sliccy:fmt").col("ok", 4) + "|", process.argv.slice(2).join(","));\n' >"$h/smoke.jsh"
  chmod +x "$h/smoke.jsh"
  got=$(env -i HOME="$h" PATH="$h/.local/bin:/usr/bin:/bin" "$h/smoke.jsh" a b)
  [ "$got" = "ok  | a,b" ] || fail "smoke.jsh said: $got"
  pass "#!/usr/bin/env jsh script runs"

  # A failed upgrade (bad version) leaves the old one working.
  if HOME="$h" JSH_VERSION=0.0.0-does-not-exist no_tty sh "$installer" >"$work/bad.txt" 2>&1; then
    fail "installing a missing version succeeded"
  fi
  grep -q 'is 0.0.0-does-not-exist a published version' "$work/bad.txt" || fail "bad version: $(cat "$work/bad.txt")"
  check_wrapper_version "$h" "$h/.local/bin" "$PREV"
  pass "a failed upgrade keeps $PREV"

  # Re-run from the file: upgrades in place to the registry's latest.
  HOME="$h" SHELL=/bin/zsh no_tty sh "$installer" || fail "upgrade"
  check_wrapper_version "$h" "$h/.local/bin" "$latest"
  got=$(env -i HOME="$h" PATH="$h/.local/bin:/usr/bin:/bin" "$h/smoke.jsh" a b)
  [ "$got" = "ok  | a,b" ] || fail "smoke.jsh after upgrade said: $got"
  [ "$(ls -A "$h/.jsh/lib/node_modules/@ai-ecoverse" | tr '\n' ' ')" = "slicc-jsh " ] ||
    fail "leftovers: $(ls -A "$h/.jsh/lib/node_modules/@ai-ecoverse")"
  [ "$(ls -A "$h/.jsh" | tr '\n' ' ')" = ".installed-by lib " ] || fail "leftovers in .jsh: $(ls -A "$h/.jsh")"
  pass "re-run upgrades $PREV → $latest"

  # JSH_HOME / JSH_BIN_DIR, and a bin dir already on PATH (no PATH line).
  HOME="$h" JSH_HOME="$h/alt" JSH_BIN_DIR="$h/altbin" PATH="$h/altbin:$PATH" no_tty sh "$installer" >"$work/alt.txt" 2>&1 ||
    fail "JSH_HOME install: $(cat "$work/alt.txt")"
  ! grep -q 'export PATH' "$work/alt.txt" || fail "printed a PATH line for a bin dir on PATH"
  check_wrapper_version "$h" "$h/altbin" "$latest"
  grep -qF "$h/alt/lib/node_modules/@ai-ecoverse/slicc-jsh/dist/host/jsh.mjs" "$h/altbin/jsh" ||
    fail "wrapper does not use JSH_HOME"
  pass "JSH_HOME and JSH_BIN_DIR"
}

case_no_node() {
  sb=$(sandbox_path)
  h=$(fresh_home no-node)
  if HOME="$h" PATH="$sb" no_tty sh "$installer" >"$work/no-node.txt" 2>&1; then
    fail "no-node install succeeded: $(cat "$work/no-node.txt")"
  fi
  cat "$work/no-node.txt"
  for want in 'Node.js is not on PATH' 'https://nodejs.org' 'brew install node@22' 'fnm install 22' \
    'nvm install 22' 're-run it in a terminal' 'no terminal to ask on'; do
    grep -qF "$want" "$work/no-node.txt" || fail "no-node output lacks: $want"
  done
  if [ -e "$h/.jsh" ] || [ -e "$h/.local/bin/jsh" ]; then fail "no-node left files behind"; fi
  pass "no Node, no terminal: clean failure with instructions"

  # A too-old node on PATH is the same.
  mkdir -p "$work/old-node"
  printf '#!/bin/sh\ncase $1 in --version) echo v18.20.0 ;; *) printf 18 ;; esac\n' >"$work/old-node/node"
  chmod +x "$work/old-node/node"
  h=$(fresh_home old-node)
  if HOME="$h" PATH="$work/old-node:$sb" no_tty sh "$installer" >"$work/old.txt" 2>&1; then
    fail "old-node install succeeded"
  fi
  grep -qF 'is too old; jsh needs Node 22' "$work/old.txt" || fail "old-node output: $(cat "$work/old.txt")"
  grep -qF 'https://nodejs.org' "$work/old.txt" || fail "old-node output lacks instructions"
  pass "Node 18, no terminal: clean failure with instructions"
}

case_pty() {
  sb=$(sandbox_path)
  py=$(command -v python3) || fail "the pty case needs python3"
  h=$(fresh_home pty-no)
  if HOME="$h" PATH="$sb" "$py" "$here/answer-tty.py" --expect 'Download Node 22.*\[y/N\]' --send 'n\n' \
    -- sh "$installer" >"$work/pty-no.txt" 2>&1; then
    fail "answering no succeeded"
  fi
  grep -qF 'Node was not installed' "$work/pty-no.txt" || fail "pty no: $(cat "$work/pty-no.txt")"
  [ ! -e "$h/.jsh/node" ] || fail "answering no installed Node"
  pass "pty: answering no stops with instructions"

  h=$(fresh_home pty-yes)
  HOME="$h" PATH="$sb" SHELL=/bin/bash "$py" "$here/answer-tty.py" \
    --expect 'Download Node 22.*\[y/N\]' --send 'y\n' \
    --expect 'Add it to PATH in .*\[y/N\]' --send 'y\n' \
    -- sh "$installer" || fail "pty yes"
  [ -x "$h/.jsh/node/bin/node" ] || fail "no private node"
  case $("$h/.jsh/node/bin/node" --version) in v22.*) ;; *) fail "private node is not 22" ;; esac
  grep -qF "node='$h/.jsh/node/bin/node'" "$h/.local/bin/jsh" || fail "wrapper does not use the private node"
  check_wrapper_version "$h" "$h/.local/bin" "$latest"
  if [ "$(uname -s)" = Darwin ]; then rc="$h/.bash_profile"; else rc="$h/.bashrc"; fi
  grep -qxF 'export PATH="$HOME/.local/bin:$PATH"' "$rc" || fail "rc line missing in $rc"
  # The rc line works, and jsh runs with no node on PATH at all.
  got=$(env -i HOME="$h" PATH="$sb" sh -c ". '$rc'; jsh --version")
  [ "$got" = "$latest" ] || fail "jsh from the rc PATH said: $got"
  pass "pty: yes installs Node $("$h/.jsh/node/bin/node" --version) and the rc line"

  # Re-run: keeps the private Node (no question), says it is up to date.
  HOME="$h" PATH="$sb" SHELL=/bin/bash no_tty sh "$installer" >"$work/pty-rerun.txt" 2>&1 ||
    fail "re-run with private node: $(cat "$work/pty-rerun.txt")"
  grep -q 'is up to date in' "$work/pty-rerun.txt" || fail "re-run: $(cat "$work/pty-rerun.txt")"
  grep -q 'already adds' "$work/pty-rerun.txt" || fail "re-run asked about PATH again"
  [ "$(grep -c 'export PATH' "$rc")" = 1 ] || fail "rc line added twice"
  pass "pty: re-run keeps the private Node and the rc line"
}

case_uninstall() {
  h=$(fresh_home uninstall)
  HOME="$h" no_tty sh "$installer" >/dev/null 2>&1 || fail "install before uninstall"
  printf '\n# jsh (slicc-jsh install.sh)\nexport PATH="$HOME/.local/bin:$PATH"\n' >>"$h/.zshrc"
  cp "$h/.zshrc" "$work/zshrc.before"
  printf '#!/bin/sh\necho mine\n' >"$work/other-jsh"
  HOME="$h" no_tty sh -c "cat '$installer' | sh -s -- --uninstall" >"$work/un.txt" 2>&1 ||
    fail "uninstall: $(cat "$work/un.txt")"
  cat "$work/un.txt"
  [ ! -e "$h/.jsh" ] || fail ".jsh still there"
  [ ! -e "$h/.local/bin/jsh" ] || fail "wrapper still there"
  grep -qF '$HOME/.zshrc' "$work/un.txt" || fail "uninstall does not name .zshrc"
  grep -qF 'export PATH="$HOME/.local/bin:$PATH"' "$work/un.txt" || fail "uninstall does not show the rc line"
  cmp -s "$h/.zshrc" "$work/zshrc.before" || fail "uninstall edited .zshrc"
  pass "--uninstall removes JSH_HOME and the wrapper, names the rc line"

  # It leaves a jsh it did not write, and a JSH_HOME it did not create.
  mkdir -p "$h/.local/bin" "$h/notours"
  cp "$work/other-jsh" "$h/.local/bin/jsh"
  : >"$h/notours/keep"
  HOME="$h" no_tty sh "$installer" --uninstall >/dev/null 2>&1 || true
  [ -e "$h/.local/bin/jsh" ] || fail "uninstall removed a foreign jsh"
  if HOME="$h" JSH_HOME="$h/notours" no_tty sh "$installer" --uninstall >/dev/null 2>&1; then
    fail "uninstall of a foreign JSH_HOME succeeded"
  fi
  [ -e "$h/notours/keep" ] || fail "uninstall removed a foreign JSH_HOME"
  if HOME="$h" no_tty sh "$installer" >"$work/foreign.txt" 2>&1; then
    fail "install over a foreign jsh succeeded"
  fi
  grep -q 'was not written by this installer' "$work/foreign.txt" || fail "foreign: $(cat "$work/foreign.txt")"
  pass "leaves files it did not write"
}

[ $# -gt 0 ] || set -- node no-node pty uninstall
for c in "$@"; do
  printf '\n== %s ==\n' "$c"
  case $c in
    node) case_node ;;
    no-node) case_no_node ;;
    pty) case_pty ;;
    uninstall) case_uninstall ;;
    *) fail "unknown case: $c" ;;
  esac
done
printf '\nall install.sh cases passed\n'
