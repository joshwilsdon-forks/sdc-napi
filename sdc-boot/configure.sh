#!/bin/bash
#
# Copyright (c) 2012 Joyent Inc., All rights reserved.
#

export PS4='[\D{%FT%TZ}] ${BASH_SOURCE}:${LINENO}: ${FUNCNAME[0]:+${FUNCNAME[0]}(): }'
set -o xtrace

echo "Importing napi SMF manifest"
/usr/sbin/svccfg import /opt/smartdc/napi/smf/manifests/napi.xml

echo "Enabling napi service"
/usr/sbin/svcadm enable smartdc/site/napi

exit 0
