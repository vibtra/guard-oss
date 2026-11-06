// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Vibtra
package main

import (
	"crypto"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"strings"
)

type caKey interface {
	crypto.MessageSigner
	Close() error
}

type keyID string

func keyIDOf(spki []byte) keyID {
	hash := sha256.Sum256(spki)
	return keyID(hex.EncodeToString(hash[:]))
}

const (
	reasonUnsignedBuild       = "unsigned-build"
	reasonKeyUnavailable      = "key-unavailable"
	reasonSignerUnavailable   = "signer-unavailable"
	reasonUnsupportedPlatform = "unsupported-platform"
)

type interceptionOff struct {
	reason string
	signer string
	err    error
}

func (e *interceptionOff) Error() string { return e.reason + ": " + e.err.Error() }
func (e *interceptionOff) Unwrap() error { return e.err }

func offReason(e error) string {
	var off *interceptionOff
	if errors.As(e, &off) {
		return off.reason
	}
	return ""
}

func signerState(e error) string {
	var off *interceptionOff
	if errors.As(e, &off) && off.signer != "" {
		return off.signer
	}
	switch offReason(e) {
	case reasonUnsignedBuild:
		return "refused"
	case reasonSignerUnavailable, reasonUnsupportedPlatform:
		return "unavailable"
	}
	return "connected"
}

func reasonWords(reason string) string { return strings.ReplaceAll(reason, "-", " ") }
