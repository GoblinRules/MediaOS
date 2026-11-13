#!/bin/sh
# Publishes the packages the last build-remote.sh run made as a GitHub release, which boxes then install from.
#   os/build/release-github.sh [--test] <release notes file>
# --test publishes it as a pre-release instead: boxes ignore it (they follow the latest release), but a test box can be
# pointed at https://github.com/<repo>/releases/download/v<version>/ to try it. Delete it afterwards.
# Run it from this PC (Git Bash) after build-remote.sh, with the work committed and pushed. Needs gh signed in with
# permission to make releases. The build box signs the packages with the update key, which never leaves it
# (MEDIAOS_SIGNING_DIR there, default ~/mediaos-signing, holding gnupg/ and fingerprint).
# Each release is a complete signed apt repository of its own (two .debs, Packages, Packages.gz, Release, InRelease).
# After build-remote.sh release it also carries the installer image and its checksum (never after a dev build).
# It is made as a draft, filled, checked, and only then published as the latest release, so a box never sees half of it.
# The notes are shown on the TV as "What's new": short plain lines and "- " bullets work best.
set -eu

local_env="$(dirname "$0")/local.env"
if [ -f "$local_env" ]; then . "$local_env"; fi

test_release=
if [ "${1:-}" = --test ]; then test_release=1; shift; fi
[ $# -eq 1 ] || { echo "usage: release-github.sh [--test] <release notes file>" >&2; exit 2; }
notes=$1
[ -s "$notes" ] || { echo "The release notes file $notes is missing or empty" >&2; exit 2; }
host="${MEDIAOS_BUILD_HOST:?Set MEDIAOS_BUILD_HOST to the build box (user@host), here or in os/build/local.env}"
gh_repo="${MEDIAOS_GITHUB_REPO:-GoblinRules/MediaOS}"
remote=mediaos-build
repo=$(cd "$(dirname "$0")/../.." && pwd)

version=$(node -p 'require(process.argv[1]).version' "$repo/package.json")
# GitHub renames "+" and "~" in file names, which would break the package list, so keep versions plain.
echo "$version" | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+$' || { echo "Version $version isn't plain x.y.z" >&2; exit 1; }
tag="v$version"

echo "== Checking the work is committed and pushed"
[ -z "$(git -C "$repo" status --porcelain)" ] || { echo "There are uncommitted changes; commit them first" >&2; exit 1; }
git -C "$repo" fetch -q origin
commit=$(git -C "$repo" rev-parse HEAD)
git -C "$repo" merge-base --is-ancestor "$commit" origin/main ||
  { echo "This commit isn't on GitHub's main branch yet; push it first" >&2; exit 1; }
if gh release view "$tag" -R "$gh_repo" >/dev/null 2>&1; then
  echo "Release $tag already exists. Give the new build a new version in package.json." >&2
  exit 1
fi

echo "== Checking the build box has MediaOS $version built from $commit"
info=$(ssh -o BatchMode=yes "$host" "cat ~/$remote/dist/build-info 2>/dev/null" || true)
set -- $info
[ "${1:-}" = "$version" ] && [ "${2:-}" = "$commit" ] ||
  { echo "The last build is '${info:-nothing}', not $version at $commit. Run os/build/build-remote.sh first." >&2; exit 1; }
variant=${3:-}
[ -n "${4:-}" ] || { echo "The last build has no update server, so its boxes couldn't install this release" >&2; exit 1; }

# A release build also attaches its installer image, for new boxes. Only ever the release image: the dev one lets
# the developer's SSH key in.
iso=
if [ "$variant" = release ]; then
  iso_dir="${MEDIAOS_ISO_DIR:-$HOME/MediaOS-images}"
  iso="$iso_dir/mediaos-release-$version.iso"
  [ -s "$iso" ] && [ -s "$iso.sha256" ] || { echo "$iso (and its .sha256) is missing; build-remote.sh copies it there" >&2; exit 1; }
  echo "== Checking the installer image matches the build box's copy"
  remote_sum=$(ssh -o BatchMode=yes "$host" "cut -d' ' -f1 ~/$remote/dist/mediaos-release-$version.iso.sha256")
  local_sum=$(sha256sum "$iso" | cut -d' ' -f1)
  [ -n "$remote_sum" ] && [ "$remote_sum" = "$local_sum" ] ||
    { echo "The local image isn't the one the build box made; run build-remote.sh release again" >&2; exit 1; }
else
  echo "== The last build was '$variant', so no installer image is attached (build-remote.sh release adds one)"
fi

echo "== Signing on the build box"
# The remote side runs under sh -s with the values as arguments, so nothing here is pasted into a remote command line.
ssh -o BatchMode=yes "$host" sh -s -- "$version" <<'REMOTE'
set -eu
version=$1
base=~/mediaos-build
signing=${MEDIAOS_SIGNING_DIR:-$HOME/mediaos-signing}
export GNUPGHOME="$signing/gnupg"
export MEDIAOS_UPDATE_SIGNING_KEY="$(cat "$signing/fingerprint")"
rm -rf "$base/release"
sh "$base/src/os/build/publish-updates.sh" "$base/release" \
  "$base/dist/mediaos-shell_${version}_amd64.deb" "$base/dist/mediaos-config_${version}_all.deb"
# Prove the signature with the public key alone, as a box would.
keyring=$(mktemp)
gpg --batch --yes --dearmor -o "$keyring" "$signing/mediaos-archive.asc"
gpgv --keyring "$keyring" "$base/release/InRelease" 2>/dev/null || { rm -f "$keyring"; echo "The signature didn't verify" >&2; exit 1; }
rm -f "$keyring"
REMOTE

files="mediaos-shell_${version}_amd64.deb mediaos-config_${version}_all.deb Packages Packages.gz Release InRelease"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
for f in $files; do scp -q -o BatchMode=yes "$host:~/$remote/release/$f" "$work/$f"; done

echo "== Uploading $tag as a draft"
gh release create "$tag" -R "$gh_repo" --draft --target "$commit" --title "MediaOS $version" --notes-file "$notes"
(cd "$work" && gh release upload "$tag" -R "$gh_repo" $files)
if [ -n "$iso" ]; then
  echo "== Uploading the installer image (about 900 MB)"
  cp "$iso.sha256" "$work/"
  (cd "$work" && gh release upload "$tag" -R "$gh_repo" "$iso" "$(basename "$iso").sha256")
fi
uploaded=$(gh release view "$tag" -R "$gh_repo" --json assets --jq '.assets[] | "\(.name) \(.size)"' | sort)
expected=$( (cd "$work" && for f in $files; do echo "$f $(wc -c < "$f" | tr -d ' ')"; done
  if [ -n "$iso" ]; then
    echo "$(basename "$iso") $(wc -c < "$iso" | tr -d ' ')"
    echo "$(basename "$iso").sha256 $(wc -c < "$iso.sha256" | tr -d ' ')"
  fi) | sort)
[ "$uploaded" = "$expected" ] ||
  { echo "The uploaded files don't match; the draft $tag is left unpublished for a look" >&2; exit 1; }

if [ -n "$test_release" ]; then
  echo "== Publishing $tag as a test pre-release"
  gh release edit "$tag" -R "$gh_repo" --draft=false --prerelease --latest=false
  echo "Test address: https://github.com/$gh_repo/releases/download/$tag/"
else
  echo "== Publishing $tag as the latest release"
  gh release edit "$tag" -R "$gh_repo" --draft=false --latest
fi
echo "== Done: https://github.com/$gh_repo/releases/tag/$tag"
