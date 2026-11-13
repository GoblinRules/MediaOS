#!/bin/sh
# Runs inside the newly installed system at the end of installation (see late.sh).
set -eu
dir=/var/cache/mediaos-install
variant=$(cat "$dir/variant")
export DEBIAN_FRONTEND=noninteractive

# Google Chrome comes from Google's own apt repository, trusted only for that repository. Chrome's installer
# would otherwise add its own copy of the repository line; tell it not to.
install -m 0644 "$dir/google-chrome.gpg" /usr/share/keyrings/google-chrome.gpg
printf '%s\n' 'deb [arch=amd64 signed-by=/usr/share/keyrings/google-chrome.gpg] https://dl.google.com/linux/chrome/deb/ stable main' \
  > /etc/apt/sources.list.d/google-chrome.list
printf '%s\n' 'repo_add_once="false"' 'repo_reenable_on_distupgrade="false"' > /etc/default/google-chrome

# The installer still lists its own disc as a package source at this point (it removes it later); apt-get update
# refuses to run with it, so turn it off now.
for list in /etc/apt/sources.list /etc/apt/sources.list.d/*.list; do
  if [ -f "$list" ]; then sed -i -E 's/^(deb(-src)? +cdrom:)/# \1/' "$list"; fi
done
apt-get update
apt-get install -y "$dir"/mediaos-shell_*.deb "$dir"/mediaos-config_*.deb google-chrome-stable

# The TV user: password locked, in the groups that reach the screen, sound, remotes and Bluetooth.
passwd -l mediaos
for group in audio video render input plugdev netdev bluetooth; do
  if getent group "$group" >/dev/null; then adduser mediaos "$group" >/dev/null; fi
done

# Boot straight in: no boot menu wait, fewer boot messages.
sed -i 's/^GRUB_TIMEOUT=.*/GRUB_TIMEOUT=0/; s/^GRUB_CMDLINE_LINUX_DEFAULT=.*/GRUB_CMDLINE_LINUX_DEFAULT="quiet loglevel=3"/' \
  /etc/default/grub
update-grub

if [ "$variant" = "dev" ]; then
  # Development image only: SSH in as mediaos with the developer's key (no passwords), with sudo.
  install -d -m 0700 -o mediaos -g mediaos /home/mediaos/.ssh
  install -m 0600 -o mediaos -g mediaos "$dir/authorized_keys" /home/mediaos/.ssh/authorized_keys
  printf '%s\n' 'PasswordAuthentication no' 'KbdInteractiveAuthentication no' 'PermitRootLogin no' \
    > /etc/ssh/sshd_config.d/mediaos.conf
  printf '%s\n' 'mediaos ALL=(ALL) NOPASSWD: ALL' > /etc/sudoers.d/mediaos
  chmod 0440 /etc/sudoers.d/mediaos
fi

# Keep the MediaOS packages this box was installed with: the updater reinstalls them if an update fails part way,
# and after an update they become the version Settings can go back to.
install -d -m 0755 /var/lib/mediaos-update /var/lib/mediaos-update/packages /var/lib/mediaos-update/packages/current
install -m 0644 "$dir"/mediaos-shell_*.deb "$dir"/mediaos-config_*.deb /var/lib/mediaos-update/packages/current/

apt-get clean
rm -rf "$dir"
