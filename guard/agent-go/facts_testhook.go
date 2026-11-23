// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Vibtra

//go:build guard_test

package main

import (
	"os"
	"runtime"
)

func factsOS() string {
	if goos := os.Getenv("VIBTRA_GUARD_TEST_FACTS_OS"); goos != "" {
		return goos
	}
	return runtime.GOOS
}
