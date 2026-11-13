#!/bin/sh
# Runs in the Debian installer before partitioning. Picks the first disk that isn't on USB (so the install stick
# is never chosen) and tells the partitioner to use it.
for disk in $(list-devices disk); do
  if udevadm info --query=property --name="$disk" 2>/dev/null | grep -q '^ID_BUS=usb'; then
    continue
  fi
  logger -t mediaos "Installing to $disk"
  debconf-set partman-auto/disk "$disk"
  exit 0
done
logger -t mediaos "No internal disk found"
exit 0
