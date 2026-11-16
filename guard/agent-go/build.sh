#!/bin/zsh
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Vibtra
set -euo pipefail
out=${${1:-${0:A:h}/build/vibtra-guard}:a}
cd "${0:A:h}"
mkdir -p "${out:h}"
GOCACHE=${GOCACHE:-/tmp/vibtra-guard-go-cache} GOMODCACHE=${GOMODCACHE:-/tmp/vibtra-guard-go-mod} GOPATH=${GOPATH:-/tmp/vibtra-guard-go} go build -trimpath -o "$out.next" .
mv -f "$out.next" "$out"
if [ "$(uname -s)" = Darwin ]; then
  codesign --force --sign - --identifier vibtra-guard "$out"
fi
