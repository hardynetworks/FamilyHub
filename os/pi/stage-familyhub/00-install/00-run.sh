#!/bin/bash -e
# Runs on the build machine: copy the FamilyHub kiosk files into the image.
# (Not /tmp: pi-gen mounts its own /tmp inside the chroot.)
rm -rf "${ROOTFS_DIR}/opt/familyhub-install"
mkdir -p "${ROOTFS_DIR}/opt"
cp -r files/common "${ROOTFS_DIR}/opt/familyhub-install"
install -m 644 files/familyhub.txt "${ROOTFS_DIR}/boot/firmware/familyhub.txt"
