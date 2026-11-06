// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Vibtra

//go:build darwin && !guard_test

package main

import (
	"os"
	"syscall"
)

func exitIfStdioIsSocket() {
	for fd := 0; fd <= 2; fd++ {
		var st syscall.Stat_t
		if syscall.Fstat(fd, &st) == nil && st.Mode&syscall.S_IFMT == syscall.S_IFSOCK {
			os.Exit(2)
		}
	}
}
