# Creates the MediaOS test virtual machine for VMware Workstation (UEFI with Secure Boot, 4 GB, 4 CPUs, 32 GB disk)
# with the installer image in its DVD drive. It does not start the VM.
#   powershell -File os\vm\new-vmware-vm.ps1 [-Iso <path>] [-Folder <path>]
param(
  [string]$Iso = (Join-Path $HOME 'MediaOS-images\mediaos-dev-0.1.0.iso'),
  [string]$Folder = (Join-Path $HOME 'MediaOS-images\MediaOS-Test'),
  [string]$Name = 'MediaOS-Test',
  [string]$VMware = 'C:\Program Files (x86)\VMware\VMware Workstation'
)
$ErrorActionPreference = 'Stop'

if (-not (Test-Path -LiteralPath $Iso)) { throw "The installer image isn't there yet: $Iso" }
$vmx = Join-Path $Folder "$Name.vmx"
if (Test-Path -LiteralPath $vmx) { throw "A VM already exists at $vmx. Delete it in VMware first if you want a fresh one." }
New-Item -ItemType Directory -Force -Path $Folder | Out-Null

# 32 GB disk that grows as it fills (-t 0: one growable file).
$disk = Join-Path $Folder "$Name.vmdk"
& (Join-Path $VMware 'vmware-vdiskmanager.exe') -c -s 32GB -a lsilogic -t 0 $disk
if ($LASTEXITCODE -ne 0) { throw "vmware-vdiskmanager failed ($LASTEXITCODE)" }

$lines = @(
  '.encoding = "UTF-8"'
  'config.version = "8"'
  'virtualHW.version = "16"'
  "displayName = `"$Name`""
  'guestOS = "debian10-64"'
  'firmware = "efi"'
  'uefi.secureBoot.enabled = "TRUE"'
  'memsize = "4096"'
  'numvcpus = "4"'
  'cpuid.coresPerSocket = "4"'
  'pciBridge0.present = "TRUE"'
  'pciBridge4.present = "TRUE"'
  'pciBridge4.virtualDev = "pcieRootPort"'
  'pciBridge4.functions = "8"'
  'pciBridge5.present = "TRUE"'
  'pciBridge5.virtualDev = "pcieRootPort"'
  'pciBridge5.functions = "8"'
  'sata0.present = "TRUE"'
  'sata0:0.present = "TRUE"'
  "sata0:0.fileName = `"$Name.vmdk`""
  'sata0:1.present = "TRUE"'
  'sata0:1.deviceType = "cdrom-image"'
  "sata0:1.fileName = `"$Iso`""
  'sata0:1.startConnected = "TRUE"'
  'ethernet0.present = "TRUE"'
  'ethernet0.connectionType = "nat"'
  'ethernet0.virtualDev = "vmxnet3"'
  'ethernet0.addressType = "generated"'
  'usb.present = "TRUE"'
  'ehci.present = "TRUE"'
  'usb_xhci.present = "TRUE"'
  'sound.present = "TRUE"'
  'sound.virtualDev = "hdaudio"'
  'sound.autoDetect = "TRUE"'
  'svga.autodetect = "TRUE"'
  'mks.enable3d = "FALSE"'
  'floppy0.present = "FALSE"'
  'tools.syncTime = "TRUE"'
)
[IO.File]::WriteAllText($vmx, ($lines -join "`r`n") + "`r`n", (New-Object Text.UTF8Encoding($false)))
Write-Output "Created $vmx"
Write-Output "Open it in VMware Workstation and power it on. When asked 'Write the changes to disks?', choose Yes."
