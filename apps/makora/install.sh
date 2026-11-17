#!/bin/sh
# Installs or updates makora from a GitHub release: checks the tarball's sha256, unpacks it to
# <install dir>/<version>, points <install dir>/current at it and links <bin dir>/makora. Safe to rerun.
#
#   curl -fsSL https://raw.githubusercontent.com/mr-jones123/pi/main/apps/makora/install.sh | sh
#   ... | sh -s -- --version 0.2.0    install that release
#   ... | sh -s -- --uninstall        remove makora; sessions and settings in ~/.makora stay
#
# Environment: MAKORA_REPO (default mr-jones123/pi), MAKORA_INSTALL_DIR (default ~/.makora/app),
# MAKORA_BIN_DIR (default ~/.local/bin, then whatever the last install used).
# Testing aid: MAKORA_RELEASE_BASE replaces https://api.github.com, so tests can serve fake releases.
set -eu

NODE_MIN=22.19.0
PYTHON_MIN=3.11

main() {
  want=""
  action=install
  while [ $# -gt 0 ]; do
    case $1 in
      --version)
        [ $# -ge 2 ] || die "--version needs a version, e.g. --version 0.2.0"
        want=${2#v}
        shift 2
        ;;
      --uninstall) action=uninstall; shift ;;
      -h | --help) usage; return ;;
      *) die "unknown option: $1 (see --help)" ;;
    esac
  done
  [ -n "${HOME:-}" ] || die "HOME is not set"
  # `makora update` passes its install directory with links resolved, as the launcher found it.
  home_real=$(cd "$HOME" 2>/dev/null && pwd -P) || home_real=$HOME
  repo=${MAKORA_REPO:-mr-jones123/pi}
  install_dir=${MAKORA_INSTALL_DIR:-$HOME/.makora/app}
  bin_dir=${MAKORA_BIN_DIR:-}
  if [ -z "$bin_dir" ] && [ -f "$install_dir/bin-dir" ]; then bin_dir=$(cat "$install_dir/bin-dir"); fi
  bin_dir=${bin_dir:-$HOME/.local/bin}
  inside_home "$install_dir"
  inside_home "$bin_dir"
  if [ "$action" = uninstall ]; then uninstall_release; else install_release; fi
}

usage() {
  cat <<EOF
Usage: install.sh [--version X.Y.Z | --uninstall]
Installs makora from the GitHub releases of $repo (tags makora-v*).
  --version X.Y.Z   install that release instead of the latest
  --uninstall       remove makora; sessions and settings in ~/.makora stay
EOF
}

say() { printf '%s\n' "$*"; }

die() {
  printf 'install.sh: %s\n' "$*" >&2
  exit 1
}

inside_home() {
  case $1 in
    */../* | */..) die "$1 must not contain '..'" ;;
    "$HOME"/?* | "$home_real"/?*) ;;
    *) die "$1 is outside your home directory; makora installs only under $HOME" ;;
  esac
}

install_release() {
  preflight
  resolve_release
  installed=""
  if [ -L "$install_dir/current" ]; then installed=$(basename "$(readlink "$install_dir/current")"); fi
  if [ "$installed" = "$version" ] && "$install_dir/$version/bin/makora" --version >/dev/null 2>&1; then
    link_bin
    say "makora $version is already installed (up to date)."
    path_hint
    return
  fi

  tmp=$(mktemp -d "${TMPDIR:-/tmp}/makora-install.XXXXXX")
  stage=""
  trap 'rm -rf "$tmp" ${stage:+"$stage"}' EXIT
  trap 'exit 1' HUP INT TERM
  say "Downloading makora $version"
  fetch "$tarball_url" "$tmp/makora.tar.gz" || die "could not download $tarball_url"
  fetch "$sha_url" "$tmp/makora.tar.gz.sha256" || die "could not download $sha_url"
  read -r expected _ <"$tmp/makora.tar.gz.sha256" || die "empty checksum file $sha_url"
  actual=$(sha256_of "$tmp/makora.tar.gz")
  [ "$expected" = "$actual" ] ||
    die "checksum mismatch for makora-$version.tar.gz (expected $expected, got $actual); nothing was changed"

  # Unpacked next to its final place and renamed into it, so <install dir>/<version> is never half-written.
  mkdir -p "$install_dir"
  stage=$(mktemp -d "$install_dir/.unpack.XXXXXX")
  tar -xzf "$tmp/makora.tar.gz" -C "$stage" || die "could not unpack makora-$version.tar.gz"
  [ -x "$stage/makora-$version/bin/makora" ] || die "makora-$version.tar.gz has no makora-$version/bin/makora"
  new=$install_dir/$version
  rm -rf "$new"
  mv "$stage/makora-$version" "$new"
  if ! "$new/bin/makora" --version >/dev/null; then
    rm -rf "$new"
    [ -z "$installed" ] || die "makora $version did not start (makora --version failed); makora $installed stays installed"
    die "makora $version did not start (makora --version failed)"
  fi
  say "Preparing the Python environment"
  "$new/bin/makora" setup ||
    say "warning: could not prepare the Python environment now; makora builds it when it first runs Python."

  ln -s "$version" "$install_dir/.current.$$"
  # rename(2) replaces the link in one step; `mv` would move the new link into the directory `current` points at.
  node -e 'require("node:fs").renameSync(process.argv[1], process.argv[2])' "$install_dir/.current.$$" "$install_dir/current"
  link_bin
  prune "$version" "$installed"
  if [ -n "$installed" ]; then
    say "makora $installed → $version. Running sessions keep $installed until they restart."
  else
    say "makora $version is installed: $bin_dir/makora"
  fi
  path_hint
}

