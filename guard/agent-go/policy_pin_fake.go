// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Vibtra

//go:build guard_test

package main

import (
	"errors"
	"os"
	"path/filepath"
)

type fakePinStore struct{ file filePinStore }

var errFakePinStoreDown = errors.New("the test policy-key store is down")

func newFakePinStore(dir string) policyKeyStore {
	return fakePinStore{filePinStore{path: filepath.Join(dir, "test-policy-pin.json"), kind: pinStoreKeychain}}
}

func (s fakePinStore) down() bool {
	_, e := os.Stat(s.file.path + ".down")
	return e == nil
}

func (s fakePinStore) PinPolicyKey(pin policyPin) error {
	if s.down() {
		return errFakePinStoreDown
	}
	return s.file.PinPolicyKey(pin)
}

func (s fakePinStore) PinnedPolicyKey() (policyPin, error) {
	if s.down() {
		return policyPin{}, errFakePinStoreDown
	}
	return s.file.PinnedPolicyKey()
}

func (s fakePinStore) Kind() string { return s.file.Kind() }
