#!/bin/sh
# Install the host `jsh` (@ai-ecoverse/slicc-jsh) on macOS or Linux, without npm.
#
#   curl -fsSL https://raw.githubusercontent.com/ai-ecoverse/slicc-jsh/main/install.sh | sh
#   curl -fsSL …/install.sh | sh -s -- --version 0.16.1
#   curl -fsSL …/install.sh | sh -s -- --uninstall
#
# It needs Node 22 or later. If `node` on PATH is missing or older, it asks
# (on /dev/tty) before downloading Node 22 LTS from nodejs.org into
# $JSH_HOME/node. jsh goes to $JSH_HOME/lib/node_modules/@ai-ecoverse/slicc-jsh
# and a wrapper to $JSH_BIN_DIR/jsh. Re-running it upgrades in place.
#
# Environment:
#   JSH_HOME     where jsh (and a private Node) live   (default: ~/.jsh)
#   JSH_BIN_DIR  where the `jsh` wrapper goes          (default: ~/.local/bin)
#   JSH_VERSION  the slicc-jsh version to install      (default: the latest)
#
# Windows: ai-ecoverse/slicc-jsh#127.
#
# Everything runs from main(), called on the last line, so a truncated
# download runs nothing.

set -eu

PKG=@ai-ecoverse/slicc-jsh
REGISTRY=https://registry.npmjs.org
NODE_DIST=https://nodejs.org/dist
NODE_MAJOR=22
INSTALL_URL=https://raw.githubusercontent.com/ai-ecoverse/slicc-jsh/main/install.sh
# Marks files this script wrote, so --uninstall only removes those.
MARKER='slicc-jsh install.sh'

say() { printf 'jsh: %s\n' "$*"; }
warn() { printf 'jsh: warning: %s\n' "$*" >&2; }
die() {
  printf 'jsh: error: %s\n' "$*" >&2
  exit 1
}
have() { command -v "$1" >/dev/null 2>&1; }

# Single-quote a string for sh.
shquote() {
  printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")"
}