preflight() {
  missing=""
  if ! command -v node >/dev/null 2>&1; then
    need "Node.js $NODE_MIN or newer" "$(node_hint)"
  elif ! node -e '
    const [have, need] = [process.versions.node, process.argv[1]].map((v) => v.split(".").map(Number));
    const order = have[0] - need[0] || have[1] - need[1] || have[2] - need[2];
    process.exit(order >= 0 ? 0 : 1);' "$NODE_MIN"; then
    need "Node.js $NODE_MIN or newer (found $(node --version))" "$(node_hint)"
  fi
  if ! command -v uv >/dev/null 2>&1 && ! python_ok; then
    need "uv, or Python $PYTHON_MIN or newer" "$(uv_hint)"
  fi
  command -v curl >/dev/null 2>&1 || command -v wget >/dev/null 2>&1 || need "curl or wget" "$(package_hint curl)"
  command -v tar >/dev/null 2>&1 || need "tar" "$(package_hint tar)"
  command -v shasum >/dev/null 2>&1 || command -v sha256sum >/dev/null 2>&1 ||
    need "shasum or sha256sum" "$(package_hint coreutils)"
  if [ -n "$missing" ]; then
    printf 'install.sh: makora needs:\n%s' "$missing" >&2
    exit 1
  fi
}

need() {
  missing="$missing  - $1. Install it with: $2
"
}

python_ok() {
  command -v python3 >/dev/null 2>&1 &&
    python3 -c 'import sys; sys.exit(sys.version_info < tuple(map(int, sys.argv[1].split("."))))' "$PYTHON_MIN"
}

node_hint() {
  if command -v brew >/dev/null 2>&1; then
    echo "brew install node"
  elif command -v apt-get >/dev/null 2>&1; then
    echo "curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt-get install -y nodejs"
  else
    echo "the installer at https://nodejs.org/en/download"
  fi
}

uv_hint() {
  if command -v brew >/dev/null 2>&1; then
    echo "brew install uv"
  else
    echo "curl -LsSf https://astral.sh/uv/install.sh | sh"
  fi
}

package_hint() {
  if command -v brew >/dev/null 2>&1; then
    echo "brew install $1"
  elif command -v apt-get >/dev/null 2>&1; then
    echo "sudo apt-get install -y $1"
  else
    echo "your system's package manager ($1)"
  fi
}

