#!/bin/bash

# The rpm's %posttrans, which runs last in an upgrade, after the old package's %postun. Releases
# up to 0.1.7 removed /usr/bin/querybara and the AppArmor profile in theirs on every upgrade
# (rpm-after-remove.tpl keeps them now): put them back.
APP='/opt/Querybara/querybara'
[ -x "$APP" ] || exit 0

if [ ! -e /usr/bin/querybara ]; then
    if type update-alternatives >/dev/null 2>&1; then
        update-alternatives --install /usr/bin/querybara querybara "$APP" 100 \
            || ln -sf "$APP" /usr/bin/querybara
    else
        ln -sf "$APP" /usr/bin/querybara
    fi
fi

PROFILE_SOURCE='/opt/Querybara/resources/apparmor-profile'
PROFILE_TARGET='/etc/apparmor.d/querybara'
if [ ! -f "$PROFILE_TARGET" ] && apparmor_status --enabled > /dev/null 2>&1 \
    && apparmor_parser --skip-kernel-load --debug "$PROFILE_SOURCE" > /dev/null 2>&1; then
    cp -f "$PROFILE_SOURCE" "$PROFILE_TARGET"
    if ! { [ -x '/usr/bin/ischroot' ] && /usr/bin/ischroot; } && hash apparmor_parser 2>/dev/null; then
        apparmor_parser --replace --write-cache --skip-read-cache "$PROFILE_TARGET" || true
    fi
fi
exit 0
