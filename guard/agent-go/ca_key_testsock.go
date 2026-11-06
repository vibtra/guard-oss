// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Vibtra

//go:build guard_test

package main

import "os"

func signerSocketOverride() string { return os.Getenv("VIBTRA_GUARD_CA_SIGNER_SOCK") }
