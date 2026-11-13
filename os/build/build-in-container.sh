#!/bin/sh
# Builds the MediaOS packages and installer image. Runs inside the os/build/Dockerfile container with the source
# tree at /work/src and output going to /work/dist.
#   build-in-container.sh <dev|release>
# The dev image needs the developer's SSH public key at /work/authorized_keys.
set -eu

variant="${1:-dev}"
case "$variant" in dev|release) ;; *) echo "Variant must be dev or release" >&2; exit 2 ;; esac

src=/work/src
dist=/work/dist
cache=/work/cache
stage=$(mktemp -d)
trap 'rm -rf "$stage"' EXIT
mkdir -p "$dist" "$cache"

# Debian's CD signing key (https://www.debian.org/CD/verify) and Google's Linux package signing key.
DEBIAN_CD_KEY=DF9B9C49EAA9298432589D76DA87E80D6294BE9B
GOOGLE_KEY=EB4C1BFD4F042F6DDDCCEC917721F63BD38B4796

cd "$src"
if grep -rlI "$(printf '\r')" os/config-pkg os/iso os/build; then
  echo "The files above have Windows line endings; they must be LF." >&2
  exit 1
fi
version=$(node -p 'require("./package.json").version')
echo "== MediaOS $version ($variant)"

echo "== Installing Node packages and building the shell"
npm ci --no-audit --no-fund
# Electron fetches its Linux binary on first use rather than at install time, so fetch (and checksum) it now.
node node_modules/electron/install.js
[ -x node_modules/electron/dist/electron ] || { echo "The Electron binary didn't download" >&2; exit 1; }
npx electron-vite build

echo "== Packaging mediaos-shell"
root="$stage/shell"
opt="$root/opt/MediaOS"
mkdir -p "$opt" "$root/DEBIAN"
cp -a node_modules/electron/dist/. "$opt/"
mv "$opt/electron" "$opt/mediaos-shell"
rm -f "$opt/resources/default_app.asar"
app="$opt/resources/app"
mkdir -p "$app/node_modules"
cp -a out "$app/"
cp -a node_modules/zod "$app/node_modules/"
node -e '
  const p = require("./package.json")
  const app = { name: p.name, productName: p.productName, version: p.version, main: p.main, desktopName: p.desktopName,
    license: p.license, dependencies: p.dependencies }
  require("fs").writeFileSync(process.argv[1], JSON.stringify(app, null, 2) + "\n")
' "$app/package.json"
chmod -R u+rwX,go+rX,go-w "$opt"
chmod 4755 "$opt/chrome-sandbox"
size=$(du -sk "$root/opt" | cut -f1)
sed -e "s/@VERSION@/$version/g" -e "s/@SIZE@/$size/" os/build/shell-control.in > "$root/DEBIAN/control"
install -m 0755 os/build/shell-postinst "$root/DEBIAN/postinst"
dpkg-deb --root-owner-group --build "$root" "$dist/mediaos-shell_${version}_amd64.deb"

echo "== Packaging mediaos-config"
root="$stage/config"
cp -a os/config-pkg "$root"
find "$root" -type d -exec chmod 0755 {} +
find "$root" -type f -exec chmod 0644 {} +
chmod 0755 "$root/DEBIAN/postinst" "$root/usr/bin/mediaos-ctl" "$root/usr/libexec/mediaos/session" \
  "$root/usr/libexec/mediaos/net-handover" "$root/usr/libexec/mediaos/update"
# The MediaOS update server, only when this build is given one (MEDIAOS_UPDATE_URL and its public signing key at
# /work/update-key.asc). Without them the box says updates aren't set up.
if [ -n "${MEDIAOS_UPDATE_URL:-}" ]; then
  [ -s /work/update-key.asc ] || { echo "MEDIAOS_UPDATE_URL needs the server's public key at /work/update-key.asc" >&2; exit 1; }
  gpg --batch --show-keys /work/update-key.asc >/dev/null || { echo "/work/update-key.asc isn't a public key" >&2; exit 1; }
  mkdir -p "$root/usr/share/keyrings" "$root/etc/apt/sources.list.d"
  install -m 0644 /work/update-key.asc "$root/usr/share/keyrings/mediaos-archive.asc"
  printf 'Types: deb\nURIs: %s\nSuites: ./\nSigned-By: /usr/share/keyrings/mediaos-archive.asc\n' "$MEDIAOS_UPDATE_URL" \
    > "$root/etc/apt/sources.list.d/mediaos.sources"
  echo "Update server: $MEDIAOS_UPDATE_URL"
