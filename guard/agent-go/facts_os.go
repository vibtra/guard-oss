// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Vibtra

//go:build !guard_test

package main

import "runtime"

func factsOS() string { return runtime.GOOS }
