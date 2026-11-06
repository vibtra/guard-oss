#!/bin/zsh
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Vibtra
set -euo pipefail

root=${0:A:h:h:h}
mac=$root/guard/mac
logs=$mac/build/logs
mkdir -p $logs

plain_agent=$root/guard/agent-go/build/vibtra-guard
zsh $root/guard/agent-go/build.sh $plain_agent
GOFLAGS="${GOFLAGS:+$GOFLAGS }-tags=guard_test" zsh $root/guard/agent-go/build.sh $root/guard/agent-go/build/vibtra-guard-test
export VIBTRA_GUARD_AGENT_BIN=$root/guard/agent-go/build/vibtra-guard-test
export TEST_RUNNER_VIBTRA_GUARD_AGENT_BIN=$VIBTRA_GUARD_AGENT_BIN

signer_out=$(mktemp)
node --experimental-strip-types $root/tests/fakes/ca-signer-serve.ts > $signer_out 2> $logs/ca-signer.log &
signer=$!
trap 'kill $signer 2>/dev/null; rm -f $signer_out' EXIT
for _ in {1..100}; do [[ -s $signer_out ]] && break; sleep 0.1; done
[[ -s $signer_out ]] || { cat $logs/ca-signer.log; echo "the fake CA signer did not start" >&2; exit 1; }
export VIBTRA_GUARD_CA_SIGNER_SOCK=$(<$signer_out)
export TEST_RUNNER_VIBTRA_GUARD_CA_SIGNER_SOCK=$VIBTRA_GUARD_CA_SIGNER_SOCK

failed=0
release_tests=(test_release test_sign_guard)
mac_tests=($root/tests/mac/test_*.py(:t:r))
mac_tests=(${mac_tests:|release_tests})
(cd $root/tests/mac && VIBTRA_GUARD_AGENT_BIN=$plain_agent python3 -m unittest -v $release_tests) 2>&1 | tee $logs/mac-release-tests.log || failed=1
(cd $root/tests/mac && python3 -m unittest -v $mac_tests) 2>&1 | tee $logs/mac-cli-tests.log || failed=1
xcodebuild -project $mac/VibtraGuard.xcodeproj -scheme VibtraGuardIntegrationTests -destination 'platform=macOS' \
  SYMROOT=$mac/build OBJROOT=$mac/build/obj test 2>&1 | tee $logs/integration-tests.log || failed=1
TEST_RUNNER_GUARD_EXPECT_TEAM_ID=ZZ9EXAMPLE TEST_RUNNER_GUARD_EXPECT_APP_ID=com.example.guard TEST_RUNNER_GUARD_EXPECT_EXTENSION_ID=com.example.guard.filter \
  xcodebuild -project $mac/VibtraGuard.xcodeproj -scheme VibtraGuardIntegrationTests -destination 'platform=macOS' \
  SYMROOT=$mac/build/identity OBJROOT=$mac/build/identity/obj GUARD_TEAM_ID=ZZ9EXAMPLE GUARD_APP_ID=com.example.guard \
  GUARD_EXTENSION_ID=com.example.guard.filter -only-testing:VibtraGuardIntegrationTests/IdentityIntegrationTests test 2>&1 \
  | tee $logs/identity-tests.log || failed=1
exit $failed
