#!/bin/bash -e
# Runs on the build machine: copy the FamilyHub kiosk files into the image.
rm -rf "${ROOTFS_DIR}/tmp/familyhub"
cp -r files/common "${ROOTFS_DIR}/tmp/familyhub"
install -m 644 files/familyhub.txt "${ROOTFS_DIR}/boot/firmware/familyhub.txt"
