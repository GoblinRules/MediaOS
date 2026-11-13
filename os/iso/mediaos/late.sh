#!/bin/sh
# Runs in the Debian installer at the very end, with the new system mounted at /target. Copies the MediaOS
# packages across and finishes the setup inside the new system (in-target.sh).
set -e
src=/cdrom/mediaos
dest=/target/var/cache/mediaos-install
mkdir -p "$dest"
cp "$src"/*.deb "$src"/google-chrome.gpg "$src"/in-target.sh "$src"/variant "$dest"/
if [ -f "$src"/authorized_keys ]; then
  cp "$src"/authorized_keys "$dest"/
fi
in-target sh /var/cache/mediaos-install/in-target.sh
