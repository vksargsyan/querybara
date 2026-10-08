#!/bin/bash

# electron-builder's after-remove, which fpm makes the rpm's %postun, kept only for an erase.
# rpm runs the old package's %postun after the new package's %post: on an upgrade, $1 is the
# number of versions left installed (1), and removing the link here would delete the one the
# new version just made.
if [ "$1" -ge 1 ] 2>/dev/null; then
    exit 0
fi

if type update-alternatives >/dev/null 2>&1; then
    update-alternatives --remove '${executable}' '/opt/${sanitizedProductName}/${executable}'
else
    rm -f '/usr/bin/${executable}'
fi

APPARMOR_PROFILE_DEST='/etc/apparmor.d/${executable}'

# Remove and unload the AppArmor profile (not in a chroot, where live operations mean nothing).
if [ -f "$APPARMOR_PROFILE_DEST" ]; then
  if apparmor_status --enabled > /dev/null 2>&1; then
    if ! { [ -x '/usr/bin/ischroot' ] && /usr/bin/ischroot; } && hash apparmor_parser 2>/dev/null; then
      apparmor_parser --remove "$APPARMOR_PROFILE_DEST" || true
    fi
  fi
  rm -f "$APPARMOR_PROFILE_DEST"
fi
