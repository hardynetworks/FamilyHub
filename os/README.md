# FamilyHub OS: kiosk screens

FamilyHub OS turns a Raspberry Pi or an x86 PC into a dedicated FamilyHub wall screen. The device boots straight into FamilyHub, full screen, and connects to **your existing FamilyHub server**. For Windows PCs there's a kiosk setup instead of an image.

| Download | For | How to install |
|---|---|---|
| `FamilyHubOS-RaspberryPi-arm64.img.xz` | Raspberry Pi 4 or 5 (3B+ and Zero 2 W work, but slowly) | Flash to a microSD card |
| `FamilyHubOS-x86_64.iso` | Mini PCs, NUCs, old laptops (64-bit, UEFI or BIOS) | Flash to a USB stick, boot it, and it installs to the disk |
| `FamilyHub-Kiosk-Windows.zip` | An existing Windows 10/11 PC | Unzip and run `Install.cmd` |

Get them from the repository's **Releases** page. Or, in the **Actions** tab, run **FamilyHub OS images**; when it's done, the downloads are on the run's page.

The screen pairs with FamilyHub the same way as any kiosk screen. A head of household opens **Settings → App settings → Kiosk screens → Add a screen** to get a pairing code; see the main [README](../README.md#kiosk-screens-wall-tablets-raspberry-pi).

> **The screen must be able to reach your FamilyHub address.** If FamilyHub is only reachable over a VPN, use an address that works on your home network. The screen doesn't run a VPN client (yet).

---

## Raspberry Pi

1. Flash `FamilyHubOS-RaspberryPi-arm64.img.xz` to a microSD card (8 GB or more) with [Raspberry Pi Imager](https://www.raspberrypi.com/software/) (**Choose OS → Use custom**, and **don't** apply OS customisation) or [balenaEtcher](https://etcher.balena.io/).
2. Put the card in the Pi, connect the screen, and power it on.
3. After a minute or two the **on-screen setup** appears. With a touch screen, just tap; an on-screen keyboard pops up when you need to type. (A mouse and keyboard work too.)
   1. **Rotation:** pick the way the screen is mounted. It turns, and you tap **Keep** (if you don't, it turns back after 45 seconds).
   2. **Network:** choose your Wi-Fi and type the password, or plug in a network cable.
   3. **FamilyHub address:** type it and tap **Check address**.
   4. **Pairing code:** from **Settings → App settings → Kiosk screens → Add a screen** on your phone. You can skip this and type it on the next screen instead.
   5. Tap **Start FamilyHub**. The time zone comes from your FamilyHub.

### Optional: set it up from your PC instead

Before you take the card out of your PC, open the **bootfs** drive that appears and edit **`familyhub.txt`**:

- `FAMILYHUB_URL`: your FamilyHub address
- `WIFI_SSID`, `WIFI_PASSWORD`, `WIFI_COUNTRY`: skip these if you use a network cable
- `PAIRING_CODE`: lets the screen pair itself. The code works for 30 minutes.
- `ROTATE`: turns the picture for portrait screens

The Wi-Fi password and pairing code are wiped from the card once they've been used. The screen then starts straight into FamilyHub, with no on-screen setup.

## x86 PCs (USB installer)

> ⚠️ Installing **erases the whole disk** of the PC.

1. Flash `FamilyHubOS-x86_64.iso` to a USB stick (2 GB or more) with [balenaEtcher](https://etcher.balena.io/) or [Rufus](https://rufus.ie/) (choose "DD image" mode if Rufus asks).
2. **Plug the PC into your network with a cable.** The installer downloads the latest packages; Wi-Fi can be set up afterwards.
3. Boot the PC from the USB stick. The boot menu key is often F12, F11, F8 or Esc. Choose **Install FamilyHub OS**, or wait 10 seconds.
4. The install runs by itself. It asks only one question, **"Write the changes to disks?"**: choose **Yes** to erase the disk and install. It takes 5–15 minutes, then the PC restarts. Remove the USB stick.
5. On the first start, the on-screen setup asks for the screen rotation, Wi-Fi if needed, your FamilyHub address and an optional pairing code, the same as on the Pi. With a touch screen, an on-screen keyboard appears for typing. The time zone is set from your FamilyHub automatically.

## Windows PCs

Windows can't be replaced with an image, so this sets up an existing Windows PC as a kiosk instead:

1. Unzip `FamilyHub-Kiosk-Windows.zip` and double-click **`Install.cmd`**. If Windows SmartScreen warns you, choose **More info → Run anyway**.
2. Enter your FamilyHub address. FamilyHub opens full screen in Microsoft Edge. Enter the pairing code.
3. From then on, FamilyHub opens by itself whenever that Windows account signs in. It has its own Edge profile, so it stays paired. The screen is kept awake, and if Edge is closed it opens again.

- **To close it for now:** Start menu → **Stop FamilyHub Kiosk**. It comes back at the next sign-in.
- **To remove it:** run **`Uninstall.cmd`**.
- **For a true wall screen:**
  - Use a Windows account just for the screen, and turn on automatic sign-in (for example with Microsoft's free [Autologon](https://learn.microsoft.com/sysinternals/downloads/autologon) tool).
  - For a full lockdown, Windows Pro can use **Assigned Access** (Settings → Accounts → Other users → Set up a kiosk).

---

## Changing settings later (Pi and x86)

On the screen, tap the lock button, enter the kiosk PIN, and choose **Screen settings (Wi-Fi, address, rotation)**. If the screen can't reach FamilyHub, a **Screen settings** button also appears on the "Waiting for the network" page.

Screen settings lets you change:

- the network (Wi-Fi)
- the FamilyHub address
- the pairing (pair the screen again with a new code)
- the screen rotation
- the time zone

It can also restart the device. Tap **Back to FamilyHub** when you're done.

### Touch lands in the wrong place after rotating?

FamilyHub OS turns the touch input along with the picture. If your touch panel is mounted differently from the display, set **`TOUCH_ROTATE`** in `familyhub.txt` (Pi) or in the keyboard menu below to `normal`, `90`, `180` or `270`.

### With a keyboard

Connect a keyboard and press **Ctrl+Alt+F2**, then sign in as **`familyhub`**. The first-time password is `familyhub`, and you'll be asked to choose a new one. Then run:

```bash
sudo familyhub-setup
```

This menu has the same settings, plus **Touch rotation**, the admin password and resetting the screen's sign-in. Press **Ctrl+Alt+F1** to go back to the kiosk.

## What's inside

- **Base system:**
  - Raspberry Pi OS Lite (64-bit), built with [pi-gen](https://github.com/RPi-Distro/pi-gen).
  - Debian's network installer with an automatic install file, for x86.
- **Display:** [cage](https://github.com/cage-kiosk/cage), a minimal Wayland kiosk display server, runs Chromium full screen as a locked-down `kiosk` user.
  - It opens a small local start page (`/usr/share/familyhub/start.html`) that waits for the network, then opens `<your FamilyHub>/kiosk`, or the on-screen setup if there's no address yet.
  - Chromium is reopened if it ever closes.
- **Services:**
  - `familyhub-boot` applies `familyhub.txt` on the Pi.
  - `familyhub-setupd` serves the on-screen setup at `http://127.0.0.1:8099` (Python, localhost only) and applies Wi-Fi, address, pairing code, rotation and time zone.
  - `familyhub-kiosk` runs the kiosk itself.
  - Settings live in `/etc/familyhub/kiosk.conf`.
- **Network:** NetworkManager handles all connections. SSH is off.
- **Upkeep:**
  - Security updates install automatically (unattended-upgrades).
  - The screen never blanks (`consoleblank=0`, and there's no idle timeout in cage).
- **Source:**
  - `os/common` has everything shared.
  - `os/pi`, `os/x86` and `os/windows` have the per-platform parts.
  - `.github/workflows/os-images.yml` builds all three.

## To-do

- **All-in-one image:** a first-boot choice to also run the FamilyHub server (Docker) on the device, for families without a separate server.
- Read-only system mode, so a power cut can never damage the SD card.
- Screen off (or dimmed) at night on a schedule, waking for the doorbell.
- An optional NetBird / Tailscale client, for FamilyHub servers that are only reachable over a VPN.
