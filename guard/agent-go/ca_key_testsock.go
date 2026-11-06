// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Vibtra

//go:build guard_test

package main

import (
	"os"
	"runtime"
	"strconv"
	"time"
)

func signerSocketOverride() string { return os.Getenv("VIBTRA_GUARD_CA_SIGNER_SOCK") }
func securityBinary() string {
	if security := os.Getenv("VIBTRA_GUARD_SECURITY_BIN"); security != "" {
		return security
	}
	if runtime.GOOS == "darwin" {
		return "/usr/bin/security"
	}
	return ""
}
func holdWindow() time.Duration {
	if seconds, e := strconv.Atoi(os.Getenv("VIBTRA_GUARD_CA_HOLD_SECONDS")); e == nil && seconds > 0 {
		return time.Duration(seconds) * time.Second
	}
	return caHoldWindow
}
