#!/bin/sh
# Builds the MediaOS installer image on a Linux build box with Docker, from this PC (Git Bash).
#   os/build/build-remote.sh [dev|release]
# Settings (environment, or os/build/local.env, which git ignores): MEDIAOS_BUILD_HOST (user@host, required),
# MEDIAOS_ISO_DIR (where the image is copied back to; default ~/MediaOS-images), MEDIAOS_SSH_KEY (public key for the dev image),
# MEDIAOS_UPDATE_URL and MEDIAOS_UPDATE_KEY (the update server and its public signing key, .asc). They default to this
# repository's GitHub releases and os/build/mediaos-archive.asc; set MEDIAOS_UPDATE_URL=none for a box that can't
# update itself.
set -eu

local_env="$(dirname "$0")/local.env"
if [ -f "$local_env" ]; then . "$local_env"; fi

variant="${1:-dev}"
host="${MEDIAOS_BUILD_HOST:?Set MEDIAOS_BUILD_HOST to the build box (user@host), here or in os/build/local.env}"
iso_dir="${MEDIAOS_ISO_DIR:-$HOME/MediaOS-images}"
key="${MEDIAOS_SSH_KEY:-$HOME/.ssh/id_rsa.pub}"
remote=mediaos-build
update_url="${MEDIAOS_UPDATE_URL:-https://github.com/GoblinRules/MediaOS/releases/latest/download/}"
update_key="${MEDIAOS_UPDATE_KEY:-$(dirname "$0")/mediaos-archive.asc}"
if [ "$update_url" = none ]; then update_url=; fi
if [ -n "$update_url" ]; then
  echo "$update_url" | grep -qE '^https?://[A-Za-z0-9.:_~/-]+$' || { echo "MEDIAOS_UPDATE_URL isn't a plain http(s) address" >&2; exit 2; }
  [ -s "$update_key" ] || { echo "MEDIAOS_UPDATE_URL needs MEDIAOS_UPDATE_KEY (the server's public key, .asc)" >&2; exit 2; }
fi
repo=$(cd "$(dirname "$0")/../.." && pwd)
# Which commit these packages come from, for release-github.sh ("-dirty" when the tree had uncommitted changes).
commit=$(git -C "$repo" rev-parse HEAD 2>/dev/null || echo unknown)
if [ -n "$(git -C "$repo" status --porcelain 2>/dev/null)" ]; then commit="$commit-dirty"; fi

echo "== Copying the source to $host:~/$remote"
ssh -o BatchMode=yes "$host" "mkdir -p ~/$remote/dist ~/$remote/cache && rm -rf ~/$remote/src && mkdir ~/$remote/src"
tar -C "$repo" --exclude=./node_modules --exclude=./out --exclude=./.git --exclude=./.screens --exclude=./.reviews \
  --exclude=./test-results --exclude=./playwright-report -czf - . \
  | ssh -o BatchMode=yes "$host" "tar -xzf - -C ~/$remote/src"
if [ "$variant" = "dev" ]; then
  ssh -o BatchMode=yes "$host" "cat > ~/$remote/authorized_keys" < "$key"
fi
if [ -n "$update_url" ]; then
  ssh -o BatchMode=yes "$host" "cat > ~/$remote/update-key.asc" < "$update_key"
else
  ssh -o BatchMode=yes "$host" "rm -f ~/$remote/update-key.asc"
fi

echo "== Building on $host"
ssh -o BatchMode=yes "$host" "cd ~/$remote && docker build -q -t mediaos-build src/os/build >/dev/null && \
  docker run --rm -v \"\$PWD:/work\" -v mediaos-npm-cache:/root/.npm -v mediaos-electron-cache:/root/.cache \
    -e HOST_UID=\$(id -u) -e HOST_GID=\$(id -g) -e MEDIAOS_UPDATE_URL='$update_url' mediaos-build \
    sh -c 'sh /work/src/os/build/build-in-container.sh $variant; status=\$?; chown -R \$HOST_UID:\$HOST_GID /work; exit \$status'"

version=$(node -p 'require(process.argv[1]).version' "$repo/package.json")
# The update address goes last: it can be empty.
ssh -o BatchMode=yes "$host" "printf '%s %s %s %s\n' '$version' '$commit' '$variant' '$update_url' > ~/$remote/dist/build-info"
name="mediaos-$variant-$version.iso"
echo "== Copying $name to $iso_dir"
mkdir -p "$iso_dir"
# Copy under a temporary name and swap it in only once it's checked, so a VM that has the old image in its DVD drive
# never reads a half-written file (Windows refuses the final rename while VMware has the old one open).
scp -o BatchMode=yes "$host:~/$remote/dist/$name" "$iso_dir/$name.part"
scp -o BatchMode=yes "$host:~/$remote/dist/$name.sha256" "$iso_dir/$name.sha256.part"
expected=$(cut -d' ' -f1 < "$iso_dir/$name.sha256.part")
actual=$(sha256sum "$iso_dir/$name.part" | cut -d' ' -f1)
[ "$expected" = "$actual" ] || { echo "The copied image is damaged (checksum mismatch)" >&2; exit 1; }
if ! mv -f "$iso_dir/$name.part" "$iso_dir/$name"; then
  echo "Couldn't replace $name; power off any VM that has it in its DVD drive, then run this again." >&2
  exit 1
fi
mv -f "$iso_dir/$name.sha256.part" "$iso_dir/$name.sha256"
echo "Image checksum OK"
echo "== Done: $iso_dir/$name"
