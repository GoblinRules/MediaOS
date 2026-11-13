#!/bin/sh
# Adds MediaOS packages to an update server folder and signs it, ready to upload as it is (any static web host).
#   publish-updates.sh <server folder> <mediaos-shell .deb> <mediaos-config .deb>
# Needs apt-ftparchive (apt-utils) and gpg with the signing key; MEDIAOS_UPDATE_SIGNING_KEY names the key (its
# fingerprint), and GNUPGHOME may point at the key's own gpg folder. Boxes trust only the matching public key, which
# the build puts on them (see build-in-container.sh).
# Older versions stay in the folder; boxes pick the newest. To withdraw a bad release, publish a newer one.
# For a GitHub release (release-github.sh) pass a fresh, empty folder, so each release holds just its own version.
set -eu

[ $# -eq 3 ] || { echo "usage: publish-updates.sh <server folder> <mediaos-shell .deb> <mediaos-config .deb>" >&2; exit 2; }
repo=$1
shell_deb=$2
config_deb=$3
key="${MEDIAOS_UPDATE_SIGNING_KEY:?Set MEDIAOS_UPDATE_SIGNING_KEY to the signing key's fingerprint}"

shell_version=$(dpkg-deb -f "$shell_deb" Version)
config_version=$(dpkg-deb -f "$config_deb" Version)
[ "$(dpkg-deb -f "$shell_deb" Package)" = mediaos-shell ] || { echo "$shell_deb isn't mediaos-shell" >&2; exit 1; }
[ "$(dpkg-deb -f "$config_deb" Package)" = mediaos-config ] || { echo "$config_deb isn't mediaos-config" >&2; exit 1; }
# The two are always installed together, so they must be the same version.
[ "$shell_version" = "$config_version" ] || { echo "Versions differ: $shell_version and $config_version" >&2; exit 1; }

mkdir -p "$repo"
for f in "$shell_deb" "$config_deb"; do
  target="$repo/$(basename "$f")"
  if [ -e "$target" ] && ! cmp -s "$f" "$target"; then
    echo "$(basename "$f") is already published with different contents; give the new build a new version" >&2
    exit 1
  fi
  cp "$f" "$target"
done

cd "$repo"
apt-ftparchive packages . > Packages.new
gzip -9nc Packages.new > Packages.gz.new
mv -f Packages.new Packages
mv -f Packages.gz.new Packages.gz
apt-ftparchive -o APT::FTPArchive::Release::Origin=MediaOS -o APT::FTPArchive::Release::Label=MediaOS \
  -o APT::FTPArchive::Release::Suite=stable -o APT::FTPArchive::Release::Codename=stable release . > Release.new
mv -f Release.new Release
gpg --batch --yes --local-user "$key" --clearsign -o InRelease.new Release
mv -f InRelease.new InRelease
echo "Published MediaOS $shell_version in $repo"