else
  echo "No update server given (MEDIAOS_UPDATE_URL): this build can't update itself"
fi
sed -i "s/@VERSION@/$version/g" "$root/DEBIAN/control"
dpkg-deb --root-owner-group --build "$root" "$dist/mediaos-config_${version}_all.deb"

echo "== Downloading and checking the Debian installer"
base=https://cdimage.debian.org/debian-cd/current/amd64/iso-cd
curl -fsSL -o "$cache/SHA512SUMS" "$base/SHA512SUMS"
curl -fsSL -o "$cache/SHA512SUMS.sign" "$base/SHA512SUMS.sign"
export GNUPGHOME="$stage/gnupg"
mkdir -m 0700 "$GNUPGHOME"
gpg --batch --quiet --keyserver hkps://keyring.debian.org --recv-keys "$DEBIAN_CD_KEY" ||
  gpg --batch --quiet --keyserver hkps://keyserver.ubuntu.com --recv-keys "$DEBIAN_CD_KEY"
gpg --batch --export "$DEBIAN_CD_KEY" > "$stage/debian-cd.gpg"
gpgv --keyring "$stage/debian-cd.gpg" "$cache/SHA512SUMS.sign" "$cache/SHA512SUMS"
netinst=$(awk '/debian-[0-9.]+-amd64-netinst\.iso$/ { print $2; exit }' "$cache/SHA512SUMS")
[ -n "$netinst" ] || { echo "No netinst image listed in SHA512SUMS" >&2; exit 1; }
if ! (cd "$cache" && grep " $netinst\$" SHA512SUMS | sha512sum -c --quiet 2>/dev/null); then
  curl -fL -o "$cache/$netinst" "$base/$netinst"
  (cd "$cache" && grep " $netinst\$" SHA512SUMS | sha512sum -c --quiet)
fi
echo "Using $netinst (checksum and signature verified)"

echo "== Fetching Google's Chrome signing key"
curl -fsSL -o "$stage/google.asc" https://dl.google.com/linux/linux_signing_key.pub
if ! gpg --batch --show-keys --with-colons "$stage/google.asc" | grep -q "^fpr:::::::::$GOOGLE_KEY:"; then
  echo "Google's signing key didn't match the expected fingerprint" >&2
  exit 1
fi

echo "== Building the installer image"
iso="$stage/iso"
mkdir -p "$iso/mediaos"
cp "$dist/mediaos-shell_${version}_amd64.deb" "$dist/mediaos-config_${version}_all.deb" "$iso/mediaos/"
cp os/iso/mediaos/late.sh os/iso/mediaos/in-target.sh os/iso/mediaos/pick-disk.sh "$iso/mediaos/"
gpg --batch --dearmor < "$stage/google.asc" > "$iso/mediaos/google-chrome.gpg"
printf '%s\n' "$variant" > "$iso/mediaos/variant"
packages="ca-certificates sudo"
if [ "$variant" = "dev" ]; then
  [ -s /work/authorized_keys ] || { echo "The dev image needs /work/authorized_keys" >&2; exit 1; }
  cp /work/authorized_keys "$iso/mediaos/authorized_keys"
  packages="$packages openssh-server"
fi
# The TV user gets a random password that is locked straight after install.
hash=$(openssl passwd -6 "$(openssl rand -hex 24)")
sed -e "s|@VARIANT@|$variant|" -e "s|@PACKAGES@|$packages|" -e "s|@PASSWORD_HASH@|$hash|" os/iso/preseed.cfg.in \
  > "$iso/preseed.cfg"
out="$dist/mediaos-$variant-$version.iso"
rm -f "$out"
xorriso -indev "$cache/$netinst" -outdev "$out" \
  -map "$iso/preseed.cfg" /preseed.cfg \
  -map "$iso/mediaos" /mediaos \
  -map os/iso/grub.cfg /boot/grub/grub.cfg \
  -boot_image any replay
(cd "$dist" && sha256sum "$(basename "$out")" > "$(basename "$out").sha256")
echo "== Done: $out"
