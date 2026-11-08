// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Vibtra

//go:build guard_test

package main

import "os"

func crashPoint(name string) {
	if os.Getenv("VIBTRA_GUARD_TEST_CRASH_AT") == name {
		os.Exit(86)
	}
}
