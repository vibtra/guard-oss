// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Vibtra

//go:build darwin && guard_test

package main

import "os"

func newPolicyKeyStore(dir string) policyKeyStore {
	requirement := os.Getenv("VIBTRA_GUARD_TEST_APP_REQUIREMENT")
	if requirement == "" {
		return newFakePinStore(dir)
	}
	return newKeychainPinStore(dir, func() (string, bool, error) { return requirement, false, nil })
}
