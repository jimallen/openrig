#!/bin/sh
# Installs herdr-core (hc) from its release TARBALL, checked against the sha256 pinned in a pin file (docker/testbed/hc-pin.env).
#
#   sh install-pinned-hc.sh <pin-file> <install-dir> [<target>]
#
# <target> is linux-x86_64, linux-aarch64 or macos-aarch64 (default: this machine's). Used by docker/testbed/Dockerfile and by the
# package-tests job in .github/workflows/tests.yml. It replaces the downloaded upstream install.sh (OF-254): that script changed
# under a fixed hc version and broke the pin on it. Nothing is fetched but the one tarball, from the version's own path on
# releases.herdr.dev; it is unpacked only after its checksum matches, and nothing is installed unless the binary reports the pinned version.
# Not done here, as install.sh did: the bundled-app install and the codesign check of "Herdr Core.app" (macOS user installs only; the
# 0.1.17 tarballs hold no app bundle), the `?src=install` download-counter mark, and the update/downgrade logic.
# HC_RELEASES_URL replaces the host for tests only (a file:// tree); the pinned checksum still has to match. Nothing that ships sets it
# (Dockerfile, workflow, build verb: pinned by the test). curl is held to https, redirects included; file: is allowed on the first hop only
# when HC_RELEASES_URL is set. A checksum comes from the pin file only: any HC_SHA256_* in the environment is unset before the pin file is read.
set -eu

fail() { printf '%s\n' "hc: $*" >&2; exit 1; }
[ $# -ge 2 ] && [ $# -le 3 ] || fail "usage: install-pinned-hc.sh <pin-file> <install-dir> [<target>]"
pin=$1
dest=$2
releases=${HC_RELEASES_URL:-https://releases.herdr.dev}

[ -r "$pin" ] || fail "cannot read the pin file $pin"
HC_VERSION=
for v in $(env | sed -n 's/^\(HC_SHA256_[A-Za-z0-9_]*\)=.*/\1/p'); do unset "$v"; done
# shellcheck disable=SC1090
. "$pin"
[ -n "$HC_VERSION" ] || fail "$pin names no HC_VERSION"

target=${3:-}
if [ -z "$target" ]; then
  case "$(uname -s)-$(uname -m)" in
    Linux-x86_64 | Linux-amd64) target=linux-x86_64 ;;
    Linux-aarch64 | Linux-arm64) target=linux-aarch64 ;;
    Darwin-arm64 | Darwin-aarch64) target=macos-aarch64 ;;
    *) fail "no pinned build for $(uname -s) $(uname -m)" ;;
  esac
fi

var="HC_SHA256_$(printf '%s' "$target" | tr 'a-z-' 'A-Z_')"
want=$(eval "printf '%s' \"\${$var:-}\"")
[ -n "$want" ] || fail "no pinned checksum for $target in $pin ($var)"
case $want in *[!0-9a-f]* | "") fail "$var in $pin is not a 64-digit sha256" ;; esac
[ ${#want} -eq 64 ] || fail "$var in $pin is not a 64-digit sha256"

sha256() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1
  else shasum -a 256 "$1" | cut -d' ' -f1; fi
}

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
url="$releases/core/$HC_VERSION/herdr-core-$target.tar.gz"
proto='=https'
[ -z "${HC_RELEASES_URL:-}" ] || proto='=https,file'
curl -fsSL --proto "$proto" --proto-redir '=https' "$url" -o "$tmp/hc.tar.gz" || fail "download failed: $url"
got=$(sha256 "$tmp/hc.tar.gz")
[ "$got" = "$want" ] || fail "checksum mismatch for $url: got $got, the pin says $want"
tar -xzf "$tmp/hc.tar.gz" -C "$tmp" herdr-core || fail "the tarball holds no herdr-core"
chmod 755 "$tmp/herdr-core"
reported=$("$tmp/herdr-core" --version 2>/dev/null) || fail "the downloaded herdr-core does not run on this machine"
[ "$reported" = "hc $HC_VERSION" ] || fail "the downloaded herdr-core reports \"$reported\", the pin says $HC_VERSION"

mkdir -p "$dest"
cp "$tmp/herdr-core" "$dest/herdr-core.new"
mv -f "$dest/herdr-core.new" "$dest/herdr-core"
ln -sf herdr-core "$dest/hc"
printf '%s\n' "hc $HC_VERSION installed into $dest/herdr-core ($target, sha256 $want)."
