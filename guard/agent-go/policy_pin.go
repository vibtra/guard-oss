// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Vibtra
package main

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/x509"
	"encoding/json"
	"encoding/pem"
	"errors"
	"os"
	"time"
)

const (
	pinSourceEnrolment         = "enrolment"
	pinSourceFirstUse          = "first-use"
	pinStoreKeychain           = "keychain"
	pinStoreUnprotected        = "unprotected"
	reasonPolicyKeyMismatch    = "policy-key-mismatch"
	reasonPolicyKeyUnavailable = "policy-key-unavailable"
	pinRetryAfter              = 15 * time.Second
	maxPinBytes                = 4096
)

var errNoPin = errors.New("no policy-signing key is pinned")

type policyPin struct {
	DeviceID string     `json:"deviceId"`
	OrgID    string     `json:"orgId"`
	Signing  SigningKey `json:"signing"`
	Source   string     `json:"source"`
	PinnedAt string     `json:"pinnedAt"`
}

type policyKeyStore interface {
	PinPolicyKey(pin policyPin) error
	PinnedPolicyKey() (policyPin, error)
	ClearPin() error
	Kind() string
}

func pinFor(d Device, source string) (policyPin, error) {
	p := policyPin{DeviceID: d.DeviceID, OrgID: d.OrgID, Signing: d.Signing, Source: source, PinnedAt: nowISO()}
	return p, p.validate()
}

func (p policyPin) validate() error {
	if p.DeviceID == "" || p.OrgID == "" || p.Signing.KeyID == "" || p.Signing.Alg != "ES256" || p.Source != pinSourceEnrolment && p.Source != pinSourceFirstUse {
		return errors.New("the policy-signing key is incomplete")
	}
	block, _ := pem.Decode([]byte(p.Signing.PublicKeyPEM))
	if block == nil {
		return errors.New("the policy-signing key is not PEM")
	}
	key, e := x509.ParsePKIXPublicKey(block.Bytes)
	if e != nil {
		return e
	}
	if pub, ok := key.(*ecdsa.PublicKey); !ok || pub.Curve != elliptic.P256() {
		return errors.New("the policy-signing key is not P-256")
	}
	return nil
}

func (p policyPin) matches(d Device) bool {
	return p.DeviceID == d.DeviceID && p.OrgID == d.OrgID && p.Signing == d.Signing
}

func (p policyPin) sameKey(q policyPin) bool {
	return p.DeviceID == q.DeviceID && p.OrgID == q.OrgID && p.Signing == q.Signing
}

func (p policyPin) identity() Device {
	return Device{DeviceID: p.DeviceID, OrgID: p.OrgID, Signing: p.Signing}
}

func decodePin(raw []byte) (policyPin, error) {
	var p policyPin
	if len(raw) > maxPinBytes {
		return p, errors.New("the pinned policy-signing key is too large")
	}
	if e := json.Unmarshal(raw, &p); e != nil {
		return p, e
	}
	return p, p.validate()
}

func resolvePin(store policyKeyStore, d Device) (*policyPin, error) {
	pin, e := store.PinnedPolicyKey()
	if errors.Is(e, errNoPin) {
		if d.Revoked {
			return nil, errNoPin
		}
		if pin, e = pinFor(d, pinSourceFirstUse); e != nil {
			return nil, errNoPin
		}
		e = store.PinPolicyKey(pin)
	}
	if e != nil {
		return nil, e
	}
	return &pin, nil
}

func (a *Agent) policyAnchor(d Device) *policyPin {
	a.mu.RLock()
	held, retry, unavailable := a.pin, a.pinRetry, a.pinReason == reasonPolicyKeyUnavailable
	a.mu.RUnlock()
	if held != nil && held.matches(d) {
		unavailable, retry = false, time.Time{}
	} else if time.Now().After(retry) {
		pin, e := resolvePin(a.pins, d)
		unavailable = e != nil && !errors.Is(e, errNoPin)
		if e == nil {
			held = pin
		}
		retry = time.Time{}
		if held == nil || !held.matches(d) {
			retry = time.Now().Add(pinRetryAfter)
		}
	}
	reason := ""
	switch {
	case unavailable:
		reason = reasonPolicyKeyUnavailable
	case held != nil && !held.matches(d):
		reason = reasonPolicyKeyMismatch
	}
	a.mu.Lock()
	a.pin, a.pinRetry, a.pinReason = held, retry, reason
	a.mu.Unlock()
	return held
}

func (a *Agent) holdPin(pin policyPin) {
	a.mu.Lock()
	a.pin, a.pinRetry, a.pinReason = &pin, time.Time{}, ""
	a.mu.Unlock()
}

func (a *Agent) policyKeyHealthLocked(kind string) map[string]any {
	out := map[string]any{"store": kind}
	if a.pin != nil {
		out["pinned"] = a.pin.Source
	}
	if a.pinReason != "" {
		out["reason"] = a.pinReason
	}
	return out
}

func (a *Agent) policyKeyHealth() map[string]any {
	kind := a.pins.Kind()
	a.mu.RLock()
	defer a.mu.RUnlock()
	return a.policyKeyHealthLocked(kind)
}

type filePinStore struct {
	path string
	kind string
}

func (s filePinStore) PinPolicyKey(pin policyPin) error {
	if e := pin.validate(); e != nil {
		return e
	}
	return writeJSON(s.path, pin)
}

func (s filePinStore) PinnedPolicyKey() (policyPin, error) {
	raw, e := os.ReadFile(s.path)
	if errors.Is(e, os.ErrNotExist) {
		return policyPin{}, errNoPin
	}
	if e != nil {
		return policyPin{}, e
	}
	return decodePin(raw)
}

func (s filePinStore) ClearPin() error {
	if e := os.Remove(s.path); e != nil && !errors.Is(e, os.ErrNotExist) {
		return e
	}
	return nil
}

func (s filePinStore) Kind() string { return s.kind }