# Sets version, tarball_url and sha_url from the GitHub releases API. The repository also holds upstream pi's tags,
# so only releases tagged makora-v* count.
resolve_release() {
  api=${MAKORA_RELEASE_BASE:-https://api.github.com}/repos/$repo/releases
  if [ -n "$want" ]; then url=$api/tags/makora-v$want; else url="$api?per_page=100"; fi
  json=$(fetch "$url" -) || die "no release ${want:+makora-v$want }found at $url"
  release=$(printf '%s' "$json" | node -e "$PICK_RELEASE" "${want:+tag}") || exit 1
  version=$(printf '%s\n' "$release" | sed -n 1p)
  tarball_url=$(printf '%s\n' "$release" | sed -n 2p)
  sha_url=$(printf '%s\n' "$release" | sed -n 3p)
}

# stdin: the API's release list, or one release when argv[1] is "tag". Prints the version and both asset URLs.
# shellcheck disable=SC2016
PICK_RELEASE='
let text = "";
process.stdin.on("data", (chunk) => (text += chunk));
process.stdin.on("end", () => {
  const data = JSON.parse(text);
  const parts = (r) => r.tag_name.slice("makora-v".length).split(".").map(Number);
  const newer = (a, b) => parts(b)[0] - parts(a)[0] || parts(b)[1] - parts(a)[1] || parts(b)[2] - parts(a)[2];
  const release = process.argv[1] === "tag"
    ? data
    : data
        .filter((r) => /^makora-v\d+\.\d+\.\d+$/.test(r.tag_name) && !r.draft && !r.prerelease)
        .sort(newer)[0];
  if (release === undefined) {
    console.error("install.sh: no makora release (a tag makora-v*) found");
    process.exit(1);
  }
  const version = release.tag_name.slice("makora-v".length);
  if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) {
    console.error(`install.sh: ${release.tag_name} is not a makora release tag`);
    process.exit(1);
  }
  const url = (name) => release.assets.find((asset) => asset.name === name)?.browser_download_url;
  const tarball = url(`makora-${version}.tar.gz`);
  const sha = url(`makora-${version}.tar.gz.sha256`);
  if (tarball === undefined || sha === undefined) {
    console.error(`install.sh: release ${release.tag_name} lacks makora-${version}.tar.gz or its .sha256`);
    process.exit(1);
  }
  console.log([version, tarball, sha].join("\n"));
});
'

# fetch <url> <file>, or <url> - for stdout.
fetch() {
  if command -v curl >/dev/null 2>&1; then
    if [ "$2" = - ]; then curl -fsSL "$1"; else curl -fsSL -o "$2" "$1"; fi
  else
    wget -q -O "$2" "$1"
  fi
}

sha256_of() {
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | cut -d ' ' -f 1
  else
    sha256sum "$1" | cut -d ' ' -f 1
  fi
}

link_bin() {
  mkdir -p "$bin_dir"
  if [ -e "$bin_dir/makora" ] && [ ! -L "$bin_dir/makora" ]; then
    die "$bin_dir/makora exists and is not a link; move it away and rerun"
  fi
  ln -sf "$install_dir/current/bin/makora" "$bin_dir/makora"
  printf '%s\n' "$bin_dir" >"$install_dir/bin-dir"
}

# Keeps the new version and the one it replaced, so a running makora keeps its files; removes older ones.
prune() {
  for entry in "$install_dir"/*; do
    [ -d "$entry" ] && [ ! -L "$entry" ] || continue
    name=$(basename "$entry")
    case $name in [0-9]*) ;; *) continue ;; esac
    [ "$name" = "$1" ] || [ "$name" = "$2" ] || rm -rf "$entry"
  done
}

path_hint() {
  case ":$PATH:" in *":$bin_dir:"*) return ;; esac
  # $HOME stays literal in the printed line, so it can be pasted into a shell profile as is.
  # shellcheck disable=SC2016
  shown='$HOME'/${bin_dir#"$HOME"/}
  case $(basename "${SHELL:-sh}") in
    zsh) profile="$HOME/.zshrc" line="export PATH=\"$shown:\$PATH\"" ;;
    bash)
      if [ "$(uname -s)" = Darwin ]; then profile="$HOME/.bash_profile"; else profile="$HOME/.bashrc"; fi
      line="export PATH=\"$shown:\$PATH\""
      ;;
    fish) profile="$HOME/.config/fish/config.fish" line="fish_add_path $shown" ;;
    *) profile="$HOME/.profile" line="export PATH=\"$shown:\$PATH\"" ;;
  esac
  say ""
  say "$bin_dir is not on your PATH. Add this line to $profile, then open a new terminal:"
  say "  $line"
}

uninstall_release() {
  # The link names the install directory as the install that made it spelled it: maybe with links resolved.
  install_real=$(cd "$install_dir" 2>/dev/null && pwd -P) || install_real=$install_dir
  if [ -L "$bin_dir/makora" ]; then
    case $(readlink "$bin_dir/makora") in "$install_dir"/* | "$install_real"/*) rm -f "$bin_dir/makora" ;; esac
  fi
  data=${MAKORA_HOME:-$HOME/.makora}
  if [ ! -d "$install_dir" ]; then
    say "makora is not installed in $install_dir. Your sessions and settings in $data are untouched."
    return
  fi
  [ -L "$install_dir/current" ] || die "$install_dir has no 'current' link, so it is not a makora install; not removing it"
  rm -rf "$install_dir"
  say "makora is uninstalled. Your sessions, settings and Python environment in $data are kept; delete $data to remove them too."
}

main "$@"
