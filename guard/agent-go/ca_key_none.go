// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Vibtra

//go:build !darwin && !guard_test

package main

import (
	"crypto"
	"crypto/ecdsa"
	"crypto/x509"
	"errors"
	"io"
	"time"
)

const noSignerReason = reasonUnsupportedPlatform

var errInterceptionUnsupported = &interceptionOff{reason: reasonUnsupportedPlatform, err: errors.New("interception needs macOS and the Guard app's signer")}

type unsupportedKey struct{ pub *ecdsa.PublicKey }

func openAppSigner(_ keyID, want *ecdsa.PublicKey) caKey { return unsupportedKey{want} }

func (k unsupportedKey) Public() crypto.PublicKey { return k.pub }
func (unsupportedKey) Sign(io.Reader, []byte, crypto.SignerOpts) ([]byte, error) {
	return nil, errInterceptionUnsupported
}
func (unsupportedKey) SignMessage(io.Reader, []byte, crypto.SignerOpts) ([]byte, error) {
	return nil, errInterceptionUnsupported
}
func (unsupportedKey) Close() error { return nil }

func platformBlocked() error { return errInterceptionUnsupported }

func createAppSignerCA(*x509.Certificate) (keyID, *x509.Certificate, error) {
	return "", nil, errInterceptionUnsupported
}
func appSignerPub(keyID) (*ecdsa.PublicKey, error) { return nil, errInterceptionUnsupported }
func pruneAppSignerKeys(string, ...keyID) error    { return errInterceptionUnsupported }
func securityBinary() string                       { return "" }
func holdWindow() time.Duration                    { return caHoldWindow }
