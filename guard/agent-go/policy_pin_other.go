// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Vibtra

//go:build !darwin && !guard_test

package main

import "path/filepath"

func newPolicyKeyStore(dir string) policyKeyStore {
	return filePinStore{path: filepath.Join(dir, "policy-pin.json"), kind: pinStoreUnprotected}
}

func builtRegistry() (builtIn, error) {
	return builtIn{origin: builtInRegistry, roots: builtInRegistryRoots}, nil
}
