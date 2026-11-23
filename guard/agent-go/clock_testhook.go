// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Vibtra

//go:build guard_test

package main

import (
	"os"
	"strconv"
	"strings"
	"time"
)

func clockSkew() time.Duration {
	b, e := os.ReadFile(os.Getenv("VIBTRA_GUARD_TEST_CLOCK_FILE"))
	if e != nil {
		return 0
	}
	seconds, e := strconv.ParseInt(strings.TrimSpace(string(b)), 10, 64)
	if e != nil {
		return 0
	}
	return time.Duration(seconds) * time.Second
}

func healthResendEvery() time.Duration {
	return testDuration("VIBTRA_GUARD_TEST_HEALTH_EVERY", healthEvery)
}

func graceAfterWake() time.Duration { return testDuration("VIBTRA_GUARD_TEST_WAKE_GRACE", wakeGrace) }

func testDuration(name string, otherwise time.Duration) time.Duration {
	if d, e := time.ParseDuration(os.Getenv(name)); e == nil && d > 0 {
		return d
	}
	return otherwise
}
