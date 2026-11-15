// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Vibtra

//go:build !darwin && guard_test

package main

func newPolicyKeyStore(dir string) policyKeyStore { return newFakePinStore(dir) }
