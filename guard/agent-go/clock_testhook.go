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
	if every, e := time.ParseDuration(os.Getenv("VIBTRA_GUARD_TEST_HEALTH_EVERY")); e == nil && every > 0 {
		return every
	}
	return healthEvery
}