# Show a path with $HOME as `$HOME`, for lines users paste into an rc file.
home_form() {
  case $1 in
    "$HOME"/*) printf '%s/%s' "\$HOME" "${1#"$HOME"/}" ;;
    *) printf '%s' "$1" ;;
  esac
}

absolute() {
  case $1 in
    /*) printf '%s' "$1" ;;
    *) printf '%s/%s' "$(pwd)" "$1" ;;
  esac
}

# A terminal we can ask on, even when the script itself is piped into sh.
has_tty() { (: </dev/tty >/dev/tty) 2>/dev/null; }

# ask "question" → 0 on yes. Only call after has_tty.
ask() {
  printf '%s [y/N] ' "$1" >/dev/tty
  answer=
  read -r answer </dev/tty || true
  case $answer in
    [yY] | [yY][eE][sS]) return 0 ;;
    *) return 1 ;;
  esac
}

# fetch URL FILE; fails (with curl's message) instead of dying.
fetch() {
  curl -fsSL --proto '=https' --tlsv1.2 --retry 3 -o "$2" "$1"
}

sha256_of() {
  if have sha256sum; then
    sha256sum "$1" | cut -d ' ' -f 1
  elif have shasum; then
    shasum -a 256 "$1" | cut -d ' ' -f 1
  elif have openssl; then
    openssl dgst -sha256 -r "$1" | cut -d ' ' -f 1
  else
    die "need sha256sum, shasum or openssl to verify the Node download"
  fi
}

# The major version of a node binary, or nothing if it does not run.
node_major() {
  "$1" -e 'process.stdout.write(process.versions.node.split(".")[0])' 2>/dev/null || true
}

node_ok() {
  major=$(node_major "$1")
  [ -n "$major" ] && [ "$major" -ge "$NODE_MAJOR" ] 2>/dev/null
}

node_help() {
  cat >&2 <<EOF

jsh needs Node.js $NODE_MAJOR or later. Install it with one of:
  - the installer from https://nodejs.org/en/download
  - Homebrew:  brew install node@$NODE_MAJOR
  - fnm:       fnm install $NODE_MAJOR
  - nvm:       nvm install $NODE_MAJOR
then run this installer again. Or re-run it in a terminal and let it
download Node $NODE_MAJOR into $(home_form "$JSH_HOME")/node for jsh alone.
EOF
}

# Replace directory $2 with directory $1 (same file system). If the last
# move fails, the old $2 is put back, so a failed upgrade keeps it working.
swap_in() {
  old=
  if [ -e "$2" ]; then
    old="$2.old.$$"
    mv "$2" "$old" || die "could not move $2 aside"
  fi
  if mv "$1" "$2"; then
    if [ -n "$old" ]; then rm -rf "$old"; fi
  else
    if [ -n "$old" ]; then mv "$old" "$2"; fi
    die "could not move the new files into $2"
  fi
}

platform() {
  case $(uname -s) in
    Darwin) os=darwin ;;
    Linux) os=linux ;;
    MINGW* | MSYS* | CYGWIN* | Windows*)
      die "Windows is not supported by this script yet (ai-ecoverse/slicc-jsh#127); use npm i -g $PKG"
      ;;
    *) die "unsupported OS: $(uname -s)" ;;
  esac
  case $(uname -m) in
    x86_64 | amd64) arch=x64 ;;
    arm64 | aarch64) arch=arm64 ;;
    *) die "unsupported CPU: $(uname -m) (nodejs.org builds for x64 and arm64 here)" ;;
  esac
  # An x64 shell under Rosetta on Apple silicon: take the native build.
  if [ "$os" = darwin ] && [ "$arch" = x64 ] &&
    [ "$(sysctl -n sysctl.proc_translated 2>/dev/null || true)" = 1 ]; then
    arch=arm64
  fi
}

is_musl() {
  [ "$os" = linux ] || return 1
  for f in /lib/ld-musl-*; do
    [ -e "$f" ] && return 0
  done
  ldd --version 2>&1 | grep -qi musl
}

# Download the latest Node 22 LTS into $JSH_HOME/node, unless it is already
# there. Sets node_bin.
install_node() {
  platform
  if is_musl; then
    die "nodejs.org has no official Node $NODE_MAJOR build for musl (Alpine); install Node $NODE_MAJOR with your package manager (apk add nodejs) and re-run"
  fi
  fetch "$NODE_DIST/latest-v$NODE_MAJOR.x/SHASUMS256.txt" "$tmp/SHASUMS256.txt" ||
    die "could not download $NODE_DIST/latest-v$NODE_MAJOR.x/SHASUMS256.txt"
  line=$(awk -v want="-$os-$arch.tar.gz" \
    '{ n = length($2) - length(want) } $2 ~ /^node-v[0-9]+\.[0-9]+\.[0-9]+-/ && n > 0 && substr($2, n + 1) == want { print; exit }' \
    "$tmp/SHASUMS256.txt")
  [ -n "$line" ] || die "no Node $NODE_MAJOR build for $os-$arch in $NODE_DIST/latest-v$NODE_MAJOR.x/SHASUMS256.txt"
  sum=${line%% *}
  file=${line##* }
  ver=${file#node-}
  ver=${ver%%-*}
  case $ver in
    v"$NODE_MAJOR".*) ;;
    *) die "unexpected Node build in SHASUMS256.txt: $file" ;;
  esac

  if [ -x "$JSH_HOME/node/bin/node" ] &&
    [ "$("$JSH_HOME/node/bin/node" --version 2>/dev/null || true)" = "$ver" ]; then
    say "Node $ver is up to date in $(home_form "$JSH_HOME")/node"
    node_bin="$JSH_HOME/node/bin/node"
    return
  fi

  say "downloading Node $ver ($os-$arch) from nodejs.org"
  fetch "$NODE_DIST/$ver/$file" "$tmp/$file" || die "could not download $NODE_DIST/$ver/$file"
  got=$(sha256_of "$tmp/$file")
  [ "$got" = "$sum" ] || die "$file: sha256 is $got, SHASUMS256.txt says $sum"
  say "verified $file against SHASUMS256.txt"
  mkdir "$tmp/node"
  tar -xzf "$tmp/$file" -C "$tmp/node" || die "could not unpack $file"
  dir="$tmp/node/${file%.tar.gz}"
  [ -x "$dir/bin/node" ] || die "$file has no bin/node"
  "$dir/bin/node" --version >/dev/null 2>&1 || die "the downloaded Node does not run on this system"
  swap_in "$dir" "$JSH_HOME/node"
  node_bin="$JSH_HOME/node/bin/node"
  say "installed Node $ver in $(home_form "$JSH_HOME")/node"
}

# Pick the Node that jsh runs on. Sets node_bin.
choose_node() {
  if [ -x "$JSH_HOME/node/bin/node" ]; then
    # Agreed to on an earlier run: keep it, on the latest Node 22.
    install_node
    return
  fi
  found=$(command -v node 2>/dev/null || true)
  # A relative PATH entry gives a relative path; the wrapper needs it absolute.
  if [ -n "$found" ]; then found=$(absolute "$found"); fi
  if [ -n "$found" ] && node_ok "$found"; then
    node_bin=$found
    say "using Node $("$found" --version) at $found"
    return
  fi
  if [ -n "$found" ]; then
    say "Node $("$found" --version 2>/dev/null || echo '(unknown version)') at $found is too old; jsh needs Node $NODE_MAJOR or later"
  else
    say "Node.js is not on PATH; jsh needs Node $NODE_MAJOR or later"
  fi
  if ! has_tty; then
    node_help
    die "no terminal to ask on, so Node was not installed"
  fi
  if ask "Download Node $NODE_MAJOR LTS from nodejs.org into $(home_form "$JSH_HOME")/node (for jsh only, no sudo)?"; then
    install_node
  else
    node_help
    die "Node was not installed"
  fi
}

install_jsh() {
  want=${opt_version:-${JSH_VERSION:-latest}}
  want=${want#v}
  fetch "$REGISTRY/$PKG/$want" "$tmp/meta.json" ||
    die "could not get $PKG@$want from $REGISTRY (is $want a published version?)"
  # version, tarball URL and sha512 integrity, one per line.
  "$node_bin" -e '
    const m = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
    const d = m.dist || {};
    const sri = String(d.integrity || "").split(/\s+/).find((s) => s.startsWith("sha512-"));
    if (!m.version || !/^https:\/\//.test(d.tarball || "") || !sri) process.exit(1);
    console.log([m.version, d.tarball, sri].join("\n"));
  ' "$tmp/meta.json" >"$tmp/dist.txt" || die "unexpected registry metadata for $PKG@$want"
  {
    read -r version
    read -r tarball
    read -r integrity
  } <"$tmp/dist.txt"

  say "downloading $PKG@$version"
  fetch "$tarball" "$tmp/jsh.tgz" || die "could not download $tarball"
  "$node_bin" -e '
    const [file, want] = process.argv.slice(1);
    const got = "sha512-" + require("crypto").createHash("sha512")
      .update(require("fs").readFileSync(file)).digest("base64");
    if (got !== want) {
      console.error("jsh: error: tarball integrity is " + got + ", the registry says " + want);
      process.exit(1);
    }
  ' "$tmp/jsh.tgz" "$integrity" || die "the $PKG@$version tarball does not match the registry"
  say "verified the tarball against the registry's sha512"

  mkdir "$tmp/pkg"
  tar -xzf "$tmp/jsh.tgz" -C "$tmp/pkg" || die "could not unpack the $PKG tarball"
  new="$tmp/pkg/package"
  [ -f "$new/dist/host/jsh.mjs" ] || die "the $PKG@$version tarball has no dist/host/jsh.mjs"
  got=$("$node_bin" "$new/dist/host/jsh.mjs" --version 2>&1 || true)
  [ "$got" = "$version" ] || die "the new jsh does not run (jsh --version said: $got)"

  mkdir -p "$JSH_HOME/lib/node_modules/@ai-ecoverse"
  swap_in "$new" "$pkg_dir"
  say "installed $PKG@$version in $(home_form "$pkg_dir")"
}

# Whether directory $1 was created by this script (its marker file says so).
ours() {
  [ -f "$1/.installed-by" ] && [ "$(cat "$1/.installed-by" 2>/dev/null || true)" = "$MARKER" ]
}

# Whether file $1 is a wrapper this script wrote.
our_wrapper() {
  grep -q "^# jsh, written by $MARKER " "$1" 2>/dev/null
}

# Refuse to overwrite a jsh this script did not write.
check_wrapper() {
  wrapper="$JSH_BIN_DIR/jsh"
  if [ -e "$wrapper" ] || [ -L "$wrapper" ]; then
    our_wrapper "$wrapper" ||
      die "$wrapper exists and was not written by this installer; remove it or set JSH_BIN_DIR"
  fi
}

write_wrapper() {
  check_wrapper
  mkdir -p "$JSH_BIN_DIR" || die "could not create $JSH_BIN_DIR"
  next="$JSH_BIN_DIR/.jsh.new.$$"
  cat >"$next" <<EOF
#!/bin/sh
# jsh, written by $MARKER ($INSTALL_URL).
# Re-run it to upgrade; add --uninstall to remove jsh.
node=$(shquote "$node_bin")
if [ ! -x "\$node" ]; then
  echo "jsh: \$node is gone; re-run the installer: curl -fsSL $INSTALL_URL | sh" >&2
  exit 127
fi
exec "\$node" $(shquote "$pkg_dir/dist/host/jsh.mjs") "\$@"
EOF
  chmod 755 "$next"
  mv -f "$next" "$wrapper" || die "could not write $wrapper"
  say "wrote $(home_form "$wrapper")"
}

# The rc file for the user's login shell, and the line that puts
# $JSH_BIN_DIR on PATH in it.
# A plain path is written as "$HOME/…"; anything else is single-quoted.
rc_for_shell() {
  case $JSH_BIN_DIR in
    *[!A-Za-z0-9_./@%+,-]*)
      sh_line="export PATH=$(shquote "$JSH_BIN_DIR")\":\$PATH\""
      fish_line="fish_add_path '$(printf '%s' "$JSH_BIN_DIR" | sed -e 's/\\/\\\\/g' -e "s/'/\\\\'/g")'"
      ;;
    *)
      dir=$(home_form "$JSH_BIN_DIR")
      sh_line="export PATH=\"$dir:\$PATH\""
      fish_line="fish_add_path \"$dir\""
      ;;
  esac
  rc_line=$sh_line
  case $(basename "${SHELL:-sh}") in
    zsh) rc="${ZDOTDIR:-$HOME}/.zshrc" ;;
    bash)
      if [ "$(uname -s)" = Darwin ]; then rc="$HOME/.bash_profile"; else rc="$HOME/.bashrc"; fi
      ;;
    fish)
      rc="${XDG_CONFIG_HOME:-$HOME/.config}/fish/config.fish"
      rc_line=$fish_line
      ;;
    *) rc="$HOME/.profile" ;;
  esac
}

ensure_path() {
  case ":$PATH:" in
    *":$JSH_BIN_DIR:"* | *":$JSH_BIN_DIR/:"*)
      shadow=$(command -v jsh 2>/dev/null || true)
      if [ -n "$shadow" ] && [ "$shadow" != "$JSH_BIN_DIR/jsh" ]; then
        warn "$shadow comes before $(home_form "$JSH_BIN_DIR")/jsh on PATH (an npm install?); remove it or put $(home_form "$JSH_BIN_DIR") first"
      fi
      return
      ;;
  esac
  rc_for_shell
  if [ -f "$rc" ] && grep -qF "$rc_line" "$rc"; then
    say "$(home_form "$rc") already adds $(home_form "$JSH_BIN_DIR") to PATH; open a new shell to use it"
    return
  fi
  say "$(home_form "$JSH_BIN_DIR") is not on PATH"
  if has_tty && ask "Add it to PATH in $(home_form "$rc")?"; then
    mkdir -p "$(dirname "$rc")"
    printf '\n# jsh (%s)\n%s\n' "$MARKER" "$rc_line" >>"$rc"
    say "added to $(home_form "$rc"): $rc_line"
    say "open a new shell, or run that line, to use jsh"
  else
    say "to use jsh, add this line to $(home_form "$rc"):"
    printf '  %s\n' "$rc_line"
  fi
}

uninstall() {
  if [ -e "$JSH_HOME" ]; then
    ours "$JSH_HOME" ||
      die "$JSH_HOME was not created by this installer; not removing it"
    rm -rf "$JSH_HOME"
    say "removed $(home_form "$JSH_HOME")"
  fi
  wrapper="$JSH_BIN_DIR/jsh"
  if [ -e "$wrapper" ]; then
    if our_wrapper "$wrapper"; then
      rm -f "$wrapper"
      say "removed $(home_form "$wrapper")"
    else
      warn "$wrapper was not written by this installer; left alone"
    fi
  fi
  for f in "${ZDOTDIR:-$HOME}/.zshrc" "$HOME/.bashrc" "$HOME/.bash_profile" "$HOME/.profile" \
    "${XDG_CONFIG_HOME:-$HOME/.config}/fish/config.fish"; do
    if [ -f "$f" ] && grep -q "# jsh ($MARKER)" "$f"; then
      say "you can remove these lines from $(home_form "$f"):"
      awk -v m="# jsh ($MARKER)" 'n { print "  " $0; n = 0 } $0 == m { print "  " $0; n = 1 }' "$f"
    fi
  done
  say "jsh is uninstalled"
}

usage() {
  cat <<EOF
Install the host jsh (@ai-ecoverse/slicc-jsh) on macOS or Linux.

  curl -fsSL $INSTALL_URL | sh
  curl -fsSL $INSTALL_URL | sh -s -- [--version X.Y.Z] [--uninstall]

  --version X.Y.Z  install that version (default: \$JSH_VERSION, else the latest)
  --uninstall      remove \$JSH_HOME and the jsh wrapper
  -h, --help       show this help

Environment: JSH_HOME (default ~/.jsh), JSH_BIN_DIR (default ~/.local/bin),
JSH_VERSION.
EOF
}

# On exit: drop the staging dir, and a JSH_HOME this run created but did
# not finish installing into.
cleanup() {
  status=$?
  rm -rf "$tmp"
  if [ "$status" -ne 0 ] && [ -n "$new_home" ]; then rm -rf "$JSH_HOME"; fi
}

main() {
  opt_version=
  opt_uninstall=
  while [ $# -gt 0 ]; do
    case $1 in
      --version)
        [ $# -ge 2 ] || die "--version needs a version, e.g. --version 0.16.1"
        opt_version=$2
        shift 2
        ;;
      --version=*)
        opt_version=${1#--version=}
        shift
        ;;
      --uninstall)
        opt_uninstall=1
        shift
        ;;
      -h | --help)
        usage
        return
        ;;
      *) die "unknown option: $1 (try --help)" ;;
    esac
  done

  [ -n "${HOME:-}" ] || die "HOME is not set"
  JSH_HOME=$(absolute "${JSH_HOME:-$HOME/.jsh}")
  JSH_BIN_DIR=$(absolute "${JSH_BIN_DIR:-$HOME/.local/bin}")
  JSH_BIN_DIR=${JSH_BIN_DIR%/}
  case $JSH_HOME in
    / | "$HOME" | "$HOME/") die "JSH_HOME must be a directory of its own, not $JSH_HOME" ;;
  esac
  pkg_dir="$JSH_HOME/lib/node_modules/$PKG"

  if [ -n "$opt_uninstall" ]; then
    uninstall
    return
  fi

  have curl || die "curl is needed"
  have tar || die "tar is needed"
  check_wrapper

  if [ -e "$JSH_HOME" ] && ! ours "$JSH_HOME" &&
    [ -n "$(ls -A "$JSH_HOME" 2>/dev/null || echo x)" ]; then
    die "$JSH_HOME exists and was not created by this installer; remove it or set JSH_HOME"
  fi
  new_home=
  [ -e "$JSH_HOME" ] || new_home=1
  mkdir -p "$JSH_HOME" || die "could not create $JSH_HOME"
  printf '%s\n' "$MARKER" >"$JSH_HOME/.installed-by"
  # Staging lives in JSH_HOME, so swaps are renames on one file system.
  tmp=$(mktemp -d "$JSH_HOME/.tmp.XXXXXX") || die "could not create a temp dir in $JSH_HOME"
  trap cleanup EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM

  choose_node
  install_jsh
  write_wrapper
  ensure_path

  printf '\n'
  printf '%s --version: %s\n' "$(home_form "$wrapper")" "$("$wrapper" --version)"
  say "run a script with: jsh script.jsh, or ./script.jsh with #!/usr/bin/env jsh"
}

main "$@" </dev/null
