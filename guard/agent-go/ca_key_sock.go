// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Vibtra

//go:build darwin && !guard_test

package main

import "time"

func signerSocketOverride() string { return "" }
func securityBinary() string       { return "/usr/bin/security" }
func holdWindow() time.Duration    { return caHoldWindow }
