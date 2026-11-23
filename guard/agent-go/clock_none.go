// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Vibtra

//go:build !guard_test

package main

import "time"

func clockSkew() time.Duration         { return 0 }
func healthResendEvery() time.Duration { return healthEvery }
func graceAfterWake() time.Duration    { return wakeGrace }
