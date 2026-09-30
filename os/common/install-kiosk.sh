#!/bin/bash
# FamilyHub OS: turns a fresh Debian / Raspberry Pi OS system into a FamilyHub kiosk screen.
# Runs as root inside the image being built (pi-gen chroot, or the Debian installer's target).
#   usage: install-kiosk.sh pi|x86
set -euo pipefail
PLATFORM="${1:-x86}"
HERE="$(cd "$(dirname "$0")" && pwd)"
export DEBIAN_FRONTEND=noninteractive

echo "==> Installing packages"
apt-get update
apt-get install -y --no-install-recommends \
  cage wlr-randr whiptail curl ca-certificates network-manager unattended-upgrades \
  python3 rfkill iw \
  fonts-dejavu-core fonts-noto-color-emoji dbus-user-session \
  libgl1-mesa-dri libegl-mesa0 libgbm1
apt-get install -y --no-install-recommends chromium || apt-get install -y --no-install-recommends chromium-browser

echo "==> Kiosk user"
if ! id kiosk >/dev/null 2>&1; then
  useradd --create-home --shell /bin/bash --comment "FamilyHub kiosk" kiosk
fi
passwd -l kiosk >/dev/null
for g in video render input audio; do
  getent group "$g" >/dev/null && usermod -aG "$g" kiosk
done

echo "==> FamilyHub files"
cp -r "$HERE/files/." /
chmod 755 /usr/local/bin/familyhub-browser /usr/local/bin/familyhub-setup /usr/local/bin/familyhub-boot \
  /usr/local/bin/familyhub-setupd /usr/local/bin/familyhub-touch-rotate
[ -f /etc/familyhub/kiosk.conf ] || cp /etc/familyhub/kiosk.conf.default /etc/familyhub/kiosk.conf
echo "$PLATFORM" > /etc/familyhub/platform

echo "==> Services"
# The screen sets itself up by touch (familyhub-setupd); the old keyboard first-boot menu stays off.
systemctl enable familyhub-boot.service familyhub-setupd.service familyhub-kiosk.service NetworkManager.service
systemctl disable familyhub-firstboot.service 2>/dev/null || true
systemctl set-default graphical.target

# Let NetworkManager manage every network connection (the Debian installer sets up ifupdown).
if [ -f /etc/network/interfaces ]; then
  printf 'auto lo\niface lo inet loopback\n' > /etc/network/interfaces
fi

# Security updates install themselves.
cat > /etc/apt/apt.conf.d/20auto-upgrades <<'CONF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
CONF

echo "==> Never blank the screen"
if [ "$PLATFORM" = pi ]; then
  CMDLINE=/boot/firmware/cmdline.txt
  [ -f "$CMDLINE" ] || CMDLINE=/boot/cmdline.txt
  if [ -f "$CMDLINE" ] && ! grep -q consoleblank "$CMDLINE"; then
    sed -i '1 s/$/ consoleblank=0/' "$CMDLINE"
  fi
elif [ -f /etc/default/grub ]; then
  sed -i 's/^GRUB_CMDLINE_LINUX_DEFAULT=.*/GRUB_CMDLINE_LINUX_DEFAULT="quiet consoleblank=0"/' /etc/default/grub
  sed -i 's/^GRUB_TIMEOUT=.*/GRUB_TIMEOUT=1/' /etc/default/grub
  update-grub || true
fi

# The admin account (familyhub / familyhub) must choose a new password at its first sign-in.
if id familyhub >/dev/null 2>&1; then
  chage -d 0 familyhub || true
fi

apt-get clean
echo "==> FamilyHub kiosk installed"
