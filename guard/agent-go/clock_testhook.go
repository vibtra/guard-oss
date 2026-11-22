// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Vibtra

//go:build guard_test

package main

import (
	"os"
	"time"
)

func healthResendEvery() time.Duration {
	if every, e := time.ParseDuration(os.Getenv("VIBTRA_GUARD_TEST_HEALTH_EVERY")); e == nil && every > 0 {
		return every
	}
	return healthEvery
}
